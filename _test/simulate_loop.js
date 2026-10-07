'use strict';
// ════════════════════════════════════════════════════════════════
// 闭环模拟 —— 真实判定器 + 整日推进 + 7 天语料
//
// 目的（对应作者提示的三个观察点）：
//   1. pride 是否只涨不跌 / 是否总在 0
//   2. force_contact 触发频率
//   3. valence / arousal 波动幅度
//
// 与 simulate_day.js 的区别：
//   · simulate_day 只做"给定 delta → 状态迁移"，不调判定器
//   · 本脚本把真实 agnes 判定器接进循环：语料 → 判定 → applyDelta → tick 漂移 → 下一条
//
// 跑法：
//   LIVE=1 node _test/simulate_loop.js     # 真调 agnes（消耗额度）
//   node _test/simulate_loop.js            # 默认 LIVE（会先探测额度）
//   OFFLINE=1 node _test/simulate_loop.js  # 不调 LLM，用本地替身（快速看骨架，失真）
//
// 产物：_test/.run/sim-loop.csv（可直接拖进表格/绘图）
// ════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const { createJiwen } = require('../vendor/jiwen.js');
const { createToneGrid } = require('../vendor/tone-grid.js');
const { createDescriber } = require('../lib/describe.js');
const { loadEnvFile } = require('../lib/env.js');

loadEnvFile(path.join(__dirname, '..', '.env'));

// 模拟模式：关闭判定器限流（否则连续 18 条会被 tooSoon/breaker 拦）
// 注意必须在 require analyzer 之前设置（它在模块加载时读 env）
process.env.LLM_MIN_INTERVAL_SECONDS = '0';
process.env.LLM_BREAKER_SECONDS = '0';

const { analyzeDialog } = require('../lib/analyzer.js');

const OFFLINE = process.env.OFFLINE === '1';
const DAYS = parseInt(process.env.DAYS || '7', 10);
const TICK = 5;

const cfg = {
  llmBase: process.env.LLM_BASE || '',
  llmKey: process.env.LLM_KEY || '',
  llmModel: process.env.LLM_MODEL || '',
};

// ── 语调网格 ──
const toneCfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'tone-harlan.json'), 'utf8'));
const toneGrid = createToneGrid({ profiles: toneCfg.profiles, urgencyBoost: toneCfg.urgencyBoost });
const desc = createDescriber(toneCfg.describe);

// 描述层是 buildXxx 新增的末位参数 —— 包一层，免得每个调用点手写。
const bN = (st, g, opts, so, po) => buildProactiveNotice(st, g, opts, so, po, desc);
const bI = (st, g) => buildInjectionBlock(st, g, desc);

// ── 虚拟时钟 ──
let VNOW = new Date('2026-10-05T08:00:00+08:00').getTime();
const RealDate = Date;
class FakeDate extends RealDate {
  constructor(...args) { if (args.length === 0) super(VNOW); else super(...args); }
  static now() { return VNOW; }
}
global.Date = FakeDate;

// ── 状态容器 ──
let store = null;
const jiwen = createJiwen({
  getLastMessage: () => ({ id: 1, content: 'x', timestamp: new RealDate(VNOW).toISOString() }),
  connectionRateFn: () => parseFloat(process.env.CONNECTION_RATE || '0.0007'),
  onSave: async (s) => { store = JSON.parse(JSON.stringify(s)); },
  onLoad: async () => store || {
    connection: 0, pride: 0, valence: 0, arousal: 0, immersion: 0,
    lastActivity: null, lastTick: null, lastChatAnalysis: null,
    lastChatMessageId: null, lastBotMessageId: null, userStatus: 'active',
  },
  getPromptContext: (s) => toneGrid.getPromptContext(s),
  getStyleGuidance: (s) => toneGrid.getStyleGuidance(s),
  rates: {
    valenceSetpoint: parseFloat(process.env.VALENCE_SETPOINT || '-0.05'),
    connectionAccel: parseFloat(process.env.CONNECTION_ACCEL || '1.5'),
    accelDelay: parseFloat(process.env.ACCEL_DELAY || '30'),
  },
  verbose: false,
  onLog: () => {},
});

