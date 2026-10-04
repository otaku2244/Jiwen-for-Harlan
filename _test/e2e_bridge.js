'use strict';
// ════════════════════════════════════════════════════
// 本机端到端测试（不依赖真实 Serein / 不依赖真实 LLM）
//
// 做法：
//   · 起一个假的 Serein 上游（记录收到的 body）
//   · 起一个假的 LLM 端点（返回固定 delta）
//   · 起桥本体，指向上面两个假端点
//   · 发一条带 messages 的 chat/completions 请求
//   · 断言：注入块存在、窗口透传、reset 生效、delta 被应用
// ════════════════════════════════════════════════════

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(__dirname, '.run');
if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true });

const UP_PORT = 19801;
const LLM_PORT = 19802;
const BRIDGE_PORT = 19803;
const STATE = path.join(TMP, 'state.json');
const LOG = path.join(TMP, 'bridge.log');

for (const f of [STATE, LOG]) { try { fs.unlinkSync(f); } catch (_) {} }

let upstreamReceived = null;
const upstream = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = null;
    try { body = JSON.parse(raw); } catch (_) {}
    upstreamReceived = { path: req.url, headers: req.headers, body, raw };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'x', choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
  });
});

let llmCalled = 0;
const llm = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    llmCalled++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ pride: -0.15, valence: 0.10, arousal: -0.08, connection: -0.30 }) } }],
    }));
  });
});

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

function req(port, pathname, body, headers) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const r = http.request({
      hostname: '127.0.0.1', port, path: pathname, method: payload ? 'POST' : 'GET',
      headers: Object.assign({ 'content-type': 'application/json' }, payload ? { 'content-length': Buffer.byteLength(payload) } : {}, headers || {}),
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail });
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (detail ? '  — ' + detail : ''));
}

