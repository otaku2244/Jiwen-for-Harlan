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

const { loadEnvFile } = require('./lib/env.js');

// ── 载入 .env（同目录）────────────────────────────
// ⚠️ 必须排在其他 lib 的 require **之前**。
//    有些 lib 在**模块顶层**读 process.env 并算成常量 ——
//    例如 analyzer.js 的 `LLM_MIN_INTERVAL_SECONDS` / `LLM_BREAKER_SECONDS`
//    是模块级 const，require 那一刻就求值完。loadEnvFile 若晚一步，
//    .env 里这两项**静默失效**（线上写了也白写，永远走默认 20s/300s）。
const envPath = require('path').join(__dirname, '.env');
loadEnvFile(envPath);

const { createJiwen } = require('./vendor/jiwen.js');
const { createToneGrid } = require('./vendor/tone-grid.js');
const { createDescriber } = require('./lib/describe.js');
const { buildInjectionBlock, buildProactiveNotice, stripJiwenBlocks, assertBlockShape } = require('./lib/inject-text.js');
const { createLoopbackGuard } = require('./lib/loopback.js');
const { recordActivity } = require('./lib/activity.js');
const { createSceneCooldown, createDialogDedup } = require('./lib/repeat-guard.js');
const { analyzeDialog } = require('./lib/analyzer.js');
const { createMcpHandler } = require('./lib/mcp.js');
const { createClock } = require('./lib/clock.js');

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
  // 兜底：判定器**没跑成**时，「她开口」这一轮记一次的 connection 缓解量。
  // 判定正常时不需要它 —— 那时降幅由 delta 里的 connection 分量承担（作者设计）。
  // 量级取 0.35，与唤醒投递后的释放同一档（「一次开口事件释放掉 0.35」）。
  connectionRelief: parseFloat(process.env.CONNECTION_RELIEF || '0.35'),
  valenceSetpoint: parseFloat(process.env.VALENCE_SETPOINT || '-0.05'),
  connectionAccel: parseFloat(process.env.CONNECTION_ACCEL || '1.5'),
  accelDelay: parseFloat(process.env.ACCEL_DELAY || '30'),
  injectEnabled: (process.env.INJECT_ENABLED || 'true') !== 'false',
  injectThrottleSeconds: parseInt(process.env.INJECT_THROTTLE_SECONDS || '1800', 10),
  proactiveEnabled: (process.env.PROACTIVE_ENABLED || 'true') !== 'false',
  proactiveWebhook: process.env.PROACTIVE_WEBHOOK || '',
  // 日上限：contact 与 find_activity **共用**同一个计数（见 checkDailyLimit）。
  // 默认 8 是配合 find_activity 上线后的量级：她整日不出现时实测 contact 4.3 + find 4.3
  // ≈ 8.6 次/日；留在 6 会把 find_activity 挤到 2 次以下，达不到"至少 2 次"。
  proactiveMaxPerDay: parseInt(process.env.PROACTIVE_MAX_PER_DAY || '8', 10),
  quietStart: parseInt(process.env.QUIET_START || '0', 10),
  quietEnd: parseInt(process.env.QUIET_END || '8', 10),
  // 业务时区偏移（小时）。静默时段与日上限都按这个时区判定。
  // 服务器系统时区是 UTC，若不设此项，QUIET_START=0/QUIET_END=8 会变成
  // 「UTC 0-8 点静默」＝北京时间 8:00-16:00 静默，恰好把白天当成了夜里。
  tzOffsetHours: parseInt(process.env.TZ_OFFSET_HOURS || '8', 10),
  mcpEnabled: (process.env.MCP_ENABLED || 'true') !== 'false',
  mcpPath: process.env.MCP_PATH || '/mcp',

  // ── 重复抑制（见 lib/repeat-guard.js）────────────────────────────
  // 同场景冷却：一个**持续状态**不该每 tick 都报一次。
  // 0 = 关闭。只作用于触发侧（tick），不拦 surf 回投的产物。
  actionCooldownMinutes: parseFloat(process.env.ACTION_COOLDOWN_MINUTES || '180'),
  // 判定器去重窗口：工具轮里同一段对话只喂一次。0 = 关闭。
  analyzeDedupSeconds: parseInt(process.env.ANALYZE_DEDUP_SECONDS || '900', 10),

  // ── 骄傲防御：激活 find_activity 的 pride_block 通道 ──────────────
  // vendor 默认 prideDefendThreshold = 1.0，是"永不触发"的哨兵值（connection 上限就是 1）
  // → pride 永远不会因冷落升到 prideBlock(0.5) → find_activity 全天 0 次。
  // 0.20 = observation 线，语义正好是"开始留意她，嘴硬就跟着升温"。
  prideDefendThreshold: parseFloat(process.env.PRIDE_DEFEND_THRESHOLD || '0.20'),
  // vendor 默认 0.003 在 c∈[0.35,0.50) 的窗口里涨不到 0.5（实测差 0.05），
  // 必须 ≥0.004 才能在窗口关闭（c 越过强制线）之前把 pride 顶上去。见 _test/scan_activity.js。
  prideDefendRate: parseFloat(process.env.PRIDE_DEFEND_RATE || '0.004'),

  // ── 低情绪自我调节通道：find_activity 的第二入口（2026-10-09）──────
  // find_activity 有两条独立入口：
  //   ① 「嘴硬」 c∈[0.35,0.50) 且 pride≥0.5（pride_block）
  //   ② 「心情低」valence ≤ valenceActivity 且 immersion<0.3（low_valence）
  // ② **完全不看 connection**（vendor/jiwen.js:507）。
  //
  // vendor 把 ② 的阈值默认成 -1.0（永不触发），于是 find_activity 只能靠 ①。
  // 而 ① 要求 pride 长期顶格 0.5 —— 实测她整日不出现时，pride≥0.5 占醒着的
  // **80%** 时间，描述层第 2 段被钉死在同一档（文案不流动）。
  //
  // 打开 ② 之后冲浪改由「心情低 + 一个人」驱动，与 connection / pride 解耦：
  // pride 交还给判定器 → 描述层恢复流动；c 也不再被 pride 绑架。
  //
  // ⚠️ 阈值必须 **≥ valenceSetpoint** 才会常态成立（同一个坐标系里的两个数，
  //    改一个必须回头看另一个）。默认 -0.04 比 setpoint(-0.05) 高 0.01。
  valenceActivityThreshold: parseFloat(process.env.VALENCE_ACTIVITY_THRESHOLD || '-1.0'),
  // vendor 原生的「做事情能部分缓解连接需求」（默认 0 = 关）。
  // 打开后每次冲浪把 connection 往下压一点 → contact 被自然抑制，
  // 「冲浪多于找你」不必再靠 pride 顶格来实现。
  // ⚠️ vendor 只在**活动类型变化**时才扣（同类型连续冲浪不重复扣），
  //    且有 0.01 下限（防止清零导致阈值永不触达）。
  activityConnectionRelief: parseFloat(process.env.ACTIVITY_CONNECTION_RELIEF || '0'),

  // ── 自由冲浪（surf）──────────────────────────────────────────────
  // find_activity 越阈 → 先查静默时段/日上限 → 再 spawn 一次 surf。
  // 闸门必须在 spawn **之前**：先跑再判等于白烧一次模型钱，且"没开口也算了缓解"。
  surfEnabled: (process.env.SURF_ENABLED || 'false') === 'true',
  surfDir: process.env.SURF_DIR || '/root/proactive-web-surf-agent/v2',
  surfEntry: process.env.SURF_ENTRY || 'dist/index.js',
  // surf 子进程用哪个 node 跑。**不能用 process.execPath** —— 桥自己是被
  // systemd 拉起来的，那个 node 未必是 surf 需要的那个（surf 是 TS 编译产物，
  // 带自己的 node_modules）。2026-10-08 在 VPS 上热修过，此处补回版本库。
  surfNodeBin: process.env.SURF_NODE_BIN || '/usr/local/bin/node',
  surfTimeoutMs: parseInt(process.env.SURF_TIMEOUT_MS || '180000', 10),
  surfFindingPath: process.env.SURF_FINDING_PATH || '/surf/finding',
  // ── 活动登记（描述层段4 的真来源）─────────────────────────────
  // `type` 决定 immersion 取多少（vendor 的 immersionMap：search = 0.4），
  // `label` 是**唯一会进模型可见文本**的那一项（lib/describe.js 的 `{label}`）。
  // 所以 label 写中文短语、type 写引擎认得的英文枚举，两者别混。
  //
  // ⚠️ label 说的是**动作**，措辞要跟 `lib/inject-text.js` 的 FINDING_HEAD（结果）
  //    错开维度：「上网冲浪」（动作）→「搜到了一条有意思的内容：」（结果）。
  //    label 建的是"那个部署在做的事" —— 当前 find_activity 唯一的真实行动就是
  //    VPS 上的 `proactive-web-surf-agent`（`CFG.surfDir`）。将来接了别的
  //    action/接口，各自用自己的 label 与自己的产物头，别回头改描述层。
  surfActivityType: process.env.SURF_ACTIVITY_TYPE || 'search',
  surfActivityLabel: process.env.SURF_ACTIVITY_LABEL || '上网冲浪',
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

