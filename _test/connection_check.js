'use strict';
// connection 驱动专项（2026-10-08）：撤掉 resetConnection 之后，connection 是否真的能被判定器推动。
// 用法：node _test/connection_check.js
//
// 背景：桥原先在每轮真人开口时调 jiwen.resetConnection()（= `state.connection` 硬置 0）。
//   两处损害：
//     ① 判定器返 connection:-0.15（她热情/认真）→ clamp(0-0.15, 0, 1) = 0 —— **负向全废**；
//     ② 判定器返 +0.15（她敷衍）→ 只能到 0.15，够不到第一个消费点 0.20 —— **正向也等于废**。
//   而作者原设计就是「回复带来的 connection 降幅由 LLM 判定这轮对话内容接管」：
//     vendor/jiwen.js:41   connectionOnReply 已标 [已弃用]「现由 LLM delta 接管」
//     vendor/jiwen.js:277  「连接需求降幅现由外部 LLM 分析…通过 applyDelta 注入」
//   撤掉后 connection 由「判定器 delta + tick 漂移」驱动；判定没跑成时
//   由 bridge.js 的 replyRelief() 兜底一顿 -CONNECTION_RELIEF。
//
// 三层：
//   A 行为层 —— 真引擎，验证 delta 真能推动 c（并给出与旧行为的对照）
//   B 阈值层 —— 敷衍几次能过线
//   C 接线层 —— 静态断言 bridge.js 的兜底条件挂对了地方

const fs = require('fs');
const path = require('path');
const { createJiwen } = require('../vendor/jiwen.js');

// 与 bridge.js CFG 的默认值同步（改一边记得改另一边）
const RELIEF = 0.35;
// vendor 的三个消费阈值（vendor/jiwen.js:113-120 的 thresholds 默认值）
const OBSERVATION = 0.20;
const CONSIDER = 0.35;
const FORCE = 0.50;

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (detail ? '  — ' + detail : ''));
}

function makeEngine() {
  let store = null;
  return createJiwen({
    getLastMessage: () => null,
    connectionRateFn: () => 0,
    onSave: async (s) => { store = JSON.parse(JSON.stringify(s)); },
    onLoad: async () => store || {
      connection: 0, pride: 0, valence: 0, arousal: 0, immersion: 0,
      lastActivity: null, lastTick: null, lastChatAnalysis: null,
      lastChatMessageId: null, lastBotMessageId: null, userStatus: 'active',
    },
    rates: { valenceSetpoint: -0.05, connectionAccel: 1.5, accelDelay: 30 },
  });
}

const r3 = (x) => Math.round(x * 1000) / 1000;

