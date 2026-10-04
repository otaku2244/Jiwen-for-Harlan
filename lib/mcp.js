'use strict';
// MCP 服务（Streamable HTTP，JSON-RPC 2.0）
//
// 定位：让 Operit 的工作流能**主动来拉**积温的主动唤醒通知。
//
// 为什么必须是"拉"而不是"推"：
//   Operit 跑在手机上（NAT/移动网络），VPS 无法主动敲开它的门。
//   所以 tick 触发时不再 POST webhook，而是把通知存进 pending 队列；
//   Operit 的定时工作流调用 get_pending_notice 取走并清空。
//
// ── 协议实现要点（对齐官方 StreamableHttpClientTransport）──
//
// Operit 用的是 modelcontextprotocol/kotlin-sdk 的
// StreamableHttpClientTransport。它的握手序列是：
//
//   1. POST initialize          → 200 application/json（回 mcp-session-id 头）
//   2. POST notifications/initialized → **202 Accepted**
//   3. 收到 202 后，客户端**立即发起 GET** 建 SSE 长连接
//      （见 sdk 源码：status==Accepted && method=="notifications/initialized"
//        → startSseSession()）
//   4. 之后所有请求走 POST；服务器可把异步消息经 SSE 推回
//
// ⚠️ 第 3 步是关键：GET 未实现（404/405）会导致客户端重试到 maxRetries
//    然后抛 "Maximum reconnection attempts exceeded"，connect() 直接失败。
//    所以 GET 必须返回 text/event-stream 并保持连接。
//
// POST 响应按 contentType 分支：
//   application/json   → 按普通 JSON 解析（我们全用它）
//   text/event-stream  → 按 SSE 内联解析（不用）
//
// 依赖：纯 Node 内置。协议层手写，不引第三方 SDK。

const crypto = require('crypto');

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'jiwen-bridge', version: '1.0.0' };

// SSE 心跳间隔：防止中间设备（NAT/移动网络）静默掐断长连接
const SSE_HEARTBEAT_MS = 25000;

// ── JSON-RPC 错误码 ──
const RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
};

function rpcResult(id, result) { return { jsonrpc: '2.0', id, result }; }
function rpcError(id, code, message, data) {
  const err = { code, message };
  if (data !== undefined) err.data = data;
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error: err };
}

