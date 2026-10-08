'use strict';
// 低情绪通道 + 活动缓解 专项（2026-10-09）
// 用法：node _test/valence_channel_check.js
//
// 背景：她整日不出现时，桥原先只能靠「嘴硬」通道触发 find_activity
//   （c∈[0.35,0.50) 且 pride≥0.5）。实测 pride≥0.5 占醒着时间的 80%，
//   描述层第 2 段被钉死在同一档；且 c 涨得越快，「找你」(contact) 越容易
//   抢在 pride 顶格之前触发 —— 冲浪反而变少。
//
// 引擎里 find_activity 有第二条**互不相干**的入口（vendor/jiwen.js:507）：
//   valence ≤ thresholds.valenceActivity 且 immersion < 0.3 → low_valence
//   ② 完全不看 connection。vendor 把阈值默认成 -1.0（永不触发）。
//
// 三层：
//   A 行为层 —— 真引擎，验证通道开关真的改变触发结果
//   B 缓解层 —— activityConnectionRelief 的扣减规则（含同类型不重复扣 / 0.01 下限）
//   C 接线层 —— 静态断言 bridge.js 把两个参数挂对了地方

const fs = require('fs');
const path = require('path');
const { createJiwen } = require('../vendor/jiwen.js');

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (detail ? '  — ' + detail : ''));
}

const NEUTRAL = {
  connection: 0, pride: 0, valence: 0, arousal: 0, immersion: 0,
  lastActivity: null, lastTick: null, lastChatAnalysis: null,
  lastChatMessageId: null, lastBotMessageId: null, userStatus: 'active',
};

function makeEngine(opts = {}) {
  let store = null;
  return createJiwen({
    getLastMessage: () => null,
    connectionRateFn: () => (opts.rate === undefined ? 0 : opts.rate),
    onSave: async (s) => { store = JSON.parse(JSON.stringify(s)); },
    onLoad: async () => store || { ...NEUTRAL },
    getPromptContext: () => '',
    getStyleGuidance: () => '',
    rates: {
      valenceSetpoint: -0.05,
      connectionAccel: 1.5,
      accelDelay: 30,
      activityConnectionRelief: opts.relief === undefined ? 0 : opts.relief,
    },
    thresholds: { valenceActivity: opts.valenceActivity === undefined ? -1.0 : opts.valenceActivity },
    verbose: false,
    onLog: () => {},
  });
}

// 连续 tick，收集所有触发
async function tickN(j, n, mins = 5) {
  let out = [];
  for (let i = 0; i < n; i++) out = out.concat(await j.tick(mins));
  return out;
}
const has = (triggers, action) => triggers.some((t) => t.action === action);
const findTriggers = (triggers) => triggers.filter((t) => t.action === 'find_activity');
const r3 = (x) => Math.round(x * 1000) / 1000;

