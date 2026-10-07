'use strict';
// 回环认领 —— 判断一条进来的 user 消息，是不是桥自己发出去的主动唤醒通知。
//
// ── 为什么需要这一层 ────────────────────────────────
//
// 主动唤醒的形态是：桥 tick 越阈 → 生成积温块 → MCP 队列 → Operit 工作流
// 把 notice 原文当一条 **user 消息**注入对话 → 该请求又打回桥
// （桥是 Serein 前面的反向代理，只要模型被调用就必经此处）。
//
// 于是桥看到一个"她开口了"的请求，可实际上她什么都没说。
// 不识别就会犯三个错：
//   ① 多跑一次"她开口"的 connection 处理（兜底缓解）—— 抹掉这次唤醒本该有的距离感；
//   ② 把唤醒通知当"她的发言"喂给判定器打分 —— 凭空产生一次错误的情绪漂移；
//   ③ 回环让位失效 —— reactive 语域的此刻块又叠在 proactive 语域的通知上（见 bridge.js）。
//
// ── 判据为什么用"原文匹配" ─────────────────────────
//
// 通知是桥自己生成的，原文在手上，所以直接按原文认领，不猜格式。
// 归一化去掉全部空白字符再比对：Operit 侧加前缀、加后缀、把换行压成空格、
// 或者包一层引用标记，都不影响命中。
//
// 两条保险：
//   · TTL + 条数上限 —— 通知在队列里滞留过久（或进程长跑）后自动失忆，
//     杜绝"很久以前的通知文本"被误认成回环；
//   · 原文必须**完整出现**在最后一条 user 消息里（`includes`，去空白后比对），
//     她随口提一句通知里的半句话不会命中。
//
// ── 为什么认领可以重复（不能做成一次性）──────────────────
//
// 2026-10-06 修正。原先 `claim` 认领一次就置 `claimed` 永久失效，想法是
// "同一条通知只豁免一次"。但唤醒轮的 `出口说明` 恰恰在鼓励他调工具，而
// Operit 处理工具调用时，会用**同一个 messages 数组**再发一次请求 ——
// 此时最后一条 `role:'user'` **仍然是那条通知**（工具结果走 `role:'tool'`，
// 不算 user）。一次性认领会让第二次请求开始全部漏认，三个 bug 原样复现：
//   ① 多跑一次 connection 缓解（一次「她开口」的兜底）—— 唤醒的意义当场清掉；
//   ② 判定器把通知当她的发言打分；
//   ③ 回环让位失效 → reactive 此刻块又叠在 proactive 通知上。
// 而"防陈旧文本"这件事，TTL 与"原文必须完整出现"已经各自守住了，
// 一次性是多余的严格。所以改成：**TTL 内同一条通知可被重复认领**。
// `claims` 保留为计数，只用于排查（正常唤醒轮 = 1，调了工具会 > 1）。
//
// 反向风险（真人原样转发这条通知）在工程上可忽略：通知只出现在系统侧通道，
// 她看不到（`hide_user_message: true`）；且桥的注入块从不进她的输入。
// 退一步说，即便她真把整条通知连尾句一起原样贴回来，代价也只是那一轮
// 少一次 connection 缓解、少注入一个块 —— 可接受。

const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000; // 2 小时
const DEFAULT_MAX = 20;

function normText(s) {
  return String(s == null ? '' : s).replace(/\s+/g, '');
}

/**
 * @param {object} [opts]
 * @param {number} [opts.ttlMs]  通知记忆时长，默认 2 小时
 * @param {number} [opts.max]    同时记忆的条数上限，默认 20
 * @param {function} [opts.now]  取当前时间（便于测试注入）
 */
function createLoopbackGuard(opts) {
  const o = opts || {};
  const ttlMs = Number.isFinite(o.ttlMs) ? o.ttlMs : DEFAULT_TTL_MS;
  const max = Number.isFinite(o.max) ? o.max : DEFAULT_MAX;
  const now = typeof o.now === 'function' ? o.now : () => Date.now();

  /**
   * @type {Array<{at:number, scene:string, reason:?string, notice:string,
   *               norm:string, claimed:boolean, claims:number, lastClaimAt:?number}>}
   */
  const fired = [];

  function prune() {
    const cutoff = now() - ttlMs;
    while (fired.length && fired[0].at < cutoff) fired.shift();
    while (fired.length > max) fired.shift();
  }

  /** 登记一条刚发出的通知。返回登记项。 */
  function remember(entry) {
    const e = entry || {};
    const notice = String(e.notice == null ? '' : e.notice);
    if (!notice) return null;
    const rec = {
      at: now(),
      scene: e.scene || 'contact',
      reason: e.reason || null,
      notice,
      norm: normText(notice),
      claimed: false,
      claims: 0,
      lastClaimAt: null,
    };
    fired.push(rec);
    prune();
    return rec;
  }

  /**
   * 认领：这条文本里是否含有"尚未过期"的通知原文。
   *
   * ⚠️ 同一条通知在 TTL 内**可被重复认领** —— 唤醒轮调工具时，Operit 会用
   *    同一个 messages 再发请求，最后一条 user 仍是那条通知，第二次起必须照样命中。
   *    （原因详见文件头"为什么认领可以重复"。）
   *
   * @param {string} text 最后一条 user 消息的原文
   * @returns {object|null} 命中的登记项，否则 null
   */
  function claim(text) {
    // 读取时也要过一遍淘汰：进程若长时间没有新通知发出，
    // 只靠 remember 侧清理会让过期项一直留在表里。
    prune();
    const n = normText(text);
    if (!n) return null;
    // 从最新往前找：多条通知同时在表里时，优先认领最近发出的那条。
    for (let i = fired.length - 1; i >= 0; i--) {
      const e = fired[i];
      if (!e.norm) continue;
      if (n.includes(e.norm)) {
        e.claimed = true;
        e.claims += 1;
        e.lastClaimAt = now();
        return e;
      }
    }
    return null;
  }

  return {
    remember,
    claim,
    size: () => fired.length,
    list: () => fired.slice(),
  };
}

module.exports = { createLoopbackGuard, normText, DEFAULT_TTL_MS, DEFAULT_MAX };
