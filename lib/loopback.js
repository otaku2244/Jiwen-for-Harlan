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
// 不识别就会犯两个错：
//   ① 多余执行 resetConnection() —— 把 connection 硬归 0，抹掉这次唤醒本身的意义；
//   ② 把唤醒通知当"她的发言"喂给判定器打分 —— 凭空产生一次错误的情绪漂移。
//
// ── 判据为什么用"原文匹配" ─────────────────────────
//
// 通知是桥自己生成的，原文在手上，所以直接按原文认领，不猜格式。
// 归一化去掉全部空白字符再比对：Operit 侧加前缀、加后缀、把换行压成空格、
// 或者包一层引用标记，都不影响命中。
//
// 两条保险：
//   · claimed —— 同一条通知只豁免一次，重复投递不会反复绕过守卫；
//   · TTL + 条数上限 —— 通知在队列里滞留过久（或进程长跑）后自动失忆，
//     杜绝"很久以前的通知文本"被误认成回环。
//
// 反向风险（真人原样转发这条通知）在工程上可忽略：通知只出现在系统侧通道，
// 她看不到；且桥的注入块从不进她的输入。

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

  /** @type {Array<{at:number, scene:string, reason:?string, notice:string, norm:string, claimed:boolean}>} */
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
    };
    fired.push(rec);
    prune();
    return rec;
  }

  /**
   * 认领：这条文本里是否含有"尚未被认领过的"通知原文。
   * @returns {object|null} 命中的登记项（已标记 claimed），否则 null
   */
  function claim(text) {
    // 读取时也要过一遍淘汰：进程若长时间没有新通知发出，
    // 只靠 remember 侧清理会让过期项一直留在表里。
    prune();
    const n = normText(text);
    if (!n) return null;
    for (let i = fired.length - 1; i >= 0; i--) {
      const e = fired[i];
      if (e.claimed || !e.norm) continue;
      if (n.includes(e.norm)) {
        e.claimed = true;
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
