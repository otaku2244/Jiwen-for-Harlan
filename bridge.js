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
const { spawn } = require('child_process');
const { URL } = require('url');

const { createJiwen } = require('./vendor/jiwen.js');
const { createToneGrid } = require('./vendor/tone-grid.js');
const { createToneWrapper } = require('./lib/tone-wrap.js');
const { buildInjectionBlock, buildProactiveNotice, stripJiwenBlocks, assertBlockShape } = require('./lib/inject-text.js');
const { createLoopbackGuard } = require('./lib/loopback.js');
const { analyzeDialog } = require('./lib/analyzer.js');
const { loadEnvFile } = require('./lib/env.js');
const { createMcpHandler } = require('./lib/mcp.js');
const { createClock } = require('./lib/clock.js');

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
  // 业务时区偏移（小时）。静默时段与日上限都按这个时区判定。
  // 服务器系统时区是 UTC，若不设此项，QUIET_START=0/QUIET_END=8 会变成
  // 「UTC 0-8 点静默」＝北京时间 8:00-16:00 静默，恰好把白天当成了夜里。
  tzOffsetHours: parseInt(process.env.TZ_OFFSET_HOURS || '8', 10),
  mcpEnabled: (process.env.MCP_ENABLED || 'true') !== 'false',
  mcpPath: process.env.MCP_PATH || '/mcp',

  // ── 自由冲浪（surf）──────────────────────────────────────────────
  // find_activity 越阈 → 先查静默时段/日上限 → 再 spawn 一次 surf。
  // 闸门必须在 spawn **之前**：先跑再判等于白烧一次模型钱，且"没开口也算了缓解"。
  surfEnabled: (process.env.SURF_ENABLED || 'false') === 'true',
  surfDir: process.env.SURF_DIR || '/root/proactive-web-surf-agent/v2',
  surfEntry: process.env.SURF_ENTRY || 'dist/index.js',
  surfTimeoutMs: parseInt(process.env.SURF_TIMEOUT_MS || '180000', 10),
  surfFindingPath: process.env.SURF_FINDING_PATH || '/surf/finding',
};

// ── 时间（业务时区）──────────────────────────────
// 日志时间戳一律走 toISOString()（UTC，ISO 8601 标准，排查无歧义）；
// 只有「静默时段」「日上限跨天」这类业务判断才用业务时区。
// 换算逻辑在 lib/clock.js，便于单测（可注入任意时间戳）。
const clock = createClock(CFG.tzOffsetHours);

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
let PROACTIVE_OUTLET = {};
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
  PROACTIVE_OUTLET = toneCfg.proactiveOutlet || {};
  log('INFO', 'tone grid loaded: tone-harlan.json (with contact-override wrapper)');
} catch (e) {
  log('ERROR', 'tone grid load failed, falling back to defaults: ' + e.message);
  toneGrid = createToneWrapper(createToneGrid());
}