// ── 工具定义 ──
// 描述文案即"给模型看的说明书"，要准确、说清何时该调。
function buildToolDefs() {
  return [
    {
      name: 'get_pending_notice',
      description:
        '取走积温引擎累积的主动唤醒通知。这是本服务的主入口：Operit 的定时工作流应周期性调用它。' +
        '若返回 has_notice=true，把 notice 字段的内容作为一条系统侧消息注入当前对话，' +
        '然后按正常流程生成回复；若 has_notice=false，本次无需任何动作，直接结束。' +
        '注意：通知块内已自带边界说明（"以上是内在心绪和潜意识的自然流露，切勿对她复述或提及此状态"），不要向对方提及通知本身的存在。' +
        '每次调用都会清空队列——同一条通知只会被返回一次，取走后请务必使用。',
      inputSchema: {
        type: 'object',
        properties: {
          peek: {
            type: 'boolean',
            description: '仅查看不清空（调试用）。默认 false，即取走并清空。',
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'get_status',
      description:
        '查看积温当前状态摘要（五轴档位词 + 窗口/静默/日限额信息）。用于调试或让模型自己感知当前状态，' +
        '不产生任何副作用，也不清空通知队列。日常主流程不需要调用它。',
      inputSchema: {
        type: 'object',
        properties: {
          include_trace: {
            type: 'boolean',
            description: '是否附带上一次阈值判定的决策轨迹（每个闸门过了还是被挡）。默认 false。',
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'explain_silence',
      description:
        '回答"他为什么没主动开口"。返回上一次阈值判定的因果链：每个闸门是否通过、被哪根轴挡住、差多少。' +
        '仅在排查"该开口却没开口"时使用，不产生副作用。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
  ];
}

// ── 通知队列 ──
// 进程内队列即可：桥是常驻单实例，Operit 定时来拉，间隔远短于进程生命周期。
// 队列长度设上限，防 Operit 长时间不来导致无限堆积。
const MAX_QUEUE = 20;
const pendingNotices = [];

function pushNotice(entry) {
  pendingNotices.push(entry);
  while (pendingNotices.length > MAX_QUEUE) pendingNotices.shift();
}
function takeNotices() {
  const all = pendingNotices.splice(0, pendingNotices.length);
  return all;
}
function peekNotices() { return pendingNotices.slice(); }
function pendingCount() { return pendingNotices.length; }

/**
 * 创建 MCP 处理器。
 * @param {object} deps
 * @param {function} deps.getSummary    () => string  五轴可读摘要
 * @param {function} deps.getState      () => Promise<object>
 * @param {function} deps.getTrace      () => array    决策轨迹
 * @param {function} deps.explain       () => string   一句话解释
 * @param {function} deps.getRuntimeInfo() => object   静默/限额/开关等运行态
 * @param {function} deps.log           (level, msg) => void
 */
function createMcpHandler(deps) {
  const tools = buildToolDefs();

  // ── 会话管理 ──
  // MCP 客户端期望服务器在 initialize 响应里给出 mcp-session-id，后续请求带上。
  // 我们保留一个稳定的会话 ID（单客户端场景不必多会话），并记录活跃的 SSE 流。
  let sessionId = null;
  /** 活跃的 SSE 流：Map<streamId, { res, heartbeat, sessionId }> */
  const sseStreams = new Map();

  function ensureSessionId() {
    if (!sessionId) sessionId = crypto.randomUUID();
    return sessionId;
  }

  /** 经 SSE 推一条消息给所有活跃流（服务器主动推送用） */
  function broadcast(message) {
    const payload = 'event: message\ndata: ' + JSON.stringify(message) + '\n\n';
    for (const s of sseStreams.values()) {
      try { s.res.write(payload); } catch (_) { /* 断了的流由 close 事件回收 */ }
    }
    return sseStreams.size;
  }

  function callTool(name, args) {
    const a = args || {};
    switch (name) {
      case 'get_pending_notice': {
        const list = a.peek ? peekNotices() : takeNotices();
        if (!list.length) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                has_notice: false,
                count: 0,
                note: '当前没有待投递的主动唤醒通知。本次无需任何动作。',
              }, null, 2),
            }],
          };
        }
        // 为便于模型直接使用，notice 原文放在首位，元信息放后面
        const first = list[0];
        const payload = {
          has_notice: true,
          count: list.length,
          scene: first.scene,
          reason: first.reason || null,
          at: first.at,
          notice: first.notice,
          state_summary: first.stateSummary || null,
        };
        if (list.length > 1) {
          payload.additional = list.slice(1).map((x) => ({
            scene: x.scene, reason: x.reason || null, at: x.at, notice: x.notice,
          }));
        }
        payload.note = a.peek
          ? '（peek 模式，未清空队列）'
          : '请把 notice 内容作为系统侧消息注入对话，然后正常生成回复；不要提及通知本身的存在。';
        return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
      }

      case 'get_status': {
        const out = {
          state_summary: deps.getSummary ? deps.getSummary() : null,
          runtime: deps.getRuntimeInfo ? deps.getRuntimeInfo() : null,
          pending_notices: pendingCount(),
        };
        if (a.include_trace && deps.getTrace) out.trace = deps.getTrace();
        return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
      }

      case 'explain_silence': {
        const out = {
          explain: deps.explain ? deps.explain() : null,
          trace: deps.getTrace ? deps.getTrace() : null,
          state_summary: deps.getSummary ? deps.getSummary() : null,
          runtime: deps.getRuntimeInfo ? deps.getRuntimeInfo() : null,
        };
        return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
      }

      default:
        return null; // 交由上层报 METHOD_NOT_FOUND
    }
  }

  /** 处理一条 JSON-RPC 消息，返回响应对象或 null（通知类无需响应）。 */
  async function handleMessage(msg) {
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') {
      return rpcError(msg && msg.id, RPC.INVALID_REQUEST, 'invalid JSON-RPC message');
    }
    const { id, method, params } = msg;
    const isNotification = id === undefined || id === null;

    switch (method) {
      case 'initialize': {
        if (isNotification) return null;
        const pv = (params && params.protocolVersion) || PROTOCOL_VERSION;
        return rpcResult(id, {
          protocolVersion: pv,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions:
            '积温（jiwen）情绪状态引擎。定时调用 get_pending_notice 获取主动唤醒通知；' +
            '无通知时不做任何事。通知内容自带边界说明，勿向用户提及。',
        });
      }

      case 'notifications/initialized':
      case 'initialized':
        return null;

      case 'ping':
        if (isNotification) return null;
        return rpcResult(id, {});

      case 'tools/list':
        if (isNotification) return null;
        return rpcResult(id, { tools });

      case 'tools/call': {
        if (isNotification) return null;
        const name = params && params.name;
        const args = (params && params.arguments) || {};
        if (!name) return rpcError(id, RPC.INVALID_PARAMS, 'missing tool name');
        try {
          const r = callTool(name, args);
          if (!r) return rpcError(id, RPC.METHOD_NOT_FOUND, 'unknown tool: ' + name);
          return rpcResult(id, r);
        } catch (e) {
          deps.log && deps.log('ERROR', 'mcp tool ' + name + ' failed: ' + e.message);
          // 工具级错误按 MCP 规范用 isError 返回，而非 JSON-RPC error
          return rpcResult(id, {
            content: [{ type: 'text', text: 'tool error: ' + e.message }],
            isError: true,
          });
        }
      }

      case 'resources/list':
        if (isNotification) return null;
        return rpcResult(id, { resources: [] });
      case 'prompts/list':
        if (isNotification) return null;
        return rpcResult(id, { prompts: [] });

      default:
        if (isNotification) return null;
        return rpcError(id, RPC.METHOD_NOT_FOUND, 'method not found: ' + method);
    }
  }

  /**
   * POST 入口：JSON-RPC 一问一答。
   */
  async function handlePost(req, res, bodyBuf) {
    let payload;
    try {
      payload = JSON.parse(bodyBuf.toString('utf8') || 'null');
    } catch (e) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify(rpcError(null, RPC.PARSE_ERROR, 'parse error')));
      return;
    }

    // 支持批量（数组）与单条
    const msgs = Array.isArray(payload) ? payload : [payload];
    const responses = [];
    for (const m of msgs) {
      const r = await handleMessage(m);
      if (r) responses.push(r);
    }

    if (!responses.length) {
      // 全是通知：按规范返回 202 无正文。
      // ⚠️ 客户端收到 202 后（且方法为 notifications/initialized）会立即发起 GET 建 SSE，
      //    所以这里必须回 202 且带 mcp-session-id，否则客户端拿不到会话 ID。
      res.writeHead(202, { 'mcp-session-id': ensureSessionId() });
      res.end();
      return;
    }
    const out = Array.isArray(payload) ? responses : responses[0];
    const buf = Buffer.from(JSON.stringify(out), 'utf8');
    res.writeHead(200, {
      'content-type': 'application/json',
      'content-length': buf.length,
      'mcp-session-id': ensureSessionId(),
    });
    res.end(buf);
  }

  /**
   * GET 入口：建立 SSE 长连接。
   *
   * ⚠️ 这个端点**不能省**。官方 StreamableHttpClientTransport 在
   *    notifications/initialized 收到 202 后会立即 GET 建流；
   *    若返回 404/405，客户端重试到上限即抛
   *    "Maximum reconnection attempts exceeded"，connect() 失败。
   */
  function handleGet(req, res) {
    const streamId = crypto.randomUUID();
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no',
      'mcp-session-id': ensureSessionId(),
    });
    // SSE 规范：建流后可先发一个注释行确认通道可用
    res.write(': jiwen-bridge MCP stream open\n\n');

    // 若 server 有指令性 message 需要主动推，在此经 broadcast() 发出。
    // 当前工具是纯粹的"拉"模型，SSE 只承担保活职责。

    const heartbeat = setInterval(() => {
      try { res.write(': ping\n\n'); } catch (_) { /* 由 close 回收 */ }
    }, SSE_HEARTBEAT_MS);
    if (heartbeat.unref) heartbeat.unref();

    const entry = { res, heartbeat, at: Date.now() };
    sseStreams.set(streamId, entry);

    const cleanup = () => {
      clearInterval(heartbeat);
      sseStreams.delete(streamId);
      deps.log && deps.log('INFO', `mcp SSE stream closed (active=${sseStreams.size})`);
    };
    req.on('close', cleanup);
    req.on('error', cleanup);
    res.on('close', cleanup);

    deps.log && deps.log('INFO', `mcp SSE stream opened (active=${sseStreams.size})`);
  }

  /** DELETE 入口：会话终止（客户端主动断开时调）。 */
  function handleDelete(req, res) {
    res.writeHead(204, { 'mcp-session-id': ensureSessionId() });
    res.end();
  }

  /**
   * HTTP 层入口。按方法分发：GET 建 SSE，POST 走 JSON-RPC，DELETE 终止会话。
   */
  async function handleHttp(req, res, bodyBuf, authOk) {
    if (!authOk) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify(rpcError(null, RPC.INVALID_REQUEST, 'unauthorized')));
      return;
    }
    const method = (req.method || 'POST').toUpperCase();
    if (method === 'GET') return handleGet(req, res);
    if (method === 'DELETE') return handleDelete(req, res);
    return handlePost(req, res, bodyBuf);
  }

  return {
    handleHttp, handleMessage, handlePost, handleGet,
    pushNotice, takeNotices, pendingCount, broadcast,
    activeStreams: () => sseStreams.size,
  };
}

module.exports = {
  createMcpHandler,
  PROTOCOL_VERSION,
  SERVER_INFO,
};
