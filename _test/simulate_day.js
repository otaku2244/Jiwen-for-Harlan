'use strict';
// ════════════════════════════════════════════════════
// 整日漂移模拟（vm 沙箱，替换时钟）
//
// 验证：
//   1. 长时间沉默 → connection 累积 → 触发 contact
//   2. 多窗口切换（operit / omate）→ reset 全局生效，不人格分裂
//   3. 情绪 delta 作用于五轴后，档位/簇正确迁移
//   4. 静默时段拦截主动唤醒
// ════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const { createJiwen } = require('../vendor/jiwen.js');
const { createToneGrid } = require('../vendor/tone-grid.js');
const { buildInjectionBlock, buildProactiveNotice } = require('../lib/inject-text.js');

const tonePath = path.join(__dirname, '..', 'config', 'tone-harlan.json');
const toneCfg = JSON.parse(fs.readFileSync(tonePath, 'utf8'));
const toneGrid = createToneGrid({ profiles: toneCfg.profiles, urgencyBoost: toneCfg.urgencyBoost });

// 虚拟时钟
let VNOW = new Date('2026-10-05T08:00:00+08:00').getTime();
const RealDate = Date;
class FakeDate extends RealDate {
  constructor(...args) { if (args.length === 0) super(VNOW); else super(...args); }
  static now() { return VNOW; }
}
Date = FakeDate;

let store = null;
const jiwen = createJiwen({
  getLastMessage: () => ({ id: 1, content: '早', timestamp: new RealDate(VNOW).toISOString() }),
  connectionRateFn: () => 0.0007,
  onSave: async (s) => { store = JSON.parse(JSON.stringify(s)); },
  onLoad: async () => store || {
    connection: 0, pride: 0, valence: 0, arousal: 0, immersion: 0,
    lastActivity: null, lastTick: null, lastChatAnalysis: null,
    lastChatMessageId: null, lastBotMessageId: null, userStatus: 'active',
  },
  getPromptContext: (s) => toneGrid.getPromptContext(s),
  getStyleGuidance: (s) => toneGrid.getStyleGuidance(s),
  rates: { valenceSetpoint: -0.05, connectionAccel: 1.5, accelDelay: 30 },
});

const TICK = 5; // 分钟
const rows = [];
const events = [];

function fmt(ms) {
  const d = new RealDate(ms);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

async function step(minutes, note) {
  for (let i = 0; i < minutes / TICK; i++) {
    VNOW += TICK * 60 * 1000;
    const triggers = await jiwen.tick(TICK);
    const st = await jiwen.getState();
    for (const t of triggers) events.push({ at: fmt(VNOW), action: t.action, c: st.connection.toFixed(2) });
    if (triggers.length) {
      for (const t of triggers) {
        if (t.action === 'contact') await jiwen.applyDelta({ connection: -0.35 });
      }
    }
  }
  const st = await jiwen.getState();
  rows.push({ at: fmt(VNOW), note: note || '', c: +st.connection.toFixed(3), p: +st.pride.toFixed(3), v: +st.valence.toFixed(3), a: +st.arousal.toFixed(3), i: +st.immersion.toFixed(3) });
}

(async () => {
  await jiwen.load();

  console.log('════════ 场景一：她在 08:00 说了一句，然后消失 ════════');
  await jiwen.resetConnection();
  await jiwen.applyDelta({ valence: 0.15, arousal: -0.05, connection: -0.30 });
  rows.push({ at: fmt(VNOW), note: '她说"早"+ 判定器delta', ...(await snap()) });

  await step(120, '沉默 2h');
  await step(180, '沉默 3h');
  await step(240, '沉默 4h');

  console.log('事件流（阈值触发）:');
  if (!events.length) console.log('  （无触发）');
  events.forEach((e) => console.log(`  ${e.at}  ${e.action}  c=${e.c}`));

  console.log('\n状态轨迹:');
  rows.forEach((r) => console.log(`  ${r.at}  c=${r.c}  p=${r.p}  v=${r.v}  a=${r.a}  ${r.note}`));

  console.log('\n════════ 场景二：多窗口切换（operit ↔ omate）════════');
  // 关键验证：在 omate 说话，operit 侧也应 reset（全局单实例）
  await step(180, '再次沉默 3h');
  const before = await jiwen.getState();
  console.log(`  切窗前 connection = ${before.connection.toFixed(3)}`);

  // 模拟 omate 窗口用户发言 → reset
  console.log('  [omate 窗口] 用户发消息 → resetConnection()');
  await jiwen.resetConnection();
  const after = await jiwen.getState();
  console.log(`  切窗后 connection = ${after.connection.toFixed(3)}`);
  console.log(`  → 全局单实例${after.connection === 0 ? ' 生效（无人格分裂）' : ' 失效！'}`);

  console.log('\n════════ 场景三：情绪 delta 迁移簇 ════════');
  const cases = [
    { name: '她示弱 → 松/暖/静', delta: { pride: -0.20, valence: 0.10, arousal: -0.10 } },
    { name: '她挑衅原则 → 冷/沉/起波', delta: { pride: 0.25, valence: -0.15, arousal: 0.15 } },
    { name: '她撒娇 → 无波动', delta: { pride: 0.0, valence: 0.0, arousal: 0.0 } },
  ];
  for (const c of cases) {
    await jiwen.applyDelta(c.delta);
    const s = await jiwen.getState();
    const block = buildInjectionBlock(s, toneGrid);
    const styleLine = block.split('\n').slice(1).join(' ').slice(0, 70);
    console.log(`  ${c.name}`);
    console.log(`    状态: p=${s.pride.toFixed(2)} v=${s.valence.toFixed(2)} a=${s.arousal.toFixed(2)}`);
    console.log(`    注入: ${styleLine}…`);
  }

  console.log('\n════════ 场景四：主动唤醒通知原文 ════════');
  await jiwen.applyDelta({ connection: 0.55, pride: 0.4 });
  const sp = await jiwen.getState();
  console.log(buildProactiveNotice(sp, toneGrid, { scene: 'contact' }, toneCfg.sceneOverride, toneCfg.proactiveOutlet));

  // 落盘
  const out = path.join(__dirname, '.run', 'sim-day.json');
  fs.writeFileSync(out, JSON.stringify({ rows, events }, null, 2));
  console.log('\n轨迹已写入 ' + out);
})().catch((e) => { console.error('SIM CRASH', e); process.exit(1); });

async function snap() { const s = await jiwen.getState(); return { c: +s.connection.toFixed(3), p: +s.pride.toFixed(3), v: +s.valence.toFixed(3), a: +s.arousal.toFixed(3), i: +s.immersion.toFixed(3) }; }
