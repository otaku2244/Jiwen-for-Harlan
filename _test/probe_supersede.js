'use strict';
// probe_supersede.js —— 验证「先入队的通知会不会被后入队的顶掉」到底会不会发生。
//
// 背景：`lib/mcp.js` 的 get_pending_notice 一次返回全部，`payload.notice = list[0]`
// 取的是**最旧**那条；`jiwen_pull.js` 只投这一条，其余进 `DROPPED=` 日志。
// 于是有个问题：`contact`（找她）会不会被更晚入队的 `find_activity`（独处）顶掉？
//
// 这个脚本不猜，直接拿真引擎 + 桥的真实参数跑 7 天，逐 tick 记录。
//
// 用法：node _test/probe_supersede.js

const { createJiwen } = require('../vendor/jiwen.js');

const TICK_MIN = 5;          // 桥的 TICK_MINUTES
const POLL_MIN = 30;         // Operit 工作流的 interval
const QUIET_START = 0;       // 与 .env 一致
const QUIET_END = 8;
const DAILY_MAX = 8;         // 与桥 .env 默认一致（2026-10-07 起 6 → 8）
const CONTACT_DECAY = -0.35; // fireProactive 外层的开口衰减
// ⚠️ 与桥一致（2026-10-07 起）：同场景冷却，否则 find_activity 会把日上限瞬间打光、
//    连带把 contact 一起挡在门外（本探针第一次跑就是这个结果，属模拟失真而非真实结论）。
const COOLDOWN_MIN = 180;

// ── 她的出现节奏（按天循环，分钟偏移）──
// 两次出现 → 两段静默 → param_scan 实测约 2 次 contact/天。
// 第二段带情绪，用来把 arousal / valence 顶起来（自我调节闸门的唯一入口）。
const CHAT_PLAN = [
  { at: 8 * 60 + 30, turns: 3, delta: { pride: 0.05, valence: 0.10, arousal: 0.05 } },
  { at: 20 * 60, turns: 6, delta: { pride: 0.10, valence: -0.30, arousal: 0.30 } },
];