(async () => {
  // ══════════ A. 行为层：delta 真的能推动 connection ══════════
  console.log('A. delta 能推动 connection（撤 reset 之后的新行为）\n');

  const j = makeEngine();
  const c = async () => r3((await j.getState()).connection);

  check('初始 connection = 0', (await c()) === 0, 'c=' + (await c()));

  await j.applyDelta({ connection: 0.15 });
  check('她敷衍 ①（+0.15）→ c = 0.15', (await c()) === 0.15, 'c=' + (await c()));

  await j.applyDelta({ connection: 0.15 });
  check('她敷衍 ② → c = 0.30（已过留意线 0.20）', (await c()) === 0.30, 'c=' + (await c()));

  await j.applyDelta({ connection: 0.15 });
  check('她敷衍 ③ → c = 0.45（已过考虑线 0.35）', (await c()) === 0.45, 'c=' + (await c()));

  await j.applyDelta({ connection: -0.20 });
  check('她转热情（-0.20）→ c 被真正压回 0.25', (await c()) === 0.25, 'c=' + (await c()));

  await j.applyDelta({ connection: -0.20 });
  check('再热情 → c = 0.05', (await c()) === 0.05, 'c=' + (await c()));

  await j.applyDelta({ connection: -0.35 });
  check('兜底缓解一顿（-0.35）→ 落到 0（轴下界，不是 bug）', (await c()) === 0, 'c=' + (await c()));

  await j.applyDelta({ connection: -0.35 });
  check('c 已在 0 时再减 → 仍为 0（下界 clamp）', (await c()) === 0, 'c=' + (await c()));

  // ══════════ B. 阈值层：兜底量压不压得住「敷衍」 ══════════
  console.log('\nB. 兜底量 -' + RELIEF + ' 与敷衍增量 +0.15 的关系\n');
  const w = makeEngine();
  await w.applyDelta({ connection: 0.15 });
  await w.applyDelta({ connection: 0.15 });
  const beforeRelief = r3((await w.getState()).connection);
  await w.applyDelta({ connection: -RELIEF });
  const afterRelief = r3((await w.getState()).connection);
  check('敷衍 ②（c=0.30）再吃一顿兜底 -0.35 → 归 0',
    beforeRelief === 0.30 && afterRelief === 0, `${beforeRelief} → ${afterRelief}`);
  console.log('       ↑ 兜底是「判定器没跑成」时的保险，不是常态。判定正常时')
  console.log('         她敷衍给的 +0.15 不会被抹 —— 因为它压根不走兜底这条支路。');

  const reach = makeEngine();
  const marks = {};
  for (let n = 1; n <= 4; n++) {
    await reach.applyDelta({ connection: 0.15 });
    marks[n] = r3((await reach.getState()).connection);
  }
  check('从 0 起：2 次敷衍过留意线 0.20', marks[2] >= OBSERVATION, `n=2 → ${marks[2]}`);
  check('         3 次敷衍过考虑线 0.35', marks[3] >= CONSIDER, `n=3 → ${marks[3]}`);
  check('         4 次敷衍过强制线 0.50', marks[4] >= FORCE, `n=4 → ${marks[4]}`);

  // ── 旧行为对照：reset 在场时，上面这些全部白费 ──
  //   桥里的真实时序是：reset → 建块(c=0) → 转发 → 判定器异步回 delta。
  //   所以要对照的不是"恒 0"，而是"**c 的峰值被 reset 钉死在 0.15**"：
  //   每轮开头必归零，delta 再怎么给也只能在单轮内堆到 0.15，而 0.15 < 0.20
  //   → 一个消费点都够不到（含 45 格的 aware 档）。
  const old = makeEngine();
  const peaks = [];
  for (let n = 0; n < 3; n++) {
    await old.resetConnection();
    await old.applyDelta({ connection: 0.15 });
    peaks.push(r3((await old.getState()).connection));
  }
  check('【旧行为对照】每轮 reset 后再 +0.15 → c 峰值恒 0.15，三轮一模一样',
    peaks.every((p) => p === 0.15), peaks.join(' / '));
  check('【旧行为对照】0.15 < 留意线 0.20 → 敷衍再多次也够不到任何消费点',
    peaks[0] < OBSERVATION, `peak=${peaks[0]} < ${OBSERVATION}`);

  const old2 = makeEngine();
  await old2.resetConnection();
  await old2.applyDelta({ connection: -0.15 });
  check('【旧行为对照】reset 后 -0.15（她热情）→ 也是 0，负向完全无效',
    (await old2.getState()).connection === 0, 'c=' + r3((await old2.getState()).connection));

  // ══════════ C. 接线层：bridge.js 的兜底挂对地方了吗 ══════════
  console.log('\nC. bridge.js 接线（静态断言）\n');
  const src = fs.readFileSync(path.join(__dirname, '..', 'bridge.js'), 'utf8');

  check('bridge 不再调 jiwen.resetConnection()', !/jiwen\.resetConnection\(/.test(src));
  check('replyRelief 有定义', /function replyRelief\(reason\)/.test(src));
  check('兜底走 applyDelta(-CFG.connectionRelief)',
    /applyDelta\(\{ connection: -CFG\.connectionRelief \}\)/.test(src));
  check('CFG 里有 connectionRelief（默认 0.35）',
    /connectionRelief: parseFloat\(process\.env\.CONNECTION_RELIEF \|\| '0\.35'\)/.test(src));
  check('兜底条件 = 真人开口 且 判定没接手（!loopback && !connectionHandled）',
    /if \(!loopback && !connectionHandled\) replyRelief\('not analyzed'\)/.test(src));
  check('判定成功路径不兜底（delta 真则 applyDelta，else 才 replyRelief）',
    /if \(delta\) \{[\s\S]*?delta applied[\s\S]*?\} else \{\s*replyRelief\('analyzer returned empty'\)/.test(src));
  check('判定报错路径兜底', /analyzer failed:[\s\S]*?replyRelief\('analyzer failed'\)/.test(src));
  check('被 dedup 跳过的工具轮不兜底（connectionHandled 在跳过分支也置 true）',
    /connectionHandled = true; \/\/ 同一轮：前一次已经判过/.test(src));
  check('判定器仍保留 connection 维（撤 reset 是让它生效，不是砍掉它）',
    /connection: clamp\(delta\.connection, -0\.50, 0\.30\)/.test(
      fs.readFileSync(path.join(__dirname, '..', 'lib', 'analyzer.js'), 'utf8')));

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n${pass}/${results.length} 通过`);
  process.exit(pass === results.length ? 0 : 1);
})();
