#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════
//  jiwen-bridge · 积温注入桥
//
//  定位：Serein 网关前面的一层反向代理。用户在 Operit/OMate 发消息
//        → 桥 → 注入【积温·此刻】块 → Serein → 上游模型。
//
//  设计原则：
//    · Serein 零改动。桥只做转发 + 改写请求体。
//    · 积温引擎不改一行。全部通过 createJiwen(opts) 注入。
//    · 状态全局单实例（不按窗口分）。窗口只影响判定器取哪 4 条历史。
//    · 任何窗口的任何用户消息都触发 resetConnection。
//
//  依赖：只用 Node 内置模块（http/https/fs/path/url）+ vendor 下的积温。
// ════════════════════════════════════════════════════════════════

'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const { createJiwen } = require('./vendor/jiwen.js');
const { createToneGrid } = require('./vendor/tone-grid.js');
const { createToneWrapper } = require('./lib/tone-wrap.js');
const { buildInjectionBlock, buildProactiveNotice } = require('./lib/inject-text.js');
const { analyzeDialog } = require('./lib/analyzer.js');
const { loadEnvFile } = require('./lib/env.js');

// ── 载入 .env（同目录）────────────────────────────
loadEnvFile(path.join(__dirname, '.env'));

const CFG = {
  port: parseInt(process.env.BRIDGE_PORT || '18220', 10),
  host: process.env.BRIDGE_HOST || '0.0.0.0',
  token: process.env.BRIDGE_TOKEN || '',
  upstreamBase: (process.env.UPSTREAM_BASE || 'http://127.0.0.1:18217').replace(/\/$/, ''),
  upstreamToken: process.env.UPSTREAM_TOKEN || '',
  llmBase: (process.env.LLM_BASE || '').replace(/\/$/, ''),
  llmKey: process.env.LLM_KEY || '',
  llmModel: process.env.LLM_MODEL || '',
  stateFile: process.env.STATE_FILE || path.join(__dirname, 'data', 'state.json'),
  logFile: process.env.LOG_FILE || path.join(__dirname, 'data', 'bridge.log'),
  tickMinutes: parseFloat(process.env.TICK_MINUTES || '5'),
  connectionRate: parseFloat(process.env.CONNECTION_RATE || '0.0007'),
  valenceSetpoint: parseFloat(process.env.VALENCE_SETPOINT || '-0.05'),
  connectionAccel: parseFloat(process.env.CONNECTION_ACCEL || '1.5'),
  accelDelay: parseFloat(process.env.ACCEL_DELAY || '30'),
  injectEnabled: (process.env.INJECT_ENABLED || 'true') !== 'false',
  injectThrottleSeconds: parseInt(process.env.INJECT_THROTTLE_SECONDS || '1800', 10),
  proactiveEnabled: (process.env.PROACTIVE_ENABLED || 'true') !== 'false',
  proactiveWebhook: process.env.PROACTIVE_WEBHOOK || '',
  proactiveMaxPerDay: parseInt(process.env.PROACTIVE_MAX_PER_DAY || '6', 10),
  quietStart: parseInt(process.env.QUIET_START || '0', 10),
  quietEnd: parseInt(process.env.QUIET_END || '8', 10),
};

