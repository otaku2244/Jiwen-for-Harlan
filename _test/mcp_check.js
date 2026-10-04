'use strict';
// MCP 服务专项测试：协议握手、工具列举、通知入队/取走、鉴权、错误处理。
// 用法：node _test/mcp_check.js
//
// 不起完整 bridge（避免碰真状态文件与上游），直接对 lib/mcp.js 打协议。

const { createMcpHandler } = require('../lib/mcp.js');

// ── 桩：模拟 bridge 提供的依赖 ──
const stub = {
  getSummary: () => '[积温] c:0.42(想念) p:0.55(收着) v:-0.20(中性) a:0.30(平静) i:0.00(空闲) | userStatus: active',
  getState: async () => ({ connection: 0.42, pride: 0.55, valence: -0.2, arousal: 0.3, immersion: 0 }),
  getTrace: () => ([
    { gate: '开口', fired: false, reason: 'pride 挡住开口，immersion 又缓冲住了（没转成找事做）',
      detail: { pride: 0.55, 嘴硬线: 0.5, immersion: 0.0, immersion上限: 0.2 } },
  ]),
  explain: () => '未触发: pride 挡住开口，immersion 又缓冲住了（没转成找事做）',
  getRuntimeInfo: () => ({
    proactive_enabled: true, in_quiet_hours: true, quiet_range: [0, 8],
    sent_today: 0, daily_limit: 6, inject_enabled: true, tick_minutes: 5,
  }),
  log: () => {},
};

const mcp = createMcpHandler(stub);