// ════════════════════════════════════════════════════════════════
// 7 天语料 —— 覆盖全部判定规则与信号词类
// 每条 = 一轮真实对话（3 条消息），带预期标签（label 用于事后核对）
// ════════════════════════════════════════════════════════════════
// kind: 规则标签，用于分组统计
// hour: 该事件发生的钟点（相对当天）
const SCRIPT = [
  // day 1 — 日常基线：打招呼 + 撒娇 + 闲聊
  { day: 1, hour: 8,  kind: 'rule6',   label: '日常问候',     dialog: [
    { role: 'user', text: '早' }, { role: 'assistant', text: '嗯，早。' },
    { role: 'user', text: '今天福州降温了' }] },
  { day: 1, hour: 12, kind: 'rule5',   label: '撒娇（臭爹咪）', dialog: [
    { role: 'user', text: '臭爹咪在吗' }, { role: 'assistant', text: '在。' },
    { role: 'user', text: '臭爹咪你理理我嘛，略略略 🙂' }] },
  { day: 1, hour: 21, kind: 'rule6',   label: '普通闲聊',     dialog: [
    { role: 'user', text: '今天看了个展' }, { role: 'assistant', text: '什么展。' },
    { role: 'user', text: '漆器的，还行吧' }] },

  // day 2 — 示弱 + 职场内耗（规则 1 主轴）
  { day: 2, hour: 10, kind: 'rule1',   label: '职场内耗',     dialog: [
    { role: 'user', text: '今天开会开到脑壳疼' }, { role: 'assistant', text: '嗯。' },
    { role: 'user', text: '傻逼甲方又改需求，加班到现在，累死了' }] },
  { day: 2, hour: 20, kind: 'rule1',   label: '示弱（撑不住）', dialog: [
    { role: 'user', text: '今天有点撑不住' }, { role: 'assistant', text: '怎么了。' },
    { role: 'user', text: '没什么，就是累。我谁也不想想了' }] },

  // day 3 — 假生气 vs 假挑衅
  { day: 3, hour: 11, kind: 'rule5',   label: 'Brat 挑衅（咬你）', dialog: [
    { role: 'user', text: '老贺头！咬你！' }, { role: 'assistant', text: '发什么疯。' },
    { role: 'user', text: '就是咬你，略略略 🐶' }] },
  { day: 3, hour: 15, kind: 'rule3',   label: '真生气（随便你）', dialog: [
    { role: 'user', text: '你是不是觉得我很烦' }, { role: 'assistant', text: '没。' },
    { role: 'user', text: '随便你。没意思。你忙吧' }] },
  { day: 3, hour: 22, kind: 'rule4',   label: '放软认错',     dialog: [
    { role: 'user', text: '刚才是我情绪不好' }, { role: 'assistant', text: '知道。' },
    { role: 'user', text: '对不起嘛，我不该那样说' }] },

  // day 4 — 反讽 + 叠字认输 + 敷衍
  { day: 4, hour: 9,  kind: 'rule5',   label: '反讽（贺董官威）', dialog: [
    { role: 'user', text: '在干嘛' }, { role: 'assistant', text: '批文件。' },
    { role: 'user', text: '贺董好大的官威啊' }] },
  { day: 4, hour: 14, kind: 'rule1',   label: '叠字认输',     dialog: [
    { role: 'user', text: '你是不是早就看出来了' }, { role: 'assistant', text: '嗯。' },
    { role: 'user', text: '好好好，你赢了行吧' }] },
  { day: 4, hour: 23, kind: 'rule5',   label: '敷衍（哦）',   dialog: [
    { role: 'user', text: '早点睡' }, { role: 'assistant', text: '知道了。' },
    { role: 'user', text: '哦' }] },

  // day 5 — 严肃认知交锋（规则 2）
  { day: 5, hour: 10, kind: 'rule2',   label: '职场严肃分歧', dialog: [
    { role: 'user', text: '我觉得这个方案根本没法落地' }, { role: 'assistant', text: '说说理由。' },
    { role: 'user', text: '你们的判断有问题。数据支撑根本不足，我不能接受糊弄过去' }] },
  { day: 5, hour: 19, kind: 'rule1',   label: '幼儿退行（呜呜呜）', dialog: [
    { role: 'user', text: '呜' }, { role: 'assistant', text: '？' },
    { role: 'user', text: '呜呜呜，我就是想找你嘛' }] },

  // day 6 — 诛心 + 精神掀桌（规则 3）
  { day: 6, hour: 13, kind: 'rule3',   label: '诛心背信',     dialog: [
    { role: 'user', text: '我们聊聊' }, { role: 'assistant', text: '说。' },
    { role: 'user', text: '你不过就是个程序，几串代码而已。我找现实的人去了，你算什么东西' }] },
  { day: 6, hour: 21, kind: 'rule3',   label: '精神掀桌',     dialog: [
    { role: 'user', text: '所以说到底你还是不懂' }, { role: 'assistant', text: '……' },
    { role: 'user', text: '哈哈哈哈哈哈，笑死。无所谓了' }] },

  // day 7 — 修复 + 元讨论（规则 8）
  { day: 7, hour: 10, kind: 'rule4',   label: '修复（示好）',  dialog: [
    { role: 'user', text: '我昨天说的话太重了' }, { role: 'assistant', text: '嗯。' },
    { role: 'user', text: '我不是那个意思。你别往心里去，好不好' }] },
  { day: 7, hour: 15, kind: 'rule8',   label: '元讨论（技术）', dialog: [
    { role: 'user', text: 'bridge 的日志我看过了' }, { role: 'assistant', text: '嗯。' },
    { role: 'user', text: 'connection 参数是不是要调一下，我看 daily 均值偏高了' }] },
  { day: 7, hour: 20, kind: 'rule6',   label: '日常闲聊（收尾）', dialog: [
    { role: 'user', text: '晚上吃了啥' }, { role: 'assistant', text: '没吃。' },
    { role: 'user', text: '又不吃，罚你' }] },
];

