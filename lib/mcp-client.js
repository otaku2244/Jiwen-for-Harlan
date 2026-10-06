'use strict';
// MCP 客户端（Streamable HTTP，JSON-RPC 2.0）——纯 Node 内置，不引第三方 SDK。
//
// 服务端见同目录 mcp.js（那是我们的服务器）；这里是反过来的一侧：让桥主动去读
// 别的 MCP 端点。当前已知目标是银河 GLXY（https://glxy.xiflow.top/mcp/<星号密钥>）。
//
// ── 为什么不需要 SSE / session ──
// 对 GLXY 实测（2026-10-06），无 session、无重连，握手结果如下：
//   1. POST initialize              → 200 application/json
//      无 mcp-session-id 响应头 → 服务端不跟踪会话
//   2. POST notifications/initialized → 202（无状态端点不校验，可跳过）
//   3. 后续 tools/list、tools/call   → 各自独立 POST，直接拿 JSON
//   响应 Content-Type 恒为 application/json，没有 text/event-stream 分支。
// 所以这里不实现 SSE 解析、不存 session id、不做重连。
//
// ⚠️ 但如果将来接的端点是有 session 的（官方 SDK 那种），initialize 的
//    mcp-session-id 会被记到 this._sessionId，后续请求带回去即可。
//    见下方 _post 里的 sessionId 注入逻辑。
//
// ── ⚠️ 静默降级：GLXY 密钥失效不报错 ──
// 实测：带一个无效密钥调 tools/list，返回 HTTP 200 + 正常 JSON，
// 只是**每个工具的 description 前面插了一句**：
//   〔你带的钥匙无效，当前在门外〕向银河新星办事处递一份入册申请……
// 即协议层完全成功，语义层告诉你"你其实没进去"。
// 若不识别这个标记，会把「门外的报名页」当成「墙上的文章」读进候选池。
// 故 callToolsList 一律跑 detectAuthWall()，命中即抛 AUTH_REQUIRED。

const http = require('http');
const https = require('https');
const tls = require('tls');
const { URL } = require('url');

const PROTOCOL_VERSION = '2025-06-18';
const CLIENT_INFO = { name: 'jiwen-surf', version: '1.0.0' };

const DEFAULT_TIMEOUT_MS = parseInt(process.env.MCP_TIMEOUT_MS || '20000', 10);

// GLXY 在工具描述里插入的"你其实没进去"标记。逐字匹配，别改写。
const AUTH_WALL_MARK = '〔你带的钥匙无效，当前在门外〕';
// 兜底：有些端点可能用别的措辞。都归成"需要凭据"。
const AUTH_WALL_FALLBACKS = [
  '钥匙无效', '当前在门外', 'authentication required', 'unauthorized', 'invalid token',
];

class McpAuthRequired extends Error {
  constructor(msg) { super(msg || 'MCP endpoint reports auth required'); this.name = 'McpAuthRequired'; }
}

/** 扫一段文本里有没有"未获授权"的信号。 */
function detectAuthWall(text) {
  if (!text) return false;
  if (text.includes(AUTH_WALL_MARK)) return true;
  const lower = String(text).toLowerCase();
  return AUTH_WALL_FALLBACKS.some((k) => lower.includes(k.toLowerCase()));
}

// ── HTTP（含可选 CONNECT 代理）──────────────────────
// 代理只为本地测试存在：Windows 沙箱里 curl 到境外站点必须走 Clash。
// VPS 上不设SURF_PROXY，走直连。
const PROXY = (() => {
  const raw = process.env.SURF_PROXY || '';
  if (!raw) return null;
  try { return new URL(/^\w+:\/\//.test(raw) ? raw : 'http://' + raw); } catch (_) { return null; }
})();

function httpRequest(opts, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (err, res) => {
      if (done) return;
      done = true;
      if (err) reject(err); else resolve(res);
    };

    const send = (req) => {
      req.setTimeout(timeoutMs || DEFAULT_TIMEOUT_MS, () => {
        req.destroy(new Error('timeout ' + (timeoutMs || DEFAULT_TIMEOUT_MS) + 'ms'));
      });
      req.on('error', (e) => finish(e));
      req.on('response', (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => finish(null, {
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }));
      });
      if (body && body.length) req.write(body);
      req.end();
    };

    const path = opts.pathname + (opts.search || '');

    // ⚠️⚠️ ALPN 必须显式声明 http/1.1，否则 Cloudflare 直接 403。
    // 实测归因（2026-10-06,_test/attr_403.js）：Node 的 https.request 默认**不发
    // ALPN**，TLS 握手时服务端无可选协议；而 curl 会发 ALPN 并让服务端选中 http/1.1。
    // 同样的头、同样的 UA、同样的 cipher，只把 ALPN 加上就从 403 变 200。
    // 现象是GLXY 前面挂了 Cloudflare，不带 ALPN 的握手被判为可疑。
    // 这不是 GLXY 特有的问题，任何走Cloudflare 的 HTTPS 端点都可能如此。
    // 只有 https 需要；http 走明文无此问题。
    const tlsOpts = {
      socket: opts.protocol === 'https:',
      servername: opts.protocol === 'https:' ? opts.hostname : undefined,
      ALPNProtocols: opts.protocol === 'https:' ? ['http/1.1'] : undefined,
      host: opts.protocol === 'https:' ? undefined : opts.hostname,
      port: opts.protocol === 'https:' ? undefined : (opts.port || 80),
    };
    const makeReq = (socket) => (opts.protocol === 'https:' ? https : http).request(
      Object.assign({}, opts, {
        // https/http.request 认的是 path，不是 pathname。
        // 漏了这条会把请求打到根路径 → 端点返回 404（GLXY 会回 "not found"）。
        path,
        socket,
        servername: tlsOpts.servername,
        createConnection: opts.protocol === 'https:'
          ? (o, cb) => tls.connect(Object.assign({}, tlsOpts, {
            socket: socket || undefined,
            host: socket ? undefined : opts.hostname,
            port: socket ? undefined : (opts.port || 443),
          }), cb)
          : undefined,
      })
    );

    if (!PROXY) { send(makeReq(null)); return; }

    // 经代理：先 CONNECT 隧道，再在隧道里做 TLS。
    const preq = http.request({
      host: PROXY.hostname,
      port: PROXY.port || 80,
      method: 'CONNECT',
      path: opts.hostname + ':' + (opts.port || (opts.protocol === 'https:' ? 443 : 80)),
      headers: { host: opts.hostname + ':' + (opts.port || (opts.protocol === 'https:' ? 443 : 80)) },
    });
    preq.on('error', (e) => finish(e));
    preq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return finish(new Error('proxy CONNECT failed: ' + res.statusCode));
      }
      send(makeReq(socket));
    });
    preq.end();
  });
}

