'use strict';
// ════════════════════════════════════════════════════
// find_activity 可达性扫描
//
// 背景：线上「0 次 find_activity」。原因不是部署，是引擎里通往 find_activity
//      的四条路，作者默认全用**哨兵值关掉了**（opt-in 设计），桥一个都没开：
//        · prideBlock 路径  ← prideDefendThreshold = 1.0（=永不）
//        · low_valence 路径 ← valenceActivity = -1.0（=永不）
//        · high_arousal 路径 ← arousalAgitation = 0.7（开着，但日常到不了）
//        · 辅助（想念久了心情下沉）← valenceConnectionDriftRate = 0（关）
//
// 本脚本扫"开哪个、开多大"，能落到日均 2 次。
//
// 跑法：node _test/scan_activity.js
// ════════════════════════════════════════════════════

const { createJiwen } = require('../vendor/jiwen.js');

// ── 虚拟时钟 ──
let VNOW = new Date('2026-10-05T00:00:00+08:00').getTime();
const RealDate = Date;
class FakeDate extends RealDate {
  constructor(...a) { if (a.length === 0) super(VNOW); else super(...a); }
  static now() { return VNOW; }
}
Date = FakeDate;

const DAYS = 30;
const TICK = 5;
const DAY_MIN = 24 * 60;
const RATE = 0.0007;           // 与桥 .env CONNECTION_RATE 一致
const ACCEL = 1.5;
const DELAY = 30;

const configs = [
  { name: '① 现状（桥只传 3 项 rates）' },
  { name: '② +pride防御 thr=0.20 rate=0.003' , rates: { prideDefendThreshold: 0.20 } },
  { name: '③ +pride防御 thr=0.20 rate=0.004', rates: { prideDefendThreshold: 0.20, prideDefendRate: 0.004 } },
  { name: '④ ③ + 同场景冷却 180min', rates: { prideDefendThreshold: 0.20, prideDefendRate: 0.004 }, cooldown: 180 },
  { name: '⑤ ③ + 触发后 connection-0.10', rates: { prideDefendThreshold: 0.20, prideDefendRate: 0.004 }, relief: 0.10 },
  { name: '⑥ ④ 且 prideBlock 降到 0.45', rates: { prideDefendThreshold: 0.20, prideDefendRate: 0.004 }, thresholds: { prideBlock: 0.45 }, cooldown: 180 },
];

// 她的出现模式（决定 connection 能不能攒起来）
const PATTERNS = [
  { name: '来2次/日', fn: (m) => (m >= 480 && m < 490) || (m >= 1200 && m < 1210) },
  { name: '来1次/日', fn: (m) => (m >= 480 && m < 490) },
  { name: '整日不来', fn: () => false },
];

async function runOne(cfg, patternFn) {
  let store = null;
  let lastMsgAt = VNOW;
  const j = createJiwen({
    getLastMessage: () => ({ id: 1, content: 'x', timestamp: new RealDate(lastMsgAt).toISOString() }),
    connectionRateFn: () => RATE,
    onSave: async (s) => { store = JSON.parse(JSON.stringify(s)); },
    onLoad: async () => store || {
      connection: 0, pride: 0, valence: 0, arousal: 0, immersion: 0,
      lastActivity: null, lastTick: null, lastChatAnalysis: null,
      lastChatMessageId: null, lastBotMessageId: null, userStatus: 'active',
    },
    rates: Object.assign({ valenceSetpoint: -0.05, connectionAccel: ACCEL, accelDelay: DELAY }, cfg.rates || {}),
    thresholds: cfg.thresholds || {},
    onLog: () => {},     // 静音：本脚本只看汇总，逐 tick 流水会淹没结论
  });
  await j.load();

  let lastFireAt = -Infinity;   // find_activity 上次真正投递时刻
  let totalC = 0, totalF = 0, rawF = 0, rawC = 0;

  for (let d = 0; d < DAYS; d++) {
    for (let m = 0; m < DAY_MIN; m += TICK) {
      VNOW += TICK * 60 * 1000;
      if (patternFn(m)) { await j.applyDelta({ connection: -0.35 }); lastMsgAt = VNOW; continue; }

      const trig = await j.tick(TICK);
      for (const t of trig) {
        if (t.action === 'contact') {
          rawC++; totalC++;
          await j.applyDelta({ connection: -0.35 });
        } else if (t.action === 'find_activity') {
          rawF++;                                  // 引擎原始触发次数（含重复）
          const gapMin = (VNOW - lastFireAt) / 60000;
          if (cfg.cooldown && gapMin < cfg.cooldown) continue;
          totalF++; lastFireAt = VNOW;
          if (cfg.relief) await j.applyDelta({ connection: -cfg.relief });
        }
      }
    }
  }
  return { contact: totalC / DAYS, find: totalF / DAYS, rawF: rawF / DAYS, rawC: rawC / DAYS };
}

(async () => {
  console.log(`模拟 ${DAYS} 天 | tick=${TICK}min | r=${RATE} accel=${ACCEL} delay=${DELAY} | 静默时段未计入（本脚本只看引擎）\n`);
  console.log('配置'.padEnd(34) +
    PATTERNS.map((p) => (p.name + ' c/f').padEnd(18)).join('') + '原始触发(c/f)');
  console.log('─'.repeat(100));
  for (const c of configs) {
    let line = c.name.padEnd(34);
    let last = null;
    for (const p of PATTERNS) {
      const r = await runOne(c, p.fn);
      last = r;
      line += (`${r.contact.toFixed(2)} / ${r.find.toFixed(2)}`).padEnd(18);
    }
    line += `${last.rawC.toFixed(1)} / ${last.rawF.toFixed(1)}`;
    console.log(line);
  }
  console.log('\n说明：');
  console.log('  · 「原始触发」= 不做冷却时，一个持续状态里每 tick 都报一次的量级（按"整日不来"场景统计）。');
  console.log('    线上会瞬间打光 PROACTIVE_MAX_PER_DAY，把 contact 一起挤没。');
  console.log('  · 冷却只为把「一个持续状态」折成「一次动作」。');
})().catch((e) => { console.error(e); process.exit(1); });