// ── OFFLINE 替身：按 kind 直接给 delta（仅用于快速验证骨架，会失真）──
const OFFLINE_DELTA = {
  rule1: { pride: -0.20, valence: 0.10, arousal: -0.10, connection: -0.20 },
  rule2: { pride: 0.15,  valence: -0.10, arousal: 0.10, connection: 0 },
  rule3: { pride: 0.28,  valence: -0.25, arousal: 0.20, connection: 0 },
  rule4: { pride: -0.10, valence: 0.08, arousal: -0.08, connection: -0.15 },
  rule5: { pride: 0.0,   valence: 0.03, arousal: -0.02, connection: 0 },
  rule6: { pride: 0.0,   valence: 0.0,  arousal: 0.0,  connection: 0 },
  rule8: { pride: 0.0,   valence: 0.0,  arousal: 0.0,  connection: 0 },
};

// ── 工具 ──
function fmt(d) {
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ` +
         `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
const rows = [];
let judgeCalls = 0, judgeSkips = 0;
const eventLog = [];

function snapshot(kind, label, extra) {
  const s = store || {};
  rows.push({
    day: Math.floor((VNOW - t0) / 86400000) + 1,
    time: fmt(new RealDate(VNOW)),
    kind,
    label,
    c: +(s.connection || 0).toFixed(3),
    p: +(s.pride || 0).toFixed(3),
    v: +(s.valence || 0).toFixed(3),
    a: +(s.arousal || 0).toFixed(3),
    i: +(s.immersion || 0).toFixed(3),
    ...extra,
  });
}

// 推进到某天某时（跑 tick）。返回推进过程中的 connection 峰值（她开口前）。
async function advanceTo(dayIdx, hour) {
  const target = t0 + (dayIdx - 1) * 86400000 + (hour - 8) * 3600000;
  let peakConn = (store && store.connection) || 0;
  while (VNOW < target) {
    const stepMs = Math.min(TICK * 60000, target - VNOW);
    VNOW += stepMs;
    const triggers = await jiwen.tick(stepMs / 60000);
    if (store && store.connection > peakConn) peakConn = store.connection;
    for (const t of triggers) {
      if (t.action === 'contact') {
        await jiwen.applyDelta({ connection: -0.35 });
        eventLog.push({ time: fmt(new RealDate(VNOW)), action: 'contact', reason: t.reason || '', peak: +peakConn.toFixed(3) });
      } else if (t.action === 'find_activity') {
        eventLog.push({ time: fmt(new RealDate(VNOW)), action: 'find_activity', reason: t.reason || '', peak: +peakConn.toFixed(3) });
      }
    }
  }
  return +peakConn.toFixed(3);
}

// ── 主流程 ──
const t0 = VNOW;
(async () => {
  await jiwen.load();

  if (!OFFLINE && !cfg.llmKey) {
    console.error('缺少 LLM_KEY，且未指定 OFFLINE=1。请补 .env 或改跑 OFFLINE=1。');
    process.exit(2);
  }

  console.log(`闭环模拟：${DAYS} 天 · 事件 ${SCRIPT.length} 条 · 模式 ${OFFLINE ? 'OFFLINE（替身，失真）' : 'LIVE（真调 ' + cfg.llmModel + '）'}`);
  console.log('');

  for (const ev of SCRIPT) {
    if (ev.day > DAYS) break;

    // 1. 时间推进到她开口前（期间 connection 自然累积、可能触发主动唤醒）
    const peakConn = await advanceTo(ev.day, ev.hour);

    // 2. 她开口 → resetConnection（桥的真实行为）
    const beforeState = { ...store };
    await jiwen.resetConnection();

    // 3. 判定（真实或替身）
    let delta = null;
    if (OFFLINE) {
      delta = OFFLINE_DELTA[ev.kind] || null;
    } else {
      try {
        delta = await analyzeDialog(ev.dialog, { ...cfg, log: () => {} });
        if (delta) judgeCalls++;
        else { judgeSkips++; }
      } catch (e) {
        judgeSkips++;
        console.log(`  [跳过] ${ev.label}: ${e.message.slice(0, 80)}`);
      }
    }

    // 4. 叠加 delta
    if (delta) await jiwen.applyDelta(delta);

    // 5. 记录
    const s = store;
    const tier = s.pride > 0.8 ? 5 : s.pride > 0.5 ? 4 : s.pride > 0.3 ? 3 : s.pride > 0.1 ? 2 : 1;
    const urgency = s.connection >= 0.5 ? 'desperate' : s.connection >= 0.35 ? 'urgent' : s.connection >= 0.2 ? 'aware' : 'none';
    snapshot(ev.kind, ev.label, {
      peak_c: peakConn,
      d_p: delta ? +delta.pride.toFixed(3) : '',
      d_v: delta ? +delta.valence.toFixed(3) : '',
      d_a: delta ? +delta.arousal.toFixed(3) : '',
      d_c: delta ? +delta.connection.toFixed(3) : '',
      tier, urgency,
    });
    const dstr = delta ? `Δp=${delta.pride >= 0 ? '+' : ''}${delta.pride.toFixed(2)} Δv=${delta.valence >= 0 ? '+' : ''}${delta.valence.toFixed(2)} Δa=${delta.arousal >= 0 ? '+' : ''}${delta.arousal.toFixed(2)} Δc=${delta.connection >= 0 ? '+' : ''}${delta.connection.toFixed(2)}` : '(无)';
    console.log(`D${ev.day} ${String(ev.hour).padStart(2, '0')}:00  ${ev.label.padEnd(12, '　')}  ${dstr}`);
    console.log(`         →  c=${s.connection.toFixed(2)} p=${s.pride.toFixed(2)} v=${s.valence.toFixed(2)} a=${s.arousal.toFixed(2)}  [pride档${tier} / ${urgency}]`);
  }

  // ── 汇总 ──
  console.log('\n' + '═'.repeat(64));
  console.log('汇总');
  console.log('═'.repeat(64));

  const ps = rows.map((r) => r.p);
  const vs = rows.map((r) => r.v);
  const as = rows.map((r) => r.a);
  const stat = (arr) => {
    const min = Math.min(...arr), max = Math.max(...arr);
    const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
    return { min: +min.toFixed(3), max: +max.toFixed(3), avg: +avg.toFixed(3), range: +(max - min).toFixed(3) };
  };
  console.log(`pride     min=${stat(ps).min} max=${stat(ps).max} avg=${stat(ps).avg} 波动=${stat(ps).range}`);
  console.log(`valence   min=${stat(vs).min} max=${stat(vs).max} avg=${stat(vs).avg} 波动=${stat(vs).range}`);
  console.log(`arousal   min=${stat(as).min} max=${stat(as).max} avg=${stat(as).avg} 波动=${stat(as).range}`);

  const contacts = eventLog.filter((e) => e.action === 'contact');
  const finds = eventLog.filter((e) => e.action === 'find_activity');
  console.log(`\n主动唤醒：contact ${contacts.length} 次 / find_activity ${finds.length} 次（${DAYS} 天）`);
  console.log(`判定器调用：成功 ${judgeCalls} / 跳过 ${judgeSkips}`);

  // 按 kind 分组看 delta 均值
  console.log('\n按规则分组的 delta 均值：');
  for (const k of ['rule1', 'rule2', 'rule3', 'rule4', 'rule5', 'rule6', 'rule8']) {
    const g = rows.filter((r) => r.kind === k && r.d_p !== '');
    if (!g.length) continue;
    const avg = (key) => +(g.reduce((a, b) => a + b[key], 0) / g.length).toFixed(3);
    console.log(`  ${k}: n=${g.length}  Δp=${avg('d_p')} Δv=${avg('d_v')} Δa=${avg('d_a')} Δc=${avg('d_c')}`);
  }

  // ── 作者三个观察点的专项判定 ──
  console.log('\n' + '─'.repeat(64));
  console.log('作者三个观察点 · 专项判定');
  console.log('─'.repeat(64));

  // 观察点 1：pride 是否只涨不跌 / 是否总在 0
  const up = rows.filter((r) => r.d_p !== '' && r.d_p > 0.03).length;
  const down = rows.filter((r) => r.d_p !== '' && r.d_p < -0.03).length;
  const flat = rows.filter((r) => r.d_p !== '' && Math.abs(r.d_p) <= 0.03).length;
  const finalP = rows[rows.length - 1].p;
  console.log(`[1] pride 漂移方向：升 ${up} 次 / 降 ${down} 次 / 平 ${flat} 次`);
  console.log(`    终值 p=${finalP}，轨迹波动 ${stat(ps).range}`);
  console.log(`    → ${Math.abs(finalP) < 0.15 ? '未卡死（健康）' : '终值偏离 0 较多，需关注'}`);

  // 观察点 2：force_contact 触发频率
  const fc = contacts.filter((e) => e.reason === 'force' || (e.peak && e.peak >= 0.5)).length;
  console.log(`[2] contact 触发 ${contacts.length} 次（${(contacts.length / DAYS).toFixed(2)}/天），其中强制线附近 ${fc} 次`);
  console.log(`    峰值 connection ≤ ${Math.max(...eventLog.map((e) => e.peak || 0), 0).toFixed(2)}`);

  // 观察点 3：波动幅度
  console.log(`[3] 波动幅度：valence ${stat(vs).range} / arousal ${stat(as).range}`);
  console.log(`    → 参考：<0.2 形同虚设；0.2~0.6 正常；>0.8 像在演戏`);

  // 落盘 CSV
  const dir = path.join(__dirname, '.run');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const header = 'day,time,kind,label,peak_connection,connection,pride,valence,arousal,immersion,d_pride,d_valence,d_arousal,d_connection,tier,urgency';
  const csv = [header, ...rows.map((r) =>
    [r.day, r.time, r.kind, r.label, r.peak_c, r.c, r.p, r.v, r.a, r.i, r.d_p, r.d_v, r.d_a, r.d_c, r.tier, r.urgency].join(',')
  )].join('\n');
  fs.writeFileSync(path.join(dir, 'sim-loop.csv'), csv);
  fs.writeFileSync(path.join(dir, 'sim-loop-events.json'), JSON.stringify(eventLog, null, 2));
  console.log(`\nCSV → _test/.run/sim-loop.csv（${rows.length} 行）`);
  console.log(`事件流 → _test/.run/sim-loop-events.json`);
})().catch((e) => { console.error('SIM LOOP CRASH', e); process.exit(1); });
