'use strict';
// ════════════════════════════════════════════════════
// 参数扫描 —— 帮你定"一天该主动找她几次"
//
// 跑法：node _test/param_scan.js
// 输出：各组参数下，连续 N 天的日均触发次数、首发时刻分布
// ════════════════════════════════════════════════════

const { createJiwen } = require('../vendor/jiwen.js');

// ── 虚拟时钟（必须，否则 minutesSinceLastMsg 算不准）──
let VNOW = new Date('2026-10-05T00:00:00+08:00').getTime();
const RealDate = Date;
class FakeDate extends RealDate {
  constructor(...args) { if (args.length === 0) super(VNOW); else super(...args); }
  static now() { return VNOW; }
}
Date = FakeDate;

const days = 60;
const DAY_MIN = 24 * 60;

// 可调参数组
// ⚠️ connectionAccel 必须 > 1 才叫"加速"。设成 0.8 反而让增长被 pow 压慢，
//    设成 0 才是纯线性。这是积温的一个参数陷阱。
const configs = [
  { name: '默认 r=0.0007 accel=1.5 delay=30', rate: 0.0007, accel: 1.5, delay: 30 },
  { name: '降速 r=0.0004 accel=1.5 delay=30', rate: 0.0004, accel: 1.5, delay: 30 },
  { name: '更缓 r=0.00025 accel=1.5 delay=60', rate: 0.00025, accel: 1.5, delay: 60 },
  { name: '纯线性 r=0.0004 accel=0 delay=0', rate: 0.0004, accel: 0, delay: 0 },
];

// 模拟：她每天 08:00 和 20:00 各出现一次（各开口 10 分钟）
async function runOne(cfg) {
  let store = null;
  // 模拟"她最后一次出现"的时间戳。
  // 关键：积温用 minutesSinceLastMsg 判断是否进入加速段，
  // 这个值来自 getLastMessage().timestamp。返回固定的"现在"会让它恒为 0，
  // 导致 accelDelay>0 时永远不加速。这里让它反映真实的沉默时长。
  let lastMsgAt = Date.now();
  const j = createJiwen({
    getLastMessage: () => ({ id: 1, content: 'x', timestamp: new Date(lastMsgAt).toISOString() }),
    connectionRateFn: () => cfg.rate,
    onSave: async (s) => { store = JSON.parse(JSON.stringify(s)); },
    onLoad: async () => store || {
      connection: 0, pride: 0, valence: 0, arousal: 0, immersion: 0,
      lastActivity: null, lastTick: null, lastChatAnalysis: null,
      lastChatMessageId: null, lastBotMessageId: null, userStatus: 'active',
    },
    rates: { valenceSetpoint: -0.05, connectionAccel: cfg.accel, accelDelay: cfg.delay },
  });
  await j.load();

  const TICK = 5;
  let totalTriggers = 0;
  const firstHourHist = {};
  const dailyCounts = [];

  for (let d = 0; d < days; d++) {
    let dayCount = 0;
    let firstHour = null;
    for (let m = 0; m < DAY_MIN; m += TICK) {
      VNOW += TICK * 60 * 1000;
      const hour = Math.floor(m / 60);
      // 她在 08:00-08:10 和 20:00-20:10 出现
      const sheAppears = (m >= 480 && m < 490) || (m >= 1200 && m < 1210);
      if (sheAppears) {
        await j.resetConnection();
        lastMsgAt = VNOW;
        continue;
      }
      const trig = await j.tick(TICK);
      for (const t of trig) {
        if (t.action === 'contact') {
          dayCount++; totalTriggers++;
          if (firstHour === null) firstHour = hour;
          await j.applyDelta({ connection: -0.35 });
        }
      }
    }
    dailyCounts.push(dayCount);
    if (firstHour !== null) firstHourHist[firstHour] = (firstHourHist[firstHour] || 0) + 1;
  }

  const avg = (totalTriggers / days).toFixed(2);
  const dist = {};
  dailyCounts.forEach((c) => { dist[c] = (dist[c] || 0) + 1; });
  const firsts = Object.keys(firstHourHist).sort((a, b) => a - b);
  const minFirst = firsts[0];
  const maxFirst = firsts[firsts.length - 1];
  const midFirst = firsts[Math.floor(firsts.length / 2)];

  return { avg, dist, minFirst, maxFirst, midFirst };
}

(async () => {
  console.log(`模拟 ${days} 天，她每天 08:00 / 20:00 各出现一次\n`);
  console.log('配置'.padEnd(42) + '日均  首发(早/中/晚)  次数分布');
  console.log('─'.repeat(100));
  for (const c of configs) {
    const r = await runOne(c);
    const distStr = Object.keys(r.dist).sort((a, b) => b - a).map((k) => `${k}次×${r.dist[k]}天`).join(' ');
    console.log(
      c.name.padEnd(42) +
      String(r.avg).padEnd(6) +
      `${r.minFirst}/${r.midFirst}/${r.maxFirst}时`.padEnd(18) +
      distStr
    );
  }
  console.log('\n注：她每天出现 2 次，每次交互都 reset。若她一天只出现 1 次或不来，日均会更高。');
})().catch((e) => { console.error(e); process.exit(1); });
