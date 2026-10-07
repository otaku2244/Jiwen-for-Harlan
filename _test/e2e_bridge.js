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
let llmFail = false; // 用例 4b 用：让判定器拿到非 JSON 内容 → 走失败分支 → 触发兜底缓解
const llm = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    llmCalled++;
    res.writeHead(200, { 'content-type': 'application/json' });
    if (llmFail) {
      res.end(JSON.stringify({
        choices: [{ message: { content: '抱歉，我不能完成这个请求。' } }],
      }));
      return;
    }
    // connection 取**正向**（+0.15 = 「她敷衍」那一档）：撤掉 resetConnection 之后，
    // 这是唯一能证明"delta 真的推得动 c"的方向 —— 负向在 c=0 时无论如何都是 0。
    res.end(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ pride: -0.15, valence: 0.10, arousal: -0.08, connection: 0.15 }) } }],
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
    // ⚠️ 判定器自带限流（默认 20s 一条 + 熔断），连发用例会被静默拦掉、
    //    表现为「llmCalled 不涨」而不是报错。测试必须置 0。见 lib/analyzer.js。
    'LLM_MIN_INTERVAL_SECONDS=0',
    'LLM_BREAKER_SECONDS=0',
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
  // 2026-10-08 起块内没有档位行，探针改用 45 格正文首行的簇名。
  // 中性态簇 = neutral，低谷态簇 = depressed —— 正好能证明 NEUTRAL_SEED 生效。
  check('开局状态为中性而非低谷（NEUTRAL_SEED 生效）',
    lastMsg && /^neutral，/m.test(lastMsg.content) && !/^depressed，/m.test(lastMsg.content),
    lastMsg ? (lastMsg.content.split('\n').find((l) => /^(neutral|depressed)，/.test(l)) || '') : '');

  // ── 用例 3b：判定器按「轮次」去重（工具轮）──
  // 模型调工具后 Operit 会用**同一份 messages** 再发一次请求。
  // 不去重 → 判定器把同一段对话判 N 次、delta 叠 N 次
  //（2026-10-07 线上实测同一轮判 4 次：pride 该掉 0.12 实际掉 0.66）。
  await wait(900);                       // 等用例 3 的异步判定跑完
  const llmBaseline = llmCalled;

  await req(BRIDGE_PORT, '/v1/chat/completions', payload, {
    authorization: 'Bearer test-token-at-least-24-chars-abcdef',
    'x-serein-window-id': 'operit',
  });
  await wait(900);
  check('同一份 messages 重发 → 判定器不再被喂（工具轮去重）',
    llmCalled === llmBaseline, `baseline=${llmBaseline} now=${llmCalled}`);

  // 她说了新话 → 必须放行
  const payload2 = JSON.parse(JSON.stringify(payload));
  payload2.messages[3] = { role: 'user', content: '算了 你先忙' };
  await req(BRIDGE_PORT, '/v1/chat/completions', payload2, {
    authorization: 'Bearer test-token-at-least-24-chars-abcdef',
    'x-serein-window-id': 'operit',
  });
  await wait(900);
  check('她说了新话 → 判定器被喂（去重不误杀新一轮）',
    llmCalled > llmBaseline, `baseline=${llmBaseline} now=${llmCalled}`);

  // ── 用例 4：判定器被调用 & delta 应用 ──
  await wait(1200);
  check('判定器被调用', llmCalled > 0, 'calls=' + llmCalled);
  const st = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  check('delta 已叠加到状态（pride 为负）', st.pride < 0, 'pride=' + st.pride);
  check('connection 由判定器 delta 直接驱动（resetConnection 已撤）：2 次 +0.15 → 0.30',
    Math.abs(st.connection - 0.30) < 0.01, 'connection=' + st.connection);
  check('0.30 已越过留意线 0.20（旧行为下这个值被 reset 钉死在 ≤0.15）',
    st.connection >= 0.20, 'connection=' + st.connection);

  // ── 用例 4b：判定器失败 → 兜底缓解（-CONNECTION_RELIEF）──
  //   "她开口了但没人判"这一支必须有保险公司：否则 c 只涨不降，
  //   会被误判成"她很久没来"而乱触发唤醒。
  const before4b = JSON.parse(fs.readFileSync(STATE, 'utf8')).connection;
  llmFail = true;
  const payload4b = JSON.parse(JSON.stringify(payload));
  payload4b.messages[3] = { role: 'user', content: '嗯' };
  await req(BRIDGE_PORT, '/v1/chat/completions', payload4b, {
    authorization: 'Bearer test-token-at-least-24-chars-abcdef',
    'x-serein-window-id': 'operit',
  });
  await wait(1600);
  const after4b = JSON.parse(fs.readFileSync(STATE, 'utf8')).connection;
  check('判定器失败 → 兜底缓解生效（c 从 0.30 被压回）',
    after4b < before4b, `${before4b} → ${after4b}`);
  check('兜底量 = 0.35 → 一次就落到轴下界 0',
    after4b === 0, 'connection=' + after4b);
  llmFail = false;

  // ── 用例 5：状态持久化 ──
  check('state.json 已落盘', fs.existsSync(STATE));

  // ── 用例 6：非 chat 路径不注入 ──
  await req(BRIDGE_PORT, '/v1/models', null, { authorization: 'Bearer test-token-at-least-24-chars-abcdef' });
  await wait(200);
  check('非 chat 路径原样透传', upstreamReceived && upstreamReceived.path === '/v1/models',
    upstreamReceived && upstreamReceived.path);

  // ── 用例 7：冲浪产物回投 → 活动登记（描述层段4 的真来源）──
  // 这条是**跨进程**实证：桥进程内 recordActivity 真的把活动写进了引擎状态，
  // 且写的是中文 label（英文 type 不进模型可见文本）。
  // ⚠️ 登记发生在 fireProactive **之前**，所以哪怕此刻正逢静默时段（投递被挡）
  //    也不影响这条断言 —— 与挂钟无关。
  const sf = await req(BRIDGE_PORT, '/surf/finding', {
    ok: true, title: 'Attention Is All You Need',
    url: 'https://arxiv.org/abs/1706.03762', note: '把注意力机制从循环结构里拆出来单独用。',
  }, { authorization: 'Bearer test-token-at-least-24-chars-abcdef' });
  check('冲浪产物回投被接受（200）', sf.status === 200, 'status=' + sf.status);

  // 登记后的一轮真实对话：此刻块里必须出现段4 的 doing 句（不再是恒定 idle）
  await wait(300);
  const payload3 = JSON.parse(JSON.stringify(payload));
  payload3.messages[3] = { role: 'user', content: '刚忙完？' };
  await req(BRIDGE_PORT, '/v1/chat/completions', payload3, {
    authorization: 'Bearer test-token-at-least-24-chars-abcdef',
    'x-serein-window-id': 'operit',
  });
  await wait(300);
  const lastMsg3 = upstreamReceived && upstreamReceived.body.messages[3];
  check('注入块里出现段4 的「刚才在网页检索。」',
    lastMsg3 && lastMsg3.content.includes('刚才在网页检索。'),
    lastMsg3 ? (lastMsg3.content.split('\n').find((l) => /刚才在|没在做什么/.test(l)) || '(无段4)') : 'null');
  check('注入块里没有把英文 type 写进文本', lastMsg3 && !lastMsg3.content.includes('search'));

  // 落盘是 1s 去抖（scheduleFlush），读盘前必须等过这一拍。
  await wait(1400);
  const st2 = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  check('活动已登记进引擎并落盘（immersion = 0.40）', Math.abs(st2.immersion - 0.4) < 1e-9,
    'immersion=' + st2.immersion);
  check('lastActivity 记的是中文 label / 英文 type',
    st2.lastActivity && st2.lastActivity.label === '网页检索' && st2.lastActivity.type === 'search',
    JSON.stringify(st2.lastActivity));

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