// ── 回环守卫 ──────────────────────────────────────
// 记住自己发出去的主动唤醒通知，供请求侧的 claim() 认领。
// 详见 lib/loopback.js 顶部注释。
const loopbackGuard = createLoopbackGuard();

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
    // ⚠️ 必须剥掉积温块再入队。
    //    积温块是拼进 user 正文的，不剥就等于让判定器读自己上一轮的输出，
    //    形成"状态 → 文本 → 判定器 → 状态"的自我锚定闭环。
    text = stripJiwenBlocks(text);
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
const server = http.createServer((req, res) => {  const u = new URL(req.url, 'http://localhost');

  // ⚠️ Node 默认 requestTimeout=300s，会在 5 分钟后掐断 MCP 的 SSE 长连接。
  //    心跳（25s 一次）能保活，但服务端这个硬超时是另一回事，必须关掉。
  //    这里对所有请求放宽到 0（不超时）；聊天转发是短请求，不受影响。
  req.setTimeout(0);
  if (res.setTimeout) res.setTimeout(0);

  // 健康检查
  if (u.pathname === '/bridge/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', engine: 'jiwen-bridge', version: '1.0.0' }));
    return;
  }

  // 鉴权
  const auth = req.headers['authorization'] || '';
  const given = auth.replace(/^Bearer\s+/i, '');
  const authOk = !CFG.token || given === CFG.token;
  if (!authOk) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'unauthorized' } }));
    return;
  }

  // 收集请求体
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    let bodyBuf = Buffer.concat(chunks);

    // ── 自由冲浪产物回投（surf → 桥 → 自留地）──
    // surf 不自己投递：回环认领表、静默时段、日上限都只在桥进程里，
    // 绕过桥直接写自留地会同时踩这三个坑。
    if (u.pathname === CFG.surfFindingPath) {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'method not allowed' } }));
        return;
      }
      let payload;
      try {
        payload = JSON.parse(bodyBuf.toString('utf8') || '{}');
      } catch (e) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'bad json' } }));
        return;
      }
      try {
        const ok = payload.ok !== false;
        const failure = ok ? null
          : ('刚才想去翻点东西，没翻成（' + String(payload.error || '原因不明').slice(0, 120) + '）。');
        const finding = ok ? {
          title: payload.title, url: payload.url, image: payload.image, note: payload.note,
        } : null;
        const st = await jiwen.getState();
        const notice = buildProactiveNotice(st, toneGrid, {
          scene: 'find_activity', reason: 'surf', finding, failure,
        }, SCENE_OVERRIDE, PROACTIVE_OUTLET);
        await fireProactive(notice, st, { scene: 'find_activity', reason: 'surf' });
        log('INFO', 'surf finding received' + (ok ? '' : ' (failure branch)'));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'accepted' }));
      } catch (e) {
        log('ERROR', 'surf finding failed: ' + e.message);
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: e.message } }));
      }
      return;
    }

    // ── MCP 端点（Streamable HTTP）──
    // 与聊天转发互不干扰：只认这一个路径，其余原样走代理逻辑。
    if (mcp && u.pathname === CFG.mcpPath) {
      try {
        await mcp.handleHttp(req, res, bodyBuf, true);
      } catch (e) {
        log('ERROR', 'mcp handler failed: ' + e.message);
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' });
        }
        res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'internal error' } }));
      }
      return;
    }

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

    // ── 0. 回环识别：这条是不是桥自己发出去的主动唤醒通知？──
    //   通知经 Operit 工作流包装成 user 消息回流，桥若不识别会把它当成"她开口了"。
    //   识别到就说明她一个字都没说，只是一个系统侧回环。
    const loopback = loopbackGuard.claim(extractLastUserText(body));

    // ── 1. 用户开口 → resetConnection（只有真人开口才触发）──
    if (!loopback) {
      try {
        await jiwen.resetConnection();
      } catch (e) { log('WARN', 'resetConnection failed: ' + e.message); }
    }

    // ── 2. 取状态 → 生成此刻块 ──
    let state = {};
    let block = '';
    try {
      state = await jiwen.getState();
      block = buildInjectionBlock(state, toneGrid);
    } catch (e) {
      log('WARN', 'build block failed: ' + e.message);
    }

    // ── 3. 判定器输入：必须在注入之前取 ──
    //   injectIntoBody 会直接改写最后一条 user 消息；若先注入再取，
    //   判定器读到的就是"这份积温块 + 她的真话"，等于拿自己的输出喂自己。
    const dialog = extractRecentDialog(body, 4);

    // ── 3b. 跨系统契约守卫（与 Serein 的切割线）──
    //   积温块一旦成型，Serein 见到【积温·X】就进跳过态，**只有末行尾标记能让它出来**。
    //   末行不对（改了措辞没同步 Serein / 块被截断）→ 紧随其后的她的原话被整段吞掉。
    //   所以：形状不合规就宁可不注入，也不能发出去。
    if (block) {
      const shapeProblems = assertBlockShape(block);
      if (shapeProblems.length) {
        log('ERROR', 'block shape invalid, injection skipped: ' + shapeProblems.join(' | '));
        block = '';
      }
    }

    // ── 4. 注入（带节流）──
    //   ⚠️ 回环命中时**必须让位**，不要注入。
    //
    //   回环这一轮的 user 消息就是 Operit 原样投递的「主动唤醒通知」，
    //   那份通知自带：档位行 + proactive 正文 + 出口说明 + 尾句 —— 内容是齐的。
    //   而此刻块是 **reactive 语域**（tone-harlan.json 的 reactive 列里明写
    //   「她一开口…」「她终于回话了…」），回环时她一个字都没说；再叠上去
    //   就是两个相反语域互相打架，且档位行还是**衰减前 / 衰减后**两份快照
    //   （fireProactive 投递后立刻 applyDelta({connection:-0.35})）。
    //   实测对照见 `_test/dump_loopback_collision.js`。
    let injected = false;
    if (block && !loopback && shouldInject(block, state)) {
      const r = injectIntoBody(body, block);
      body = r.body;
      injected = r.injected;
    }
    const outBuf = Buffer.from(JSON.stringify(body), 'utf8');

    // n= 是该通知已被认领的次数：1 = 唤醒轮只有一次请求；
    // >1 = 这一轮模型调了工具，Operit 复用同一 messages 又发了请求（正常，不是异常）。
    const loopTag = loopback
      ? ` LOOPBACK=${loopback.scene} age=${Math.round((Date.now() - loopback.at) / 1000)}s n=${loopback.claims}`
      : '';
    const skipTag = (block && loopback) ? ' SKIP_INJECT=loopback' : '';
    log('INFO', `inject=${injected} win=${req.headers['x-serein-window-id'] || 'main'}${loopTag}${skipTag} | ${jiwen.getStateSummary()}`);

    // ── 5. 异步喂判定器（不阻塞转发；仅真人开口才喂）──
    if (!loopback && dialog.length >= 2 && CFG.llmKey) {
      setImmediate(() => {
        analyzeDialog(dialog, { ...CFG, log }).then((delta) => {
          if (delta) {
            jiwen.applyDelta(delta).catch((e) => log('WARN', 'applyDelta failed: ' + e.message));
            log('INFO', 'delta applied: ' + JSON.stringify(delta));
          }
        }).catch((e) => log('WARN', 'analyzer failed: ' + e.message));
      });
    }

    // ── 6. 转发 ──
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
        const notice = buildProactiveNotice(st, toneGrid, { scene: 'contact' }, SCENE_OVERRIDE, PROACTIVE_OUTLET);
        await fireProactive(notice, st, { scene: 'contact' });
        // 开口 ≠ 被回复：部分缓解
        await jiwen.applyDelta({ connection: -0.35 });
      } else if (t.action === 'find_activity') {
        // 桥不碰"活动"本身：不发英文活动枚举、不调 setActivity。
        // 只投一条独处通知，具体做什么由 Operit 侧工作流与模型自理。
        //
        // 场景统一为 find_activity，reason（pride_block / low_valence / high_arousal）
        // 只作排查线索，不再分叉成独立 scene。
        // 理由：引擎侧这三个 reason 的 action 都是 'find_activity'，
        // 语义上都是"回头去找点事做"，投递目标（独处窗口）本就该一致。
        //
        // ── 有 surf 能力时改走"伸触手"路径 ──
        // 闸门必须在 spawn **之前**：先跑再判等于白烧一次模型钱。
        // 跑完的结果由 surf 回投 /surf/finding，那条路径再拼块 + fireProactive。
        if (CFG.surfEnabled) {
          if (inQuietHours()) {
            log('INFO', `surf blocked by quiet hours (local_hour=${clock.localHour()}, quiet=${CFG.quietStart}-${CFG.quietEnd})`);
            continue;
          }
          if (!checkDailyLimit()) {
            log('INFO', 'surf blocked by daily limit');
            continue;
          }
          spawnSurf(t.reason);
          continue;
        }
        const notice = buildProactiveNotice(st, toneGrid, { scene: 'find_activity', reason: t.reason }, SCENE_OVERRIDE, PROACTIVE_OUTLET);
        await fireProactive(notice, st, { scene: 'find_activity', reason: t.reason });
      }
    }
  } catch (e) {
    log('ERROR', 'tick failed: ' + e.message);
  }
}