// ── 语调网格 + 描述层 ──────────────────────────────
// 2026-10-08 起不再有 `lib/tone-wrap.js` 覆盖层：它会在 connection 过线时
// 把整条 45 格顶掉，「找她」块里 45 格一个字都出不来。那件事现在归描述层管。
let toneGrid = null;
let describer = null;
let SCENE_OVERRIDE = {};
let PROACTIVE_OUTLET = {};
try {
  const tonePath = path.join(__dirname, 'config', 'tone-harlan.json');
  const toneCfg = JSON.parse(fs.readFileSync(tonePath, 'utf8'));
  toneGrid = createToneGrid({
    profiles: toneCfg.profiles,
    // ⚠️ 必须显式传：config 里四档全 null = 关掉 urgency 行。
    //    不传的话 vendor 会回落到内置 DEFAULT_URGENCY（作者文案，风格不符）。
    urgencyBoost: toneCfg.urgencyBoost,
  });
  describer = createDescriber(toneCfg.describe);
  SCENE_OVERRIDE = toneCfg.sceneOverride || {};
  PROACTIVE_OUTLET = toneCfg.proactiveOutlet || {};
  log('INFO', 'tone grid loaded: tone-harlan.json (45 格 + 描述层，无覆盖层)');
} catch (e) {
  log('ERROR', 'tone grid load failed, falling back to defaults: ' + e.message);
  toneGrid = createToneGrid();
}

