'use strict';
// ════════════════════════════════════════════════════
// contact 缓解必须受投递闸门保护（2026-10-09）
// 用法：node _test/contact_relief_check.js
//
// 修的问题：contact 触发后**无条件** applyDelta({connection:-0.35})。
//   fireProactive 被静默时段 / 日上限 / 形状守卫挡下（返回 false）时也照扣 ——
//   他一个字都没说出口，想念却被释放了。
//   代价在凌晨最明显：静默 8 小时里每个 tick（5min）都触发一次 contact、
//   每次扣 0.35，c 被逐 tick 归零，"攒了一夜"的手感被抹平，醒来时状态是空的。
//
// 正确语义：投出去才释放（sent === true），且与 mark('contact') 同进同出。
//
// 为什么必须是跨进程：三道闸（inQuietHours / checkDailyLimit / assertBlockShape）
//   全在 fireProactive 内部，而 bridge.js 一 require 就起服务，单测拿不到。
//
// 三段：
//   A 日上限未用 → contact 真投出 → **释放**（-0.35）
//   B 日上限已用尽 → contact 被挡 → **不释放**（本次修复的核心）
//   C 源码断言 —— 不看运气，直接确认调用落在 `if (sent)` 块内
// ════════════════════════════════════════════════════

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(__dirname, '.run-contact');
if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true });

const UP_PORT = 19811;
const LLM_PORT = 19812;
const BRIDGE_PORT = 19813;
const STATE = path.join(TMP, 'state.json');
const LOG = path.join(TMP, 'bridge.log');
const TOKEN = 'test-token-at-least-24-chars-abcdef';
const H = { authorization: 'Bearer ' + TOKEN, 'x-serein-window-id': 'operit' };

for (const f of [STATE, LOG]) { try { fs.unlinkSync(f); } catch (_) {} }

const upstream = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
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
    // connection 取正向 +0.15（「她敷衍」那一档）：唯一能真的把 c 推上去的方向。
    res.end(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ pride: -0.05, valence: 0.05, arousal: 0, connection: 0.15 }) } }],
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

// 落盘是 1s 去抖（scheduleFlush），读盘前必须等过这一拍。
async function readConn() {
  await wait(1200);
  return JSON.parse(fs.readFileSync(STATE, 'utf8')).connection;
}
function readLog() { try { return fs.readFileSync(LOG, 'utf8'); } catch (_) { return ''; } }