let pass = 0, total = 0;
function check(name, cond, extra) {
  total++;
  if (cond) pass++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${extra !== undefined && !cond ? '  — ' + JSON.stringify(extra) : ''}`);
}

function makeRes() {
  const r = {
    code: null, headers: null, body: '', ended: false,
    chunks: [], listeners: {},
  };
  r.writeHead = (c, h) => { r.code = c; r.headers = h || null; };
  r.write = (b) => { r.chunks.push(b.toString()); return true; };
  r.end = (b) => { if (b) r.body = b.toString(); r.ended = true; };
  r.on = (ev, fn) => { (r.listeners[ev] = r.listeners[ev] || []).push(fn); };
  r.emit = (ev) => { (r.listeners[ev] || []).forEach((f) => f()); };
  r.stream = () => r.chunks.join('');
  return r;
}
function makeReq(method, headers) {
  const req = { method: method || 'POST', headers: headers || {}, listeners: {} };
  req.on = (ev, fn) => { (req.listeners[ev] = req.listeners[ev] || []).push(fn); };
  req.emit = (ev) => { (req.listeners[ev] || []).forEach((f) => f()); };
  return req;
}
async function call(payload, opts) {
  const o = opts || {};
  const res = makeRes();
  const req = makeReq(o.method || 'POST', o.headers || {});
  const buf = Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8');
  await mcp.handleHttp(req, res, buf, o.authOk !== false);
  let json = null;
  try { json = res.body ? JSON.parse(res.body) : null; } catch (_) {}
  return { res, json, req };
}

(async () => {
  console.log('MCP 服务专项\n');

  // ① 初始化握手
  {
    const { json } = await call({ jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'operit', version: '1' } } });
    check('① initialize 返回 serverInfo', json && json.result && json.result.serverInfo &&
      json.result.serverInfo.name === 'jiwen-bridge', json);
    check('① initialize 声明 tools 能力', json && json.result && json.result.capabilities &&
      json.result.capabilities.tools, json && json.result);
    check('① initialize 回显 protocolVersion', json && json.result &&
      json.result.protocolVersion === '2025-06-18', json && json.result);
  }

  // ② 工具列表
  {
    const { json } = await call({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const names = (json && json.result && json.result.tools || []).map((t) => t.name);
    check('② tools/list 返回 3 个工具', names.length === 3, names);
    check('② 含 get_pending_notice', names.includes('get_pending_notice'), names);
    check('② 含 get_status', names.includes('get_status'), names);
    check('② 含 explain_silence', names.includes('explain_silence'), names);
    const t = (json.result.tools || []).find((x) => x.name === 'get_pending_notice');
    check('② 工具带 inputSchema', !!(t && t.inputSchema && t.inputSchema.type === 'object'));
  }

  // ③ 空队列
  {
    const { json } = await call({ jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'get_pending_notice', arguments: {} } });
    const txt = json && json.result && json.result.content[0].text;
    const parsed = JSON.parse(txt);
    check('③ 空队列返回 has_notice=false', parsed.has_notice === false, parsed);
  }

  // ④ 入队 → 取走 → 再取为空
  {
    mcp.pushNotice({ scene: 'contact', reason: null, at: '2026-10-05T00:00:00.000Z',
      notice: '【积温·找她】\n心情：中性。\n以上是内在心绪和潜意识的自然流露，切勿对她复述或提及此状态。',
      stateSummary: stub.getSummary() });
    mcp.pushNotice({ scene: 'find_activity', reason: 'pride_block', at: '2026-10-05T00:05:00.000Z',
      notice: '【积温·自留地】\n心情：中性。\n以上是内在心绪和潜意识的自然流露，切勿对她复述或提及此状态。',
      stateSummary: stub.getSummary() });
    check('④ 入队后 pendingCount=2', mcp.pendingCount() === 2, mcp.pendingCount());

    const { json } = await call({ jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'get_pending_notice', arguments: {} } });
    const parsed = JSON.parse(json.result.content[0].text);
    check('④ 取到 has_notice=true', parsed.has_notice === true, parsed);
    check('④ count=2 且含 additional', parsed.count === 2 && Array.isArray(parsed.additional), parsed);
    check('④ notice 原文完整（含边界句）', typeof parsed.notice === 'string' &&
      parsed.notice.includes('以上是内在心绪和潜意识的自然流露'), parsed.notice);
    check('④ scene 透传', parsed.scene === 'contact', parsed.scene);

    const { json: j2 } = await call({ jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: { name: 'get_pending_notice', arguments: {} } });
    const p2 = JSON.parse(j2.result.content[0].text);
    check('④ 取走后队列清空', p2.has_notice === false, p2);
    check('④ pendingCount 归零', mcp.pendingCount() === 0, mcp.pendingCount());
  }

  // ⑤ peek 不清空
  {
    mcp.pushNotice({ scene: 'contact', reason: null, at: '2026-10-05T00:10:00.000Z',
      notice: 'X', stateSummary: null });
    const { json } = await call({ jsonrpc: '2.0', id: 6, method: 'tools/call',
      params: { name: 'get_pending_notice', arguments: { peek: true } } });
    const parsed = JSON.parse(json.result.content[0].text);
    check('⑤ peek 返回 has_notice=true', parsed.has_notice === true, parsed);
    check('⑤ peek 后队列仍在（=1）', mcp.pendingCount() === 1, mcp.pendingCount());
    mcp.takeNotices(); // 清理
  }

  // ⑥ get_status
  {
    const { json } = await call({ jsonrpc: '2.0', id: 7, method: 'tools/call',
      params: { name: 'get_status', arguments: { include_trace: true } } });
    const parsed = JSON.parse(json.result.content[0].text);
    check('⑥ get_status 含 state_summary', typeof parsed.state_summary === 'string', parsed);
    check('⑥ get_status 含 runtime', !!(parsed.runtime && parsed.runtime.daily_limit === 6), parsed.runtime);
    check('⑥ include_trace 生效', Array.isArray(parsed.trace) && parsed.trace.length === 1, parsed.trace);
  }

  // ⑦ explain_silence
  {
    const { json } = await call({ jsonrpc: '2.0', id: 8, method: 'tools/call',
      params: { name: 'explain_silence', arguments: {} } });
    const parsed = JSON.parse(json.result.content[0].text);
    check('⑦ explain 返回非空文案', typeof parsed.explain === 'string' && parsed.explain.length > 0, parsed);
    check('⑦ explain 含"未触发"', parsed.explain.includes('未触发'), parsed.explain);
  }

  // ⑧ 未知工具 → JSON-RPC error
  {
    const { json } = await call({ jsonrpc: '2.0', id: 9, method: 'tools/call',
      params: { name: 'nope', arguments: {} } });
    check('⑧ 未知工具返回 -32601', json && json.error && json.error.code === -32601, json);
  }

  // ⑨ 未知方法 → -32601
  {
    const { json } = await call({ jsonrpc: '2.0', id: 10, method: 'bogus/method' });
    check('⑨ 未知方法返回 -32601', json && json.error && json.error.code === -32601, json);
  }

  // ⑩ 坏 JSON → -32700
  {
    const { res, json } = await call('{not json');
    check('⑩ 坏 JSON 返回 400 + -32700', res.code === 400 && json && json.error &&
      json.error.code === -32700, { code: res.code, json });
  }

  // ⑪ 通知（无 id）→ 202 无正文
  {
    const { res } = await call({ jsonrpc: '2.0', method: 'notifications/initialized' });
    check('⑪ 通知类请求返回 202 空正文', res.code === 202 && !res.body, { code: res.code, body: res.body });
  }

  // ⑫ ping
  {
    const { json } = await call({ jsonrpc: '2.0', id: 11, method: 'ping' });
    check('⑫ ping 返回空 result', json && json.result && Object.keys(json.result).length === 0, json);
  }

  // ⑬ 鉴权失败
  {
    const { res, json } = await call({ jsonrpc: '2.0', id: 12, method: 'tools/list' }, { authOk: false });
    check('⑬ 鉴权失败返回 401', res.code === 401, { code: res.code, json });
  }

  // ⑭ 队列上限（MAX_QUEUE=20）
  {
    for (let i = 0; i < 25; i++) {
      mcp.pushNotice({ scene: 'contact', reason: null, at: 't' + i, notice: 'N' + i, stateSummary: null });
    }
    check('⑭ 队列不超过 20（丢弃最旧）', mcp.pendingCount() === 20, mcp.pendingCount());
    const all = mcp.takeNotices();
    check('⑭ 保留的是最新的', all[0].notice === 'N5' && all[19].notice === 'N24',
      { first: all[0].notice, last: all[19].notice });
  }

  // ══════ Streamable HTTP 兼容性（对齐官方 kotlin-sdk 客户端）══════

  // ⑮ 响应必须带 mcp-session-id 头
  {
    const { res } = await call({ jsonrpc: '2.0', id: 20, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'o', version: '1' } } });
    check('⑮ initialize 响应带 mcp-session-id', !!(res.headers && res.headers['mcp-session-id']),
      res.headers);
  }

  // ⑯ 会话 ID 稳定（同一会话内多次请求一致）
  {
    const a = await call({ jsonrpc: '2.0', id: 21, method: 'ping' });
    const b = await call({ jsonrpc: '2.0', id: 22, method: 'ping' });
    const ida = a.res.headers && a.res.headers['mcp-session-id'];
    const idb = b.res.headers && b.res.headers['mcp-session-id'];
    check('⑯ 会话 ID 跨请求稳定', !!ida && ida === idb, { ida, idb });
  }

  // ⑰ notifications/initialized → 202 + session 头（客户端据此发起 GET SSE）
  {
    const { res } = await call({ jsonrpc: '2.0', method: 'notifications/initialized' });
    check('⑰ initialized 返回 202', res.code === 202, res.code);
    check('⑰ 202 带 mcp-session-id（GET 拿流时需一致）',
      !!(res.headers && res.headers['mcp-session-id']), res.headers);
  }

  // ⑱ GET → SSE 长连接
  {
    const { res, req } = await call(null, { method: 'GET' });
    check('⑱ GET 返回 200', res.code === 200, res.code);
    check('⑱ content-type 为 text/event-stream',
      !!(res.headers && /text\/event-stream/.test(res.headers['content-type'])), res.headers);
    check('⑱ 禁用缓冲（x-accel-buffering）',
      !!(res.headers && res.headers['x-accel-buffering'] === 'no'), res.headers);
    check('⑱ 未立刻结束（保持长连接）', res.ended === false, res.ended);
    check('⑱ 建流即写入 SSE 注释帧', res.stream().includes(': jiwen-bridge MCP stream open'),
      res.stream().slice(0, 60));
    check('⑱ 活跃流计数为 1', mcp.activeStreams() === 1, mcp.activeStreams());

    // broadcast（服务器主动推）能到这条流
    mcp.broadcast({ jsonrpc: '2.0', method: 'notifications/message' });
    check('⑱ broadcast 写入该流', res.stream().includes('notifications/message'),
      res.stream().slice(0, 200));

    // 断开后回收
    req.emit('close');
    check('⑱ 断开后活跃流归零', mcp.activeStreams() === 0, mcp.activeStreams());
  }

  // ⑲ 多流并存与独立回收
  {
    const a = await call(null, { method: 'GET' });
    const b = await call(null, { method: 'GET' });
    check('⑲ 两条流并存', mcp.activeStreams() === 2, mcp.activeStreams());
    mcp.broadcast({ jsonrpc: '2.0', method: 'notifications/message' });
    check('⑲ broadcast 同时到达两条流',
      a.res.stream().includes('notifications/message') &&
      b.res.stream().includes('notifications/message'), null);
    a.req.emit('close');
    check('⑲ 关一条剩一条', mcp.activeStreams() === 1, mcp.activeStreams());
    b.req.emit('close');
    check('⑲ 全关归零', mcp.activeStreams() === 0, mcp.activeStreams());
  }

  // ⑳ DELETE → 204
  {
    const { res } = await call(null, { method: 'DELETE' });
    check('⑳ DELETE 返回 204', res.code === 204, res.code);
  }

  // ㉑ GET 未授权 → 401（SSE 也不能裸奔）
  {
    const { res } = await call(null, { method: 'GET', authOk: false });
    check('㉑ GET 无 token 返回 401', res.code === 401, res.code);
  }

  console.log(`\n${pass}/${total} 通过`);
  process.exit(pass === total ? 0 : 1);
})().catch((e) => { console.error('测试崩溃:', e); process.exit(2); });