// 日上限计数（跨天按业务时区，不是 UTC）
let sendCountToday = 0;
let sendDay = '';
function checkDailyLimit() {
  const today = clock.localDateStr();
  if (today !== sendDay) { sendDay = today; sendCountToday = 0; }
  return sendCountToday < CFG.proactiveMaxPerDay;
}
function inQuietHours() {
  return clock.inQuietHours(null, CFG.quietStart, CFG.quietEnd);
}

// ── 自由冲浪：spawn surf 进程一次 ────────────────────────
// 闸门（静默时段 / 日上限）由调用方在 spawn **之前**判过，这里不重复判。
// 结果不在这里处理：surf 跑完会 POST 回 /surf/finding，那条路径负责拼块与投递。
// surf 自己也失败时（进程崩、超时）什么都不回 —— 由这里打印兜底日志。
let surfInFlight = false;
function spawnSurf(reason) {
  if (surfInFlight) { log('INFO', 'surf already in flight, skip'); return; }
  const entry = path.join(CFG.surfDir, CFG.surfEntry);
  if (!fs.existsSync(entry)) {
    log('ERROR', `surf entry not found: ${entry} (SURF_DIR/SURF_ENTRY 配错?)`);
    return;
  }
  surfInFlight = true;
  log('INFO', `surf spawning (reason=${reason || 'unknown'}, entry=${entry})`);
  const child = spawn(process.execPath, [entry, '--once'], {
    cwd: CFG.surfDir,
    // 关键：surf 必须走 jiwen 通道回投，且不能自主排期（那是 --once 保证的）。
    env: {
      ...process.env,
      AUTO_SCHEDULE: 'false',
      DELIVERY_CHANNEL: 'jiwen',
      JIWEN_BASE_URL: `http://127.0.0.1:${CFG.port}`,
      JIWEN_TOKEN: CFG.token,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  const cap = (buf) => { out += buf.toString('utf8'); if (out.length > 8000) out = out.slice(-8000); };
  child.stdout.on('data', cap);
  child.stderr.on('data', cap);
  const timer = setTimeout(() => {
    log('ERROR', `surf timeout after ${CFG.surfTimeoutMs}ms, killing pid ${child.pid}`);
    try { child.kill('SIGKILL'); } catch (_) { /* 已退出 */ }
  }, CFG.surfTimeoutMs);
  child.on('error', (e) => {
    clearTimeout(timer);
    surfInFlight = false;
    log('ERROR', 'surf spawn failed: ' + e.message);
  });
  child.on('close', (code, signal) => {
    clearTimeout(timer);
    surfInFlight = false;
    log('INFO', `surf exited (code=${code}, signal=${signal || 'none'})`);
    if (out.trim()) log('INFO', 'surf output:\n' + out.trim());
  });
}

async function fireProactive(notice, state, meta) {
  if (inQuietHours()) {
    log('INFO', `proactive blocked by quiet hours (local_hour=${clock.localHour()}, quiet=${CFG.quietStart}-${CFG.quietEnd})`);
    return;
  }
  if (!checkDailyLimit()) { log('INFO', 'proactive blocked by daily limit'); return; }

  // 同样的跨系统契约：通知最终会经 Operit 落进对话、再回流到 Serein 的归档路径。
  // 末行不对 → 它后面她的话会被整段吞掉。形状不合规就不发。
  const shapeProblems = assertBlockShape(notice);
  if (shapeProblems.length) {
    log('ERROR', 'proactive notice shape invalid, not sent: ' + shapeProblems.join(' | '));
    return;
  }

  sendCountToday++;
  log('SEND', 'proactive notice:\n' + notice);

  // ── 回环登记：这条通知回流时，请求侧的 claim() 要靠它认出"她没有开口" ──
  // 必须在任何投递之前登记，否则投递快于登记就会出现认领不到的窗口。
  loopbackGuard.remember({
    scene: (meta && meta.scene) || 'contact',
    reason: (meta && meta.reason) || null,
    notice,
  });

  // ── 投递路径 1：MCP 队列（Operit 定时来拉）──
  // VPS 敲不开手机的门，所以主路径是"拉"：入队，等 Operit 调 get_pending_notice 取走。
  if (CFG.mcpEnabled && mcp) {
    mcp.pushNotice({
      scene: (meta && meta.scene) || 'contact',
      reason: (meta && meta.reason) || null,
      at: new Date().toISOString(),
      notice,
      stateSummary: jiwen.getStateSummary(),
    });
    log('INFO', `proactive queued for MCP pull (pending=${mcp.pendingCount()})`);
  }

  // ── 投递路径 2（可选）：webhook 直推 ──
  // 仅在用户确认 Operit 有对外 POST 入口时才配 PROACTIVE_WEBHOOK。
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

// ── MCP 服务（给 Operit 工作流"拉"通知用）─────────
const mcp = CFG.mcpEnabled ? createMcpHandler({
  getSummary: () => jiwen.getStateSummary(),
  getState: () => jiwen.getState(),
  getTrace: () => jiwen.getTriggerTrace(),
  explain: () => jiwen.explainTrigger(),
  getRuntimeInfo: () => ({
    proactive_enabled: CFG.proactiveEnabled,
    in_quiet_hours: inQuietHours(),
    quiet_range: [CFG.quietStart, CFG.quietEnd],
    local_hour: clock.localHour(),
    tz_offset_hours: CFG.tzOffsetHours,
    sent_today: sendCountToday,
    daily_limit: CFG.proactiveMaxPerDay,
    inject_enabled: CFG.injectEnabled,
    tick_minutes: CFG.tickMinutes,
  }),
  log,
}) : null;

// ── 启动 ──────────────────────────────────────────
(async () => {
  await jiwen.load();
  const st = await jiwen.getState();
  log('INFO', `jiwen loaded: ${jiwen.getStateSummary()}`);

  server.listen(CFG.port, CFG.host, () => {
    log('INFO', `bridge listening on ${CFG.host}:${CFG.port} → ${CFG.upstreamBase}`);
    log('INFO', `inject=${CFG.injectEnabled} proactive=${CFG.proactiveEnabled} tick=${CFG.tickMinutes}min`);
    if (mcp) log('INFO', `MCP endpoint: http://${CFG.host}:${CFG.port}${CFG.mcpPath} (Streamable HTTP, 3 tools)`);
  });
  // SSE 长连接需要无限期保持；HTTP 层其余超时对短请求无意义。
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.keepAliveTimeout = 0;
  server.timeout = 0;

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