(async () => {
  await new Promise((r) => upstream.listen(UP_PORT, '127.0.0.1', r));
  await new Promise((r) => llm.listen(LLM_PORT, '127.0.0.1', r));

  const ENV_PATH = path.join(ROOT, '.env');
  let envBackup = null;
  try { if (fs.existsSync(ENV_PATH)) envBackup = fs.readFileSync(ENV_PATH, 'utf8'); } catch (_) {}

  const env = [
    `BRIDGE_PORT=${BRIDGE_PORT}`,
    'BRIDGE_HOST=127.0.0.1',
    `BRIDGE_TOKEN=${TOKEN}`,
    `UPSTREAM_BASE=http://127.0.0.1:${UP_PORT}`,
    'UPSTREAM_TOKEN=upstream-key-xyz',
    `LLM_BASE=http://127.0.0.1:${LLM_PORT}/v1`,
    'LLM_KEY=test-llm-key',
    'LLM_MODEL=agnes-3.0-flash',
    `STATE_FILE=${STATE.replace(/\\/g, '/')}`,
    `LOG_FILE=${LOG.replace(/\\/g, '/')}`,
    // tick 压到 3 秒：contact 要能在断言窗口内真的被触发。
    // 引擎漂移因此变得极小（0.05 分钟/次），不干扰 c 的断言。
    'TICK_MINUTES=0.05',
    'INJECT_THROTTLE_SECONDS=0',
    'PROACTIVE_ENABLED=true',
    // 日上限 1 = 只允许投出一次：正好把「投出」与「被挡」两支一次测完。
    'PROACTIVE_MAX_PER_DAY=1',
    'ACTION_COOLDOWN_MINUTES=0',
    // 空静默区间（start === end 视为不静默）：保证「投出」这一支可达。
    'QUIET_START=0',
    'QUIET_END=0',
    'MCP_ENABLED=false',
    // 判定器自带限流（默认 20s 一条 + 熔断），连发会被静默拦掉。
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
  check('桥启动（health ok）',
    (await req(BRIDGE_PORT, '/bridge/health')).status === 200);

  const payload = {
    model: 'x',
    messages: [
      { role: 'system', content: '你是 Harlan。' },
      { role: 'user', content: '在忙吗' },
      { role: 'assistant', content: '刚在看书。' },
      { role: 'user', content: '我有点累了' },
    ],
  };

  // 判定器按**末条 user** 指纹去重（工具轮防护），所以每次必须换内容。
  // 3 次 × (+0.15) 正好把 c 从 0 推到 0.45（越过 0.35 考虑线）。
  async function pushConnection(tag) {
    for (let i = 0; i < 3; i++) {
      const p = JSON.parse(JSON.stringify(payload));
      p.messages[3] = { role: 'user', content: `${tag} ${i}` };
      await req(BRIDGE_PORT, '/v1/chat/completions', p, H);
      await wait(500);
    }
  }

  // ── 阶段 A：日上限未用 → 真投出 → 释放 ──
  await pushConnection('阶段A');
  await wait(5000);                        // 跨 1~2 个 tick：contact 必被触发
  const a2 = await readConn();
  check('A1 contact 真投出（日上限 1 未用）→ connection 被释放回低位（<0.20）',
    a2 < 0.20, 'connection=' + a2);
  const logA = readLog();
  check('A2 日志出现 SEND（证明确实投出去了）', /\[SEND\]/.test(logA));
  check('A3 本阶段无 daily limit 拦截（证明走的是「投出」分支）',
    !/blocked by daily limit/.test(logA));
  check('A4 判定器被喂过（delta 是这条路推的，不是兜底）', llmCalled >= 3, 'calls=' + llmCalled);

  // ── 阶段 B：日上限已用尽 → 被挡 → **不许**释放（本次修复的核心）──
  await pushConnection('阶段B');            // c: ~0.10 → ~0.55
  await wait(5000);                        // 跨 1~2 个 tick：contact 必被触发、必被挡
  const b2 = await readConn();
  check('B1 contact 被日上限挡下 → connection **不**被释放（旧行为会掉 0.35）',
    b2 >= 0.45, 'connection=' + b2);
  const logB = readLog();
  check('B2 日志出现 daily limit 拦截（证明真的走了被挡分支）',
    /blocked by daily limit/.test(logB));
  check('B3 全程只投出一次（日上限 1 生效）',
    (logB.match(/\[SEND\]/g) || []).length === 1,
    'SEND=' + (logB.match(/\[SEND\]/g) || []).length);

  child.kill('SIGTERM');
  await wait(400);
  upstream.close(); llm.close();

  // ── 阶段 C：源码断言（防回退）──
  // 上面两条依赖"tick 恰好触发"，理论上会被环境抖动影响；这里不看运气。
  const src = fs.readFileSync(path.join(ROOT, 'bridge.js'), 'utf8');
  const seg = (() => {
    const i = src.indexOf("if (t.action === 'contact')");
    const j = src.indexOf("} else if (t.action === 'find_activity')", i);
    return (i < 0 || j < 0) ? '' : src.slice(i, j);
  })();
  check('C1 能定位到 contact 分支', seg.length > 0, 'len=' + seg.length);
  // 滤掉注释行：注释里也写着 -0.35，别让它冒充代码。
  const code = seg.split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
  const hits = (code.match(/applyDelta\(\{\s*connection:\s*-0\.35\s*\}\)/g) || []).length;
  check('C2 contact 分支里 applyDelta(-0.35) 只出现一处', hits === 1, 'hits=' + hits);

  // 取 `if (sent) {` 的整个块，确认调用落在块**内**（不只是"在它后面"）。
  const sentBlock = (() => {
    const s = code.indexOf('if (sent)');
    if (s < 0) return '';
    const b = code.indexOf('{', s);
    if (b < 0) return '';
    let depth = 0, out = '';
    for (let i = b; i < code.length; i++) {
      const ch = code[i];
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) break; }
      out += ch;
    }
    return out;
  })();
  check('C3 applyDelta 落在 if (sent) 的块内（受投递闸门保护）',
    /applyDelta\(\{\s*connection:\s*-0\.35\s*\}\)/.test(sentBlock));
  check('C4 冷却记账与缓解同进同出（都在这一个块里）',
    /actionCooldown\.mark\('contact'\)/.test(sentBlock));
  check('C5 注释写明了这条约束（防后人挪回去）',
    /没说出口\s*=\s*没释放/.test(seg));

  // ── 恢复 / 清理 .env ──
  try {
    if (envBackup !== null) fs.writeFileSync(ENV_PATH, envBackup, 'utf8');
    else fs.unlinkSync(ENV_PATH);
  } catch (_) { /* 忽略 */ }

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n  ${pass}/${results.length} 通过`);
  fs.writeFileSync(path.join(TMP, 'result.json'),
    JSON.stringify({ results, pass, total: results.length, bootLog }, null, 2));
  process.exit(pass === results.length ? 0 : 1);
})().catch((e) => { console.error('TEST CRASH', e); process.exit(2); });