// ── 回环守卫 ──────────────────────────────────────
// 记住自己发出去的主动唤醒通知，供请求侧的 claim() 认领。
// 详见 lib/loopback.js 顶部注释。
const loopbackGuard = createLoopbackGuard();

// ── 重复抑制 ──────────────────────────────────────
// 冷却：一个持续状态别每 tick 报一次（find_activity 的常驻触发源）。
// 去重：工具轮里 Operit 复用同一份 messages，同一段对话只该喂判定器一次。
const actionCooldown = createSceneCooldown({ minutes: CFG.actionCooldownMinutes });
const dialogDedup = createDialogDedup({ windowSeconds: CFG.analyzeDedupSeconds });
// 去重跳过的日志只在同一轮打一次（工具可能连发多次请求）
let _lastDedupSkipKey = null;

// 「她开口」的 connection 缓解兜底（2026-10-08）。
// 只在**判定器没能给出 delta**时用：没配 key / 对话太短 / 返回空 / 报错。
// 判定成功时不许调 —— 那时降幅已经在 delta 的 connection 分量里，
// 再补一次就是重复扣减。
function replyRelief(reason) {
  jiwen.applyDelta({ connection: -CFG.connectionRelief })
    .then(() => log('INFO', `reply relief: -${CFG.connectionRelief} (${reason})`))
    .catch((e) => log('WARN', 'reply relief failed: ' + e.message));
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
    // 骄傲防御：vendor 默认是"永不"的哨兵值，必须显式打开
    // （否则 pride 升不到 prideBlock → find_activity 永不触发）。
    prideDefendThreshold: CFG.prideDefendThreshold,
    prideDefendRate: CFG.prideDefendRate,
    // 活动缓解：冲浪本身会压低 connection（vendor 原生，默认 0=关）
    activityConnectionRelief: CFG.activityConnectionRelief,
  },
  thresholds: {
    // 低情绪自我调节通道的阈值（≥ valenceSetpoint 才会常态成立）
    valenceActivity: CFG.valenceActivityThreshold,
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
//
// ⚠️ `immersion` 必须在内。自 2026-10-08 起它也是**块文本的一部分**
//    （描述层段4 读它）：冲浪跑完 → immersion 0.4，段4 从「没在做什么特别的事。」
//    变成「刚才在上网冲浪。」，而另外四轴可能一个数都没动。
//    漏掉它 = 段4 的变化被节流吃掉，模型只看到旧那句。
let lastInjectSig = null;
let lastInjectAt = 0;
function shouldInject(block, state) {
  const now = Date.now();
  const sig = state
    ? [state.connection, state.pride, state.valence, state.arousal, state.immersion]
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

// ── 判定器的轮次指纹：最后一条 user 的文本 ──────────
// 工具轮里 Operit 复用同一份 messages 再发一次请求，这条一字未变；
// 真出现新的一轮（她说了新话）它必变。用它挡掉重复判定，见 lib/repeat-guard.js。
function dialogKeyOf(dialog) {
  for (let i = dialog.length - 1; i >= 0; i--) {
    if (dialog[i] && dialog[i].role === 'user') return String(dialog[i].text || '').trim().slice(0, 400);
  }
  return '';
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
        // 失败句只交代**结果**，不说动作 —— 动作由描述层段4（「刚才在上网冲浪。」）承担。
        // 旧写法「刚才想去翻点东西，没翻成（…）。」与段4 撞了两处：都带"刚才"、
        // 且"想去"（打算）与"在上网"（正在做）自相矛盾。
        const failure = ok ? null
          : ('没翻出什么合适的（' + String(payload.error || '原因不明').slice(0, 120) + '）。');
        const finding = ok ? {
          title: payload.title, url: payload.url, image: payload.image, note: payload.note,
        } : null;
        // 冲浪刚跑完 → 刷新活动时间戳，让段4 说的是「刚才在上网冲浪。」
        // 而不是"半小时前"。失败分支照样记：他确实去冲了，只是没翻到东西。
        await recordActivity(jiwen, {
          type: CFG.surfActivityType, label: CFG.surfActivityLabel,
        }, log);
        const st = await jiwen.getState();
        const notice = buildProactiveNotice(st, toneGrid, {
          scene: 'find_activity', reason: 'surf', finding, failure,
        }, SCENE_OVERRIDE, PROACTIVE_OUTLET, describer);
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

    // ── 1. 她开口 → **不重置** connection（2026-10-08 撤掉 resetConnection）──
    //
    //   作者原设计：对方回复带来的 connection 降幅，由 LLM 读这轮对话内容决定，
    //   不是"回复即归零"。
    //     vendor/jiwen.js:41   connectionOnReply 已标 [已弃用]「现由 LLM delta 接管」
    //     vendor/jiwen.js:277  「连接需求降幅现由外部 LLM 分析…通过 applyDelta 注入」
    //
    //   桥原先在这里调 resetConnection()（= state.connection 硬置 0）。两处损害：
    //     ① 把她"开口但敷衍"这个中间态一起抹掉 —— 敷衍本该让 c 上升；
    //     ② 建块与 applyDelta 都发生在归零之后 → clamp(0 + 负, 0, 1) 恒 0，
    //        判定器的 connection 维**一个字都落不下来**（负向全废、正向封顶 0.15）。
    //
    //   撤掉之后 connection 完全由「判定器 delta + tick 漂移」驱动。
    //   判定没跑成的情形（无 key / 对话太短 / 返回空 / 报错）在 §5 兜底一顿缓解 ——
    //   否则她明明在说话、c 却只涨不降，会被误判成"她很久没来"而乱触发唤醒。

    // ── 2. 取状态 → 生成此刻块 ──
    let state = {};
    let block = '';
    try {
      state = await jiwen.getState();
      block = buildInjectionBlock(state, toneGrid, describer);
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
    // ⚠️ 必须按"轮次"去重：模型调工具后 Operit 会用同一份 messages 再发一次请求，
    //    此时末 4 条 user/assistant 一字未变 → 判定器会把同一段对话判 N 次，
    //    delta 叠加 N 次。（2026-10-07 实测同一轮判 4 次：pride 该掉 0.12 实际掉 0.66。）
    //    原先靠 LLM_MIN_INTERVAL_SECONDS=20 挡，但工具轮间隔 33~49 秒，全部放行。
    //
    // ── 和 connection 的关系（2026-10-08 撤 reset 之后）──
    //   判定器**跑成了** → connection 的降幅就在 delta 里，不再兜底。
    //   被 dedup 跳过的工具轮 → 同一轮已经判过、delta 已经生效 → 也不兜底。
    //   其余全是"她开口了但没人判" → replyRelief() 补一顿固定缓解。
    let connectionHandled = false;
    if (!loopback && dialog.length >= 2 && CFG.llmKey) {
      const dialogKey = dialogKeyOf(dialog);
      if (!dialogDedup.accept(dialogKey)) {
        connectionHandled = true; // 同一轮：前一次已经判过
        // 同一轮只提示一次（工具可能连发多次）
        if (dialogKey !== _lastDedupSkipKey) {
          _lastDedupSkipKey = dialogKey;
          log('INFO', 'analyzer skipped: dialog not advanced (tool turn, same last user msg)');
        }
      } else {
        _lastDedupSkipKey = null;
        connectionHandled = true;
        setImmediate(() => {
          analyzeDialog(dialog, { ...CFG, log }).then((delta) => {
            if (delta) {
              jiwen.applyDelta(delta).catch((e) => log('WARN', 'applyDelta failed: ' + e.message));
              log('INFO', 'delta applied: ' + JSON.stringify(delta));
            } else {
              replyRelief('analyzer returned empty');
            }
          }).catch((e) => {
            log('WARN', 'analyzer failed: ' + e.message);
            replyRelief('analyzer failed');
          });
        });
      }
    }
    if (!loopback && !connectionHandled) replyRelief('not analyzed');

    // ── 6. 转发 ──
    forward(u.pathname, u.search, req.method, req.headers, outBuf, res);
  });
});