(async () => {
  // ══════════ A. 低情绪通道开关 ══════════
  console.log('A. 低情绪通道（valenceActivity）\n');

  // A1 默认 -1.0：永不触发（对照）
  {
    const j = makeEngine({ valenceActivity: -1.0 });
    await j.load();
    const tr = await tickN(j, 8);
    const v = r3((await j.getState()).valence);
    check('A1 默认阈值 -1.0 → valence 低到 ' + v + ' 也不触发 find_activity',
      !has(tr, 'find_activity'), '触发了 ' + findTriggers(tr).length + ' 次');
  }

  // A2 打开 -0.04：valence 回归 setpoint(-0.05) 后常态触发
  {
    const j = makeEngine({ valenceActivity: -0.04 });
    await j.load();
    const tr = await tickN(j, 8);
    const f = findTriggers(tr);
    check('A2 阈值 -0.04 → valence 回归到 ' + r3((await j.getState()).valence) + ' 后触发 find_activity',
      f.length > 0);
    check('A2 触发理由是 low_valence', f.length > 0 && f[0].reason === 'low_valence',
      f.length ? 'reason=' + f[0].reason : '无触发');
  }

  // A3 该通道不看 connection：c 恒 0 也能触发
  {
    const j = makeEngine({ valenceActivity: -0.04, rate: 0 });
    await j.load();
    const tr = await tickN(j, 8);
    const c = r3((await j.getState()).connection);
    check('A3 connection = ' + c + ' 时仍能触发（通道与 c 解耦）',
      c === 0 && has(tr, 'find_activity'));
  }

  // A4 冲浪刚跑完（immersion 0.4 ≥ 0.3）时被挡，衰减到 0.3 以下后恢复
  // ⚠️ immersion 的衰减量 = 速率 × min(tick, 距活动分钟数)，必须用**可推进的假时钟**，
  //    否则瞬间执行的测试里 sinceActivity≈0，衰减量恒为 0。
  {
    const RealDate = Date;
    let VNOW = RealDate.now();
    class FakeDate extends RealDate {
      constructor(...a) { if (a.length === 0) super(VNOW); else super(...a); }
      static now() { return VNOW; }
    }
    global.Date = FakeDate;
    try {
      const j = makeEngine({ valenceActivity: -0.04 });
      await j.load();
      VNOW += 15 * 60000;
      await tickN(j, 4);                              // valence 到位
      await j.setActivity('search', '上网冲浪');       // immersion = 0.4
      VNOW += 5 * 60000;
      const trB = await j.tick(5);                     // 0.4 → 0.35
      check('A4 冲浪刚完（immersion=' + r3((await j.getState()).immersion) + '）时不重复触发',
        !has(trB, 'find_activity'));
      VNOW += 25 * 60000;
      const trC = await tickN(j, 5);                   // 0.35 → 0.10（< 0.3）
      check('A4 immersion 衰减到 ' + r3((await j.getState()).immersion) + ' 后恢复触发',
        has(trC, 'find_activity'));
    } finally { global.Date = RealDate; }
  }

  // ══════════ B. 活动缓解 ══════════
  console.log('\nB. 活动缓解（activityConnectionRelief）\n');

  // B1 默认 0：不扣
  {
    const j = makeEngine({ relief: 0 });
    await j.load();
    await j.applyDelta({ connection: 0.50 });
    await j.setActivity('search', '上网冲浪');
    check('B1 relief=0 → 冲浪后 connection 不变', r3((await j.getState()).connection) === 0.5,
      'c=' + r3((await j.getState()).connection));
  }

  // B2 类型变化时扣减
  {
    const j = makeEngine({ relief: 0.10 });
    await j.load();
    await j.applyDelta({ connection: 0.50 });
    await j.setActivity('search', '上网冲浪');
    check('B2 relief=0.10 → 首次冲浪把 c 从 0.50 压到 0.40',
      r3((await j.getState()).connection) === 0.4, 'c=' + r3((await j.getState()).connection));
  }

  // B3 同类型连续不重复扣（vendor 的 sameType 保护）
  {
    const j = makeEngine({ relief: 0.10 });
    await j.load();
    await j.applyDelta({ connection: 0.50 });
    await j.setActivity('search', '上网冲浪');
    await j.setActivity('search', '上网冲浪');
    await j.setActivity('search', '上网冲浪');
    check('B3 同类型连续冲浪只扣一次（c 停在 0.40）',
      r3((await j.getState()).connection) === 0.4, 'c=' + r3((await j.getState()).connection));
  }

  // B4 换成别的活动类型 → 再扣一次
  {
    const j = makeEngine({ relief: 0.10 });
    await j.load();
    await j.applyDelta({ connection: 0.50 });
    await j.setActivity('search', '上网冲浪');
    await j.setActivity('reading', '翻书');
    check('B4 活动类型变化 → 再扣一次（c 到 0.30）',
      r3((await j.getState()).connection) === 0.3, 'c=' + r3((await j.getState()).connection));
  }

  // B5 0.01 下限：防止清零导致阈值永不触达
  {
    const j = makeEngine({ relief: 0.30 });
    await j.load();
    await j.applyDelta({ connection: 0.05 });
    await j.setActivity('search', '上网冲浪');
    check('B5 c 触底停在 0.01（不是 0）',
      r3((await j.getState()).connection) === 0.01, 'c=' + r3((await j.getState()).connection));
  }

  // ══════════ C. 接线层（bridge.js 源码断言） ══════════
  console.log('\nC. bridge.js 接线\n');
  const src = fs.readFileSync(path.join(__dirname, '..', 'bridge.js'), 'utf8');
  // 去掉注释行，只在真实代码里匹配
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

  check('C1 CFG 暴露 VALENCE_ACTIVITY_THRESHOLD（默认 -1.0 哨兵）',
    /VALENCE_ACTIVITY_THRESHOLD \|\| '-1\.0'/.test(code));
  check('C2 CFG 暴露 ACTIVITY_CONNECTION_RELIEF（默认 0）',
    /ACTIVITY_CONNECTION_RELIEF \|\| '0'/.test(code));
  check('C3 thresholds.valenceActivity 真被传进 createJiwen',
    /valenceActivity:\s*CFG\.valenceActivityThreshold/.test(code));
  check('C4 rates.activityConnectionRelief 真被传进 createJiwen',
    /activityConnectionRelief:\s*CFG\.activityConnectionRelief/.test(code));
  check('C5 注释里写明了「阈值必须 ≥ valenceSetpoint」这个耦合',
    /必须 \*\*≥ valenceSetpoint|阈值必须/.test(src));

  // C6/C7 —— 2026-10-08 在 VPS 上热修但没进版本库的那两处，补一条防回退
  check('C6 spawnSurf 用 CFG.surfNodeBin（不用 process.execPath）',
    /spawn\(CFG\.surfNodeBin/.test(code) && !/spawn\(process\.execPath/.test(code));
  check('C7 surf 子进程显式覆盖 STATE_FILE / LLM_DISABLE_THINKING（否则 loadDotEnv 静默失效）',
    /STATE_FILE:\s*path\.join\(CFG\.surfDir/.test(code) && /LLM_DISABLE_THINKING:\s*'true'/.test(code));

  // ══════════ 汇总 ══════════
  const bad = results.filter((r) => !r.ok);
  console.log('\n' + (results.length - bad.length) + '/' + results.length + ' 通过');
  if (bad.length) { bad.forEach((b) => console.log('  FAIL  ' + b.name)); process.exit(1); }
})();