/**
 * 创建一个 MCP 客户端会话。
 *
 * 端点无状态，所以"创建"只是记下地址，不做网络动作。首次调用时会自动 initialize。
 */
function createMcpClient(endpoint, opts) {
  const o = opts || {};
  const log = o.log || null;
  const timeoutMs = o.timeoutMs || DEFAULT_TIMEOUT_MS;

  let base;
  try {
    base = new URL(endpoint);
  } catch (e) {
    throw new Error('bad MCP endpoint: ' + endpoint);
  }

  const client = {
    endpoint,
    serverInfo: null,
    _initialized: false,
    _sessionId: null,
    _reqId: 0,
    // 供测试注入：直接把底层 post换掉
    _post: post,
  };

  function nextId() { return ++client._reqId; }

  /** 一次 JSON-RPC POST。 */
  async function post(method, params) {
    const payload = Buffer.from(JSON.stringify({
      jsonrpc: '2.0',
      id: nextId(),
      method,
      params: params || {},
    }), 'utf8');

    const headers = {
      'content-type': 'application/json',
      'accept': 'application/json, text/event-stream',
      'content-length': payload.length,
      // ⚠️ 必须带 user-agent。实测 GLXY 前面挂了 Cloudflare：Node 默认 UA
      // （不带 UA 或 node/...）会被 403挡掉，而 curl 默认 UA 可以过。
      'user-agent': o.userAgent || process.env.MCP_USER_AGENT || 'curl/8.7.1',
    };
    if (client._sessionId) headers['mcp-session-id'] = client._sessionId;

    const res = await httpRequest({
      protocol: base.protocol,
      hostname: base.hostname,
      port: base.port || (base.protocol === 'https:' ? 443 : 80),
      pathname: base.pathname,
      search: base.search,
      method: 'POST',
      headers,
    }, payload, timeoutMs);

    // 有状态端点会把 session id 放在响应头；无状态的（GLXY）没有，也不需要。
    const sid = res.headers['mcp-session-id'];
    if (sid) client._sessionId = Array.isArray(sid) ? sid[0] : sid;

    if (res.status >= 400) {
      throw new Error('MCP ' + res.status + ' on ' + method + ': ' + res.body.slice(0, 200));
    }

    let j;
    try {
      j = JSON.parse(res.body);
    } catch (e) {
      throw new Error('non-JSON from MCP ' + method + ': ' + res.body.slice(0, 200));
    }
    if (j.error) {
      throw new Error('MCP error on ' + method + ': ' + (j.error.message || JSON.stringify(j.error)));
    }
    return j.result;
  }

  /** 握手。无状态端点下次调用也会重来一遍，但很便宜，幂等。 */
  async function ensureInit() {
    if (client._initialized) return;
    const r = await post('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    });
    client.serverInfo = (r && r.serverInfo) || null;
    // 无状态端点不校验这条通知，发了也不等结果；失败不影响后续调用。
    try {
      await post('notifications/initialized', {});
    } catch (_) { /* 忽略 */ }
    client._initialized = true;
    if (log) {
      log('INFO', `mcp handshake: ${(client.serverInfo && client.serverInfo.name) || '?'}` +
        ` v${(client.serverInfo && client.serverInfo.version) || '?'}`);
    }
  }

  client.ensureInit = ensureInit;
  client.post = post;

  /**
   * 列工具。命中"未获授权"标记时抛 McpAuthRequired，
   * 绝不在门外状态把工具描述当内容用。
   */
  client.listTools = async function listTools() {
    await ensureInit();
    const r = await post('tools/list', {});
    const tools = (r && r.tools) || [];
    const probe = tools.map((t) => (t.description || '') + ' ' + (t.name || '')).join('\n');
    if (detectAuthWall(probe)) {
      throw new McpAuthRequired('endpoint reports an auth wall: ' + AUTH_WALL_MARK);
    }
    return tools;
  };

  /** 调一个工具，返回其 content 块的纯文本（多块用空行拼）。 */
  client.callTool = async function callTool(name, args) {
    await ensureInit();
    const r = await post('tools/call', { name, arguments: args || {} });
    const content = (r && r.content) || [];
    const text = content
      .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n')
      .trim();
    if (detectAuthWall(text)) {
      throw new McpAuthRequired('tool ' + name + ' returned an auth wall');
    }
    if (r && r.isError) throw new Error('tool ' + name + ' error: ' + text.slice(0, 200));
    return text;
  };

  return client;
}

module.exports = {
  createMcpClient,
  McpAuthRequired,
  detectAuthWall,
  AUTH_WALL_MARK,
  PROTOCOL_VERSION,
};