// ── 主动唤醒定时器（tick + 阈值触发）──────────────
let tickTimer = null;
let _lastTickLog = 0;

// 冷却跳过日志：一个持续状态会连续几十个 tick 都被挡，
// 每 tick 打一条等于自己刷屏。同一场景每小时最多一条。
const _cdLogAt = Object.create(null);
function logCooldownSkip(scene) {
  const now = Date.now();
  if (_cdLogAt[scene] && (now - _cdLogAt[scene]) < 60 * 60 * 1000) return;
  _cdLogAt[scene] = now;
  log('INFO', `SKIP_ACTION=${scene} cooldown active (left ${Math.ceil(actionCooldown.remainingMinutes(scene))}min)`);
}
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
        // 冷却：contact 天然不重复（触发后 connection 归零），但"她整日不来"时
        // 一天能触发 4 次以上，统一纳管避免与 find_activity 抢日上限时失去约束。
        if (!actionCooldown.ok('contact')) { logCooldownSkip('contact'); continue; }
        const notice = buildProactiveNotice(st, toneGrid, { scene: 'contact' }, SCENE_OVERRIDE, PROACTIVE_OUTLET, describer);
        const sent = await fireProactive(notice, st, { scene: 'contact' });
        // ⚠️ 只有**真投出去**才记账、才缓解。两者必须同进同出。
        //
        // 2026-10-09 修：此前缓解无条件执行，被静默时段/日上限/形状守卫挡下的
        // 轮次也照扣 -0.35 —— 他一个字都没说出口，想念却被释放了。代价在凌晨
        // 最明显：静默 8 小时里每个 tick 都触发 contact、每个 tick 扣一次，
        // c 被逐 tick 归零，"攒了一夜"的手感被抹平，醒来时状态是空的。
        // 正确语义：没说出口 = 没释放，c 继续攒着（静默解除后第一个 tick 就找他，
        // 且日上限会自然约束频次）。
        //
        // 注：这里的 0.35 是**开口缓解**，与 replyRelief() 的 CONNECTION_RELIEF
        // 是两支互不重叠的路径（那个管"判定器没跑成"）。别合并成一个键。
        if (sent) {
          actionCooldown.mark('contact');
          // 开口 ≠ 被回复：部分缓解（原语义）
          await jiwen.applyDelta({ connection: -0.35 });
        }
      } else if (t.action === 'find_activity') {
        // ⚠️ 冷却必须在这里判，且必须在 spawn 之前 ——
        //   find_activity 的触发源是"惦记 + 嘴硬"这个持续状态，
        //   状态不消失时每 tick 都会再判一次；不拦就是 50~110 条/天。
        if (!actionCooldown.ok('find_activity')) { logCooldownSkip('find_activity'); continue; }
        // 关于"桥碰不碰活动"：桥**不**决定他做什么，也不发英文活动枚举 ——
        // 具体做什么由 Operit 侧工作流与模型自理。
        // 唯一的例外是冲浪跑完之后的那一条 `setActivity` —— 那不是"安排活动"，
        // 而是把已经发生的事**如实登记**给引擎，供描述层段4 使用
        // （见 lib/activity.js；登记点挂在子进程的 'spawn' 事件上）。
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
          // spawn 即记账：surf 若超时/崩溃不会有 /surf/finding 回来，
          // 不在这里记就会每个 tick 反复 spawn、反复烧模型钱。
          actionCooldown.mark('find_activity');
          continue;
        }
        const notice = buildProactiveNotice(st, toneGrid, { scene: 'find_activity', reason: t.reason }, SCENE_OVERRIDE, PROACTIVE_OUTLET, describer);
        const sent = await fireProactive(notice, st, { scene: 'find_activity', reason: t.reason });
        if (sent) actionCooldown.mark('find_activity');
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
//
// 副作用：子进程 'spawn' 成功后登记一次活动（immersion = 0.4），
// 描述层段4 因此才有「刚才在上网冲浪。」可讲。见 lib/activity.js。
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
  const child = spawn(CFG.surfNodeBin, [entry, '--once'], {
    cwd: CFG.surfDir,
    // 关键：surf 必须走 jiwen 通道回投，且不能自主排期（那是 --once 保证的）。
    env: {
      ...process.env,
      // 显式覆盖：桥的 .env 里也有 STATE_FILE / LLM_DISABLE_THINKING，
      // 经 ...process.env 传进来会让 surf 侧的 loadDotEnv 静默失效
      //（surf 只在 process.env[key] === undefined 时才赋值）。
      STATE_FILE: path.join(CFG.surfDir, 'data', 'state.json'),
      LLM_DISABLE_THINKING: 'true',
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
  // ── 活动登记：只在进程**真的起来了**之后 ──
  // 用 'spawn' 而不是在函数开头记：entry 路径配错 / EACCES 这类情况下
  // spawn 会走 'error' 而永不 'spawn'，那时他其实什么都没做，
  // 记了就等于让段4 声称一件没发生的事（describe.js：不编造活动）。
  child.on('spawn', () => {
    recordActivity(jiwen, {
      type: CFG.surfActivityType, label: CFG.surfActivityLabel,
    }, log).catch(() => { /* recordActivity 内部已兜底并记日志 */ });
  });
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

// 返回 true = 真的投出去了；false = 被静默时段/日上限/形状守卫挡下。
// 调用方用它决定要不要记冷却账 —— 被挡的轮次不该吃掉冷却。
async function fireProactive(notice, state, meta) {
  if (inQuietHours()) {
    log('INFO', `proactive blocked by quiet hours (local_hour=${clock.localHour()}, quiet=${CFG.quietStart}-${CFG.quietEnd})`);
    return false;
  }
  if (!checkDailyLimit()) { log('INFO', 'proactive blocked by daily limit'); return false; }

  // 同样的跨系统契约：通知最终会经 Operit 落进对话、再回流到 Serein 的归档路径。
  // 末行不对 → 它后面她的话会被整段吞掉。形状不合规就不发。
  const shapeProblems = assertBlockShape(notice);
  if (shapeProblems.length) {
    log('ERROR', 'proactive notice shape invalid, not sent: ' + shapeProblems.join(' | '));
    return false;
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
  if (!CFG.proactiveWebhook) return true;
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
  return true;
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
    // 排查"为什么该有动静却没有"用：冷却期内触发会被静默丢弃。
    action_cooldown_minutes: CFG.actionCooldownMinutes,
    cooldown_left_minutes: {
      contact: Math.ceil(actionCooldown.remainingMinutes('contact')),
      find_activity: Math.ceil(actionCooldown.remainingMinutes('find_activity')),
    },
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
    log('INFO', `inject=${CFG.injectEnabled} proactive=${CFG.proactiveEnabled} tick=${CFG.tickMinutes}min` +
      ` surf=${CFG.surfEnabled ? CFG.surfDir : 'off'}`);
    log('INFO', `proactive: max=${CFG.proactiveMaxPerDay}/day quiet=${CFG.quietStart}-${CFG.quietEnd}` +
      `(tz+${CFG.tzOffsetHours}) cooldown=${CFG.actionCooldownMinutes}min` +
      ` analyzerDedup=${CFG.analyzeDedupSeconds}s`);
    log('INFO', `prideDefend: threshold=${CFG.prideDefendThreshold} rate=${CFG.prideDefendRate}` +
      ` (vendor 默认 1.0/0.003 = find_activity 永不触发)`);
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