async function simulate(days, pollMin) {
  const state = {
    connection: 0, pride: 0, valence: 0, arousal: 0, immersion: 0,
    lastActivity: null, lastTick: null, lastChatAnalysis: null,
    lastChatMessageId: null, lastBotMessageId: null, userStatus: 'active',
  };

  const jiwen = createJiwen({
    getLastMessage: () => null,                   // 桥就是这么传的
    connectionRateFn: () => 0.0007,
    onSave: async (s) => { Object.assign(state, s); },
    onLoad: async () => ({ ...state }),
    getPromptContext: () => '', getStyleGuidance: () => '',
    rates: {
      valenceSetpoint: -0.05, connectionAccel: 1.5, accelDelay: 30,
      // ⚠️ 与桥保持一致（2026-10-07 起）。vendor 默认 prideDefendThreshold=1.0 是
      //    "永不"的哨兵值 → find_activity 永远不可达 → 本探针测不到混场景队列。
      //    桥打开骄傲防御后，find_activity 会在 contact 之前先触发，队列才有意义。
      prideDefendThreshold: 0.20, prideDefendRate: 0.004,
    },
    verbose: false, onLog: () => {},
  });
  await jiwen.load();

  const rec = {
    ticks: 0, contactFires: 0, findFires: 0,
    contactDuringQuiet: 0,
    bothInOneTick: 0,
    polls: 0, pollsWithQueue: 0,
    bothInQueue: 0,
    droppedContact: 0,   // ← 坏方向：FIFO 投了更旧的 find_activity，丢了更晚的 contact
    droppedFind: 0,      // 反方向：投了更旧的 contact，丢了更晚的 find_activity
    staleDelivered: 0,   // 投出去时她的前提已作废（这中间她开过口）
    staleByScene: { contact: 0, find_activity: 0 },
    deliveredByScene: { contact: 0, find_activity: 0 },
    // 两种投递策略各记一次：FIFO = 取最旧（历史实现），LIFO = 取最新（当前实现）
    fifoDelivered: { contact: 0, find_activity: 0 },
    lifoDelivered: { contact: 0, find_activity: 0 },
    lifoDroppedContact: 0,
    lagSum: 0, lagMax: 0,
    maxQueue: 0,
    aMaxAtContact: -Infinity, aMinAtContact: Infinity,
    gaps: [],
  };

  let queue = [];
  let sendDay = -1, sendCount = 0;
  let lastUserAtMin = -Infinity;
  const lastFireAt = { contact: -Infinity, find_activity: -Infinity };
  const totalMin = days * 1440;
  const localHour = (m) => Math.floor((m % 1440) / 60);
  const inQuiet = (m) => {
    const h = localHour(m);
    return QUIET_START < QUIET_END ? (h >= QUIET_START && h < QUIET_END) : (h >= QUIET_START || h < QUIET_END);
  };

  for (let abs = 0; abs < totalMin; abs += TICK_MIN) {
    const minOfDay = abs % 1440;
    const day = Math.floor(abs / 1440);
    if (day !== sendDay) { sendDay = day; sendCount = 0; }

    // ── 她的出现：每个 turn 一次 reset + 一次判定器 delta ──
    for (const plan of CHAT_PLAN) {
      for (let T = 0; T < plan.turns; T++) {
        if (minOfDay === plan.at + T * 5) {
          await jiwen.applyDelta({ connection: -0.35 });
          await jiwen.applyDelta({ ...plan.delta });
          lastUserAtMin = abs;
        }
      }
    }

    // ── tick ──
    rec.ticks++;
    const triggers = (await jiwen.tick(TICK_MIN)).filter((t) => t.action !== 'observation');
    const st = await jiwen.getState();

    const hasContact = triggers.some((t) => t.action === 'contact');
    const hasFind = triggers.some((t) => t.action === 'find_activity');
    if (hasContact) {
      rec.contactFires++;
      rec.aMaxAtContact = Math.max(rec.aMaxAtContact, st.arousal);
      rec.aMinAtContact = Math.min(rec.aMinAtContact, st.arousal);
    }
    if (hasFind) rec.findFires++;
    if (hasContact && hasFind) rec.bothInOneTick++;
    if (hasContact && inQuiet(abs)) rec.contactDuringQuiet++;

    // ── 投递（照抄 fireProactive 的闸门；**衰减无条件执行**，与 bridge.js 一致）──
    for (const t of triggers) {
      // 同场景冷却：与 bridge.js tickOnce 一致，通过且真投出才记账
      // （被静默/日上限挡掉的不吃冷却 —— 桥里是 `if (sent) mark`）
      if ((abs - lastFireAt[t.action]) < COOLDOWN_MIN) continue;
      if (!inQuiet(abs) && sendCount < DAILY_MAX) {
        sendCount++;
        lastFireAt[t.action] = abs;
        queue.push({ scene: t.action, reason: t.reason || null, at: abs });
        rec.maxQueue = Math.max(rec.maxQueue, queue.length);
      }
      if (t.action === 'contact') await jiwen.applyDelta({ connection: CONTACT_DECAY });
    }

    // ── Operit 每 pollMin 分钟来拉一次 ──
    if (abs % pollMin === 0) {
      rec.polls++;
      if (queue.length) {
        rec.pollsWithQueue++;
        const head = queue[0];
        const latest = queue[queue.length - 1];
        const nContact = queue.filter((q) => q.scene === 'contact').length;
        const nFind = queue.length - nContact;
        const lag = abs - head.at;
        rec.lagSum += lag; rec.lagMax = Math.max(rec.lagMax, lag);
        rec.deliveredByScene[head.scene] = (rec.deliveredByScene[head.scene] || 0) + 1;
        // 两种策略各记一次，好直接对比（FIFO = 旧实现，LIFO = 现在的 mcp.js）
        rec.fifoDelivered[head.scene]++;
        rec.lifoDelivered[latest.scene]++;

        if (nContact && nFind) {
          rec.bothInQueue++;
          rec.gaps.push({ at: abs, queue: queue.map((q) => `${q.scene}@${q.at}`).join(', ') });
          if (head.scene === 'find_activity') rec.droppedContact++;   // FIFO 坏方向
          else rec.droppedFind++;
          if (latest.scene === 'find_activity') rec.lifoDroppedContact++;
        }
        if (lastUserAtMin > head.at) {
          rec.staleDelivered++;
          rec.staleByScene[head.scene] = (rec.staleByScene[head.scene] || 0) + 1;
        }
        queue = [];
      }
    }
  }

  rec.avgLag = rec.pollsWithQueue ? rec.lagSum / rec.pollsWithQueue : 0;
  return rec;
}