(async () => {
  await new Promise((r) => upstream.listen(UP_PORT, '127.0.0.1', r));
  await new Promise((r) => llm.listen(LLM_PORT, '127.0.0.1', r));

  // 写 .env（先备份用户已有的，跑完恢复）
  const ENV_PATH = path.join(ROOT, '.env');
  let envBackup = null;
  try { if (fs.existsSync(ENV_PATH)) envBackup = fs.readFileSync(ENV_PATH, 'utf8'); } catch (_) {}

  const env = [
    `BRIDGE_PORT=${BRIDGE_PORT}`,
    'BRIDGE_HOST=127.0.0.1',
    'BRIDGE_TOKEN=test-token-at-least-24-chars-abcdef',
    `UPSTREAM_BASE=http://127.0.0.1:${UP_PORT}`,
    'UPSTREAM_TOKEN=upstream-key-xyz',
    `LLM_BASE=http://127.0.0.1:${LLM_PORT}/v1`,
    'LLM_KEY=test-llm-key',
    'LLM_MODEL=agnes-3.0-flash',
    `STATE_FILE=${STATE.replace(/\\/g, '/')}`,
    `LOG_FILE=${LOG.replace(/\\/g, '/')}`,
    'TICK_MINUTES=5',
    'INJECT_THROTTLE_SECONDS=0',
    'PROACTIVE_ENABLED=false',
  ].join('\n');
  fs.writeFileSync(ENV_PATH, env, 'utf8');
  const child = spawn(process.execPath, [path.join(ROOT, 'bridge.js')], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let bootLog = '';
  child.stdout.on('data', (d) => { bootLog += d.toString(); });
  child.stderr.on('data', (d) => { bootLog += d.toString(); });

  await wait(1200);

  // ── 用例 1：鉴权拒绝 ──
  const bad = await req(BRIDGE_PORT, '/v1/chat/completions', { messages: [] }, { authorization: 'Bearer wrong' });
  check('鉴权：错误 token 返回 401', bad.status === 401, 'status=' + bad.status);

  // ── 用例 2：健康检查 ──
  const h = await req(BRIDGE_PORT, '/bridge/health');
  check('健康检查返回 ok', h.status === 200 && h.text.includes('"ok"'), h.text.slice(0, 60));

  // ── 用例 3：注入 + 转发 + 窗口透传 ──
  const payload = {
    model: 'x',
    messages: [
      { role: 'system', content: '你是 Harlan。' },
      { role: 'user', content: '在忙吗' },
      { role: 'assistant', content: '刚在看书。' },
      { role: 'user', content: '我有点累了' },
    ],
  };
  const r3 = await req(BRIDGE_PORT, '/v1/chat/completions', payload, {
    authorization: 'Bearer test-token-at-least-24-chars-abcdef',
    'x-serein-window-id': 'operit',
  });
  check('转发成功（200）', r3.status === 200, 'status=' + r3.status);

  await wait(300);
  const lastMsg = upstreamReceived && upstreamReceived.body.messages[3];
  check('上游收到改写的请求', !!upstreamReceived);
  check('上游 Authorization 被换成 Gateway Key',
    upstreamReceived && upstreamReceived.headers.authorization === 'Bearer upstream-key-xyz',
    upstreamReceived && upstreamReceived.headers.authorization);
  check('窗口头原样透传',
    upstreamReceived && upstreamReceived.headers['x-serein-window-id'] === 'operit',
    upstreamReceived && upstreamReceived.headers['x-serein-window-id']);
  check('最后一条 user 消息被注入积温块',
    lastMsg && lastMsg.content.includes('【积温·此刻'),
    lastMsg ? lastMsg.content.slice(0, 50) : 'null');
  check('注入块保留原消息内容',
    lastMsg && lastMsg.content.includes('我有点累了'));
  check('注入块含风格指令（tone grid 生效）',
    lastMsg && /(随性自然|像和熟人闲聊|矜持自持|得体、温和|高冷简练)/.test(lastMsg.content),
    lastMsg ? lastMsg.content.split('\n').slice(1, 3).join(' / ') : '');
  check('开局状态为中性而非低谷（NEUTRAL_SEED 生效）',
    lastMsg && lastMsg.content.includes('心情：中性'),
    lastMsg ? (lastMsg.content.match(/心情：[^。]*。/) || [''])[0] : '');

  // ── 用例 4：判定器被调用 & delta 应用 ──
  await wait(1200);
  check('判定器被调用', llmCalled > 0, 'calls=' + llmCalled);
  const st = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  check('delta 已叠加到状态（pride 为负）', st.pride < 0, 'pride=' + st.pride);
  check('connection 被 reset 后叠加 delta', st.connection <= 0.01, 'connection=' + st.connection);

  // ── 用例 5：状态持久化 ──
  check('state.json 已落盘', fs.existsSync(STATE));

  // ── 用例 6：非 chat 路径不注入 ──
  await req(BRIDGE_PORT, '/v1/models', null, { authorization: 'Bearer test-token-at-least-24-chars-abcdef' });
  await wait(200);
  check('非 chat 路径原样透传', upstreamReceived && upstreamReceived.path === '/v1/models',
    upstreamReceived && upstreamReceived.path);

  child.kill('SIGTERM');
  await wait(400);
  upstream.close(); llm.close();

  // ── 恢复 / 清理 .env（防止假配置被误当成真实部署配置）──
  try {
    if (envBackup !== null) fs.writeFileSync(ENV_PATH, envBackup, 'utf8');
    else fs.unlinkSync(ENV_PATH);
  } catch (_) { /* 忽略 */ }

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n  ${pass}/${results.length} 通过`);
  fs.writeFileSync(path.join(TMP, 'e2e-result.json'), JSON.stringify({ results, pass, total: results.length, bootLog }, null, 2));
  process.exit(pass === results.length ? 0 : 1);
})().catch((e) => { console.error('TEST CRASH', e); process.exit(2); });