// ── 日志 ──────────────────────────────────────────
function ensureDir(p) {
  const d = path.dirname(p);
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}
function log(level, msg) {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}`;
  console.log(line);
  try {
    ensureDir(CFG.logFile);
    fs.appendFileSync(CFG.logFile, line + '\n');
  } catch (_) { /* 日志失败不阻断主流程 */ }
}

// ── 状态持久化 ────────────────────────────────────
// 中性初值：积温上游 DEFAULT_STATE 用 axes[x][0] 作初值（pride/valence/arousal 都是 -1），
// 那会让角色开局就"糟透了"。这里通过 onLoad 返回中性初值绕过，不改 vendor 源码。
const NEUTRAL_SEED = {
  connection: 0,
  pride: 0,
  valence: 0,
  arousal: 0,
  immersion: 0,
  lastActivity: null,
  lastTick: null,
  lastChatAnalysis: null,
  lastChatMessageId: null,
  lastBotMessageId: null,
  userStatus: 'active',
};

let _stateCache = null;
let _stateDirty = false;

function loadState() {
  try {
    if (fs.existsSync(CFG.stateFile)) {
      const raw = fs.readFileSync(CFG.stateFile, 'utf8');
      const parsed = JSON.parse(raw);
      return { ...NEUTRAL_SEED, ...parsed };
    }
  } catch (e) {
    log('WARN', 'state load failed, using neutral seed: ' + e.message);
  }
  // 首次启动：必须返回中性种子。
  // 积温 vendor 的 onLoad 返回 null 时会保留 DEFAULT_STATE，
  // 而 DEFAULT_STATE 用 axes[x][0] 作初值（pride/valence/arousal 全为 -1），
  // 会让角色开局就是"糟透了"。这里显式给出中性值绕过。
  return { ...NEUTRAL_SEED };
}
function saveState(s) {
  _stateCache = s;
  _stateDirty = true;
}
let _flushTimer = null;
function scheduleFlush() {
  if (_flushTimer) return;
  _flushTimer = setTimeout(() => {
    _flushTimer = null;
    if (!_stateDirty || !_stateCache) return;
    try {
      ensureDir(CFG.stateFile);
      fs.writeFileSync(CFG.stateFile, JSON.stringify(_stateCache, null, 2));
      _stateDirty = false;
    } catch (e) {
      log('ERROR', 'state save failed: ' + e.message);
    }
  }, 1000);
}

// ── 语调网格 ──────────────────────────────────────
let toneGrid = null;
let SCENE_OVERRIDE = {};
try {
  const tonePath = path.join(__dirname, 'config', 'tone-harlan.json');
  const toneCfg = JSON.parse(fs.readFileSync(tonePath, 'utf8'));
  toneGrid = createToneWrapper(
    createToneGrid({
      profiles: toneCfg.profiles,
      urgencyBoost: toneCfg.urgencyBoost,
    }),
    toneCfg.contactOverride
  );
  SCENE_OVERRIDE = toneCfg.sceneOverride || {};
  log('INFO', 'tone grid loaded: tone-harlan.json (with contact-override wrapper)');
} catch (e) {
  log('ERROR', 'tone grid load failed, falling back to defaults: ' + e.message);
  toneGrid = createToneWrapper(createToneGrid());
}

// ── 积温实例（全局唯一）──────────────────────────
const jiwen = createJiwen({
  getLastMessage: () => null, // 桥不依赖此回调，由判定器独立取历史
  connectionRateFn: () => CFG.connectionRate,
  onSave: async (s) => { saveState(s); scheduleFlush(); },
  onLoad: async () => loadState(),
  getPromptContext: (state) => toneGrid.getPromptContext(state),
  getStyleGuidance: (state) => toneGrid.getStyleGuidance(state),
  rates: {
    valenceSetpoint: CFG.valenceSetpoint,
    connectionAccel: CFG.connectionAccel,
    accelDelay: CFG.accelDelay,
  },
  verbose: false,
  onLog: (msg) => log('JIWEN', msg),
});

// ── 注入节流 ──
//
// 为什么不能只比 block 文本：
//   block 是渲染后的档位词（"中性""平静"…），粒度远粗于五轴原值。
//   valence 从 0 漂到 -0.03 仍是"中性"，文本一字不变 → 判为"没变" → 不注入。
//   结果是积温明明在动、模型却看不到，30 分钟内只有第一轮带块。
//
// 所以指纹取**数值**而非文本：五轴各取 2 位小数拼成签名。
//   · 签名变了 → 注入（哪怕渲染文本相同，状态语义已经不同）
//   · 签名没变但超节流窗 → 注入（保持存在感）
let lastInjectSig = null;
let lastInjectAt = 0;
function shouldInject(block, state) {
  const now = Date.now();
  const sig = state
    ? [state.connection, state.pride, state.valence, state.arousal]
        .map((x) => (Number(x) || 0).toFixed(2)).join(',')
    : block;
  const changed = sig !== lastInjectSig;
  const expired = (now - lastInjectAt) > CFG.injectThrottleSeconds * 1000;
  if (changed || expired) {
    lastInjectSig = sig;
    lastInjectAt = now;
    return true;
  }
  return false;
}

// ── 请求体改写：把积温块拼进最后一条 user 消息 ────
function injectIntoBody(body, block) {
  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
    return { body, injected: false };
  }
  // 找最后一条 role === 'user'
  let idx = -1;
  for (let i = body.messages.length - 1; i >= 0; i--) {
    if (body.messages[i] && body.messages[i].role === 'user') { idx = i; break; }
  }
  if (idx === -1) return { body, injected: false };

  const msg = body.messages[idx];
  if (typeof msg.content === 'string') {
    body.messages[idx] = { ...msg, content: block + '\n\n' + msg.content };
  } else if (Array.isArray(msg.content)) {
    // 多模态：在最前面插一个 text part
    body.messages[idx] = { ...msg, content: [{ type: 'text', text: block + '\n' }, ...msg.content] };
  } else {
    return { body, injected: false };
  }
  return { body, injected: true };
}

// ── 提取最后一条用户文本 + 窗口 ID ────────────────
function extractLastUserText(body) {
  if (!body || !Array.isArray(body.messages)) return '';
  for (let i = body.messages.length - 1; i >= 0; i--) {
    const m = body.messages[i];
    if (m && m.role === 'user') {
      if (typeof m.content === 'string') return m.content;
      if (Array.isArray(m.content)) {
        return m.content.filter((p) => p && p.type === 'text').map((p) => p.text).join('\n');
      }
    }
  }
  return '';
}
function extractRecentDialog(body, n) {
  const out = [];
  if (!body || !Array.isArray(body.messages)) return out;
  for (let i = body.messages.length - 1; i >= 0 && out.length < n; i--) {
    const m = body.messages[i];
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    let text = '';
    if (typeof m.content === 'string') text = m.content;
    else if (Array.isArray(m.content)) {
      text = m.content.filter((p) => p && p.type === 'text').map((p) => p.text).join('\n');
    }
    if (!text) continue;
    out.push({ role: m.role, text: text.slice(0, 800) });
  }
  return out.reverse(); // 时间正序
}

// ── 转发到上游 ────────────────────────────────────
function forward(pathname, search, method, headers, bodyBuf, res) {
  const up = new URL(CFG.upstreamBase + pathname + (search || ''));
  const lib = up.protocol === 'https:' ? https : http;

  const outHeaders = { ...headers };
  delete outHeaders['host'];
  delete outHeaders['content-length'];
  delete outHeaders['authorization'];
  // 用 Serein 自己的 Gateway Key 覆盖（Operit 给的是桥的 token）
  if (CFG.upstreamToken) outHeaders['authorization'] = 'Bearer ' + CFG.upstreamToken;
  if (bodyBuf) outHeaders['content-length'] = Buffer.byteLength(bodyBuf);

  const req = lib.request({
    hostname: up.hostname,
    port: up.port || (up.protocol === 'https:' ? 443 : 80),
    path: up.pathname + up.search,
    method,
    headers: outHeaders,
  }, (upRes) => {
    res.writeHead(upRes.statusCode, upRes.headers);
    upRes.pipe(res);
  });

  req.on('error', (e) => {
    log('ERROR', 'upstream error: ' + e.message);
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json' });
    }
    res.end(JSON.stringify({ error: { message: 'bridge upstream unreachable: ' + e.message } }));
  });

  if (bodyBuf) req.write(bodyBuf);
  req.end();
}

// ── 主服务 ────────────────────────────────────────
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');

  // 健康检查
  if (u.pathname === '/bridge/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', engine: 'jiwen-bridge', version: '1.0.0' }));
    return;
  }

  // 鉴权
  const auth = req.headers['authorization'] || '';
  const given = auth.replace(/^Bearer\s+/i, '');
  if (CFG.token && given !== CFG.token) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'unauthorized' } }));
    return;
  }

  // 收集请求体
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    let bodyBuf = Buffer.concat(chunks);

    // 只对 chat completions 类路径做注入
    const isChat = /\/v1\/chat\/completions$/.test(u.pathname) || /\/chat\/completions$/.test(u.pathname);

    if (!isChat || !CFG.injectEnabled || bodyBuf.length === 0) {
      forward(u.pathname, u.search, req.method, req.headers, bodyBuf, res);
      return;
    }

    let body;
    try {
      body = JSON.parse(bodyBuf.toString('utf8'));
    } catch (e) {
      forward(u.pathname, u.search, req.method, req.headers, bodyBuf, res);
      return;
    }

    // ── 1. 用户开口 → resetConnection（任何窗口都触发）──
    try {
      await jiwen.resetConnection();
    } catch (e) { log('WARN', 'resetConnection failed: ' + e.message); }

    // ── 2. 取状态 → 生成此刻块 ──
    let state = {};
    let block = '';
    try {
      state = await jiwen.getState();
      block = buildInjectionBlock(state, toneGrid);
    } catch (e) {
      log('WARN', 'build block failed: ' + e.message);
    }

    // ── 3. 注入（带节流）──
    let injected = false;
    if (block && shouldInject(block, state)) {
      const r = injectIntoBody(body, block);
      body = r.body;
      injected = r.injected;
    }
    const outBuf = Buffer.from(JSON.stringify(body), 'utf8');

    log('INFO', `inject=${injected} win=${req.headers['x-serein-window-id'] || 'main'} | ${jiwen.getStateSummary()}`);

    // ── 4. 异步喂判定器（不阻塞转发）──
    const dialog = extractRecentDialog(body, 4);
    if (dialog.length >= 2 && CFG.llmKey) {
      setImmediate(() => {
        analyzeDialog(dialog, { ...CFG, log }).then((delta) => {
          if (delta) {
            jiwen.applyDelta(delta).catch((e) => log('WARN', 'applyDelta failed: ' + e.message));
            log('INFO', 'delta applied: ' + JSON.stringify(delta));
          }
        }).catch((e) => log('WARN', 'analyzer failed: ' + e.message));
      });
    }

    // ── 5. 转发 ──
    forward(u.pathname, u.search, req.method, req.headers, outBuf, res);
  });
});

// ── 主动唤醒定时器（tick + 阈值触发）──────────────
let tickTimer = null;
let _lastTickLog = 0;
async function tickOnce() {
  try {
    const triggers = await jiwen.tick(CFG.tickMinutes);
    const st = await jiwen.getState();
    // observation 是上游原生的"内心念头"信号，每 tick 都可能触发。
    // 按 Harlan 人设（不碎碎念、不报备），它不投递、也不逐条刷日志；
    // 只在状态摘要变化或发生真正动作时打一条。
    const actionable = triggers.filter((t) => t.action !== 'observation');
    const now = Date.now();
    if (actionable.length || (now - _lastTickLog) > 30 * 60 * 1000) {
      _lastTickLog = now;
      log('TICK', `${CFG.tickMinutes}min | ${jiwen.getStateSummary()}` +
        (actionable.length ? ` | 动作: ${actionable.map((t) => t.action).join(',')}` : ''));
    }
    if (!CFG.proactiveEnabled) return;
    for (const t of actionable) {
      if (t.action === 'contact') {
        const notice = buildProactiveNotice(st, toneGrid, { scene: 'contact' }, SCENE_OVERRIDE);
        await fireProactive(notice, st);
        // 开口 ≠ 被回复：部分缓解
        await jiwen.applyDelta({ connection: -0.35 });
      } else if (t.action === 'find_activity') {
        // 桥不碰"活动"本身：不发英文活动枚举、不调 setActivity。
        // 只投一条自留地通知，具体做什么由 Operit 侧工作流与模型自理。
        // reason 为 high_arousal（arousal 过载的自调节）时换标签，其余（pride_block / low_valence）走自留地。
        const scene = t.reason === 'high_arousal' ? 'high_arousal' : 'find_activity';
        const notice = buildProactiveNotice(st, toneGrid, { scene, reason: t.reason }, SCENE_OVERRIDE);
        await fireProactive(notice, st);
      }
    }
  } catch (e) {
    log('ERROR', 'tick failed: ' + e.message);
  }
}

// 日上限计数
let sendCountToday = 0;
let sendDay = '';
function checkDailyLimit() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== sendDay) { sendDay = today; sendCountToday = 0; }
  return sendCountToday < CFG.proactiveMaxPerDay;
}
function inQuietHours() {
  const h = new Date().getHours();
  const { quietStart: s, quietEnd: e } = CFG;
  if (s === e) return false;
  if (s < e) return h >= s && h < e;
  return h >= s || h < e; // 跨午夜
}

async function fireProactive(notice, state) {
  if (inQuietHours()) { log('INFO', 'proactive blocked by quiet hours'); return; }
  if (!checkDailyLimit()) { log('INFO', 'proactive blocked by daily limit'); return; }
  sendCountToday++;
  log('SEND', 'proactive notice:\n' + notice);
  if (!CFG.proactiveWebhook) return;
  try {
    const u = new URL(CFG.proactiveWebhook);
    const lib = u.protocol === 'https:' ? https : http;
    const payload = Buffer.from(JSON.stringify({
      protocol: 'jiwen-wake/1',
      reason: 'proactive',
      message: notice,
      state: { connection: state.connection, pride: state.pride, valence: state.valence, arousal: state.arousal },
    }), 'utf8');
    await new Promise((resolve, reject) => {
      const r = lib.request({
        hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search, method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      }, (resp) => { resp.resume(); resp.on('end', resolve); });
      r.on('error', reject);
      r.write(payload); r.end();
    });
    log('INFO', 'proactive delivered to webhook');
  } catch (e) {
    log('ERROR', 'proactive webhook failed: ' + e.message);
  }
}

// ── 启动 ──────────────────────────────────────────
(async () => {
  await jiwen.load();
  const st = await jiwen.getState();
  log('INFO', `jiwen loaded: ${jiwen.getStateSummary()}`);

  server.listen(CFG.port, CFG.host, () => {
    log('INFO', `bridge listening on ${CFG.host}:${CFG.port} → ${CFG.upstreamBase}`);
    log('INFO', `inject=${CFG.injectEnabled} proactive=${CFG.proactiveEnabled} tick=${CFG.tickMinutes}min`);
  });

  tickTimer = setInterval(tickOnce, CFG.tickMinutes * 60 * 1000);
  if (tickTimer.unref) tickTimer.unref();
})();

process.on('SIGTERM', () => {
  log('INFO', 'SIGTERM received, flushing state');
  try { if (_stateCache) fs.writeFileSync(CFG.stateFile, JSON.stringify(_stateCache, null, 2)); } catch (_) {}
  process.exit(0);
});
process.on('uncaughtException', (e) => log('ERROR', 'uncaught: ' + e.stack));
process.on('unhandledRejection', (e) => log('ERROR', 'unhandled rejection: ' + (e && e.stack ? e.stack : e)));