function climbMinutes(target) {
  let c = 0, m = 0;
  while (c < target && m < 100000) { c = Math.min(1, c + 0.0007 * Math.pow(1 + c, 1.5)); m++; }
  return m;
}
function regressMinutes(from, rate) {
  let v = from, m = 0;
  while (v > 0 && m < 100000) { v = Math.max(0, v - rate); m++; }
  return m;
}

(async () => {
  const report = (title, rec, pollMin) => {
    console.log(`\n=== ${title} ===`);
    console.log(`tick 次数                      ${rec.ticks}`);
    console.log(`contact 触发                   ${rec.contactFires}（落在静默时段、只衰减不投递：${rec.contactDuringQuiet}）`);
    console.log(`find_activity 触发             ${rec.findFires}`);
    console.log(`Operit 拉取                    ${rec.polls} 次（队列非空 ${rec.pollsWithQueue} 次 = 投递轮次）`);
    console.log(`投递轮次里：contact ${rec.deliveredByScene.contact} 条 / find_activity ${rec.deliveredByScene.find_activity} 条`);
    console.log(`  策略对比 FIFO(取最旧) contact ${rec.fifoDelivered.contact} / find ${rec.fifoDelivered.find_activity}` +
      ` ｜ LIFO(取最新，现行) contact ${rec.lifoDelivered.contact} / find ${rec.lifoDelivered.find_activity}`);
    console.log(`  LIFO 丢掉更早的 contact        ${rec.lifoDroppedContact}`);
    console.log(`队列同时压着两种场景            ${rec.bothInQueue}`);
    console.log(`同一 tick 同时产出两种          ${rec.bothInOneTick}`);
    console.log(`→ 投 find_activity、丢 contact  ${rec.droppedContact}   ← 坏方向`);
    console.log(`→ 投 contact、丢 find_activity  ${rec.droppedFind}`);
    console.log(`投递时她已开口（前提作废）       ${rec.staleDelivered}  ` +
      `（contact ${rec.staleByScene.contact}/${rec.deliveredByScene.contact}，` +
      `find_activity ${rec.staleByScene.find_activity}/${rec.deliveredByScene.find_activity}）`);
    console.log(`队列最大长度                   ${rec.maxQueue}`);
    console.log(`投递滞后（生成→取走）均值        ${rec.avgLag.toFixed(1)} 分钟，最大 ${rec.lagMax} 分钟`);
    console.log(`contact 触发那刻的 arousal       ${rec.aMinAtContact.toFixed(2)} ~ ${rec.aMaxAtContact.toFixed(2)}（自我调节闸门要 ≥ 0.70）`);
    if (rec.gaps.length) {
      console.log('明细（两种场景同队）：');
      for (const g of rec.gaps.slice(0, 8)) console.log(`  第 ${g.at} 分钟 | ${g.queue}`);
    }
  };

  report('A · 正常：Operit 每 30 分钟拉一次', await simulate(7, 30), 30);
  report('B · 极端：Operit 每 8 小时才来拉一次（手机长时间离线）', await simulate(7, 480), 480);

  console.log('\n=== 两个时间窗的量级（决定两种场景能否同队）===');
  console.log(`reset 后 connection 从 0 爬到 0.35 ：${climbMinutes(0.35)} 分钟 ≈ ${(climbMinutes(0.35) / 60).toFixed(1)} 小时`);
  console.log(`arousal 从 0.70 回归到 0            ：${regressMinutes(0.7, 0.005)} 分钟 ≈ ${(regressMinutes(0.7, 0.005) / 60).toFixed(1)} 小时`);
  console.log(`valence 从 -0.40 回归到 -0.05 设定点：${regressMinutes(0.35, 0.005)} 分钟 ≈ ${(regressMinutes(0.35, 0.005) / 60).toFixed(1)} 小时`);
  console.log('');
})();
