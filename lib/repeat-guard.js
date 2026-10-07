'use strict';
// ════════════════════════════════════════════════════
// 重复抑制 —— 两类"短时间内其实是同一件事"
//
//  1) createSceneCooldown —— 场景冷却
//     触发源是**持续状态**时用。典型：find_activity 由"惦记 + 嘴硬"驱动，
//     状态能连着挂 1~2 小时，而 tick 每 5 分钟判一次 →
//     不加冷却就是 51~110 条/天，日上限瞬间打光，把 contact 一起挤没。
//
//     ⚠️ 只作用于**触发侧**（tick）。投递侧（surf 回投的产物）不拦 ——
//        否则 spawn 那一刻已经 mark，surf 跑完回来必然还在冷却内，产物全被吃掉。
//
//  2) createDialogDedup —— 判定器去重
//     工具轮里 Operit 会用**同一份 messages** 再发一次请求，最后 4 条
//     user/assistant 一字未变，判定器于是把同一段对话判 N 次、delta 叠加 N 次。
//     （2026-10-07 实测：同一轮判 4 次，pride 该掉 0.12 实际掉了 0.66。）
//
// 两个都是**进程内内存**，重启即清空 —— 最多多放行一次，代价可接受；
// 要跨重启持久化得进 state.json，不值当。
// ════════════════════════════════════════════════════

// ── 场景冷却 ──────────────────────────────────────
// minutes <= 0 表示关闭（ok() 恒真）。
// now 可注入，便于单测。
function createSceneCooldown(opts) {
  const o = opts || {};
  const minutes = Number(o.minutes) || 0;
  const now = typeof o.now === 'function' ? o.now : Date.now;
  const last = Object.create(null);

  return {
    // 该场景现在能不能触发
    ok(scene) {
      if (!(minutes > 0)) return true;
      const t = last[scene];
      return !t || (now() - t) >= minutes * 60000;
    },

    // 记账。**只在真正执行前调用** —— 被静默时段/日上限挡掉的轮次不该吃掉冷却。
    mark(scene) { last[scene] = now(); },

    // 还剩几分钟（日志用）
    remainingMinutes(scene) {
      if (!(minutes > 0)) return 0;
      const t = last[scene];
      if (!t) return 0;
      const left = minutes - (now() - t) / 60000;
      return left > 0 ? left : 0;
    },

    reset(scene) {
      if (scene) delete last[scene];
      else for (const k in last) delete last[k];
    },

    snapshot() { return Object.assign(Object.create(null), last); },
    minutes() { return minutes; },
  };
}

// ── 判定器去重 ────────────────────────────────────
// key 取「最后一条 user 文本」：工具轮里它一字未变，
// 真出现新的一轮（她说了新话）它必变。
// windowSeconds 是 TTL 兜底：同一句话隔了很久又出现，仍应重新判。
// windowSeconds <= 0 表示关闭（accept() 恒真）。
function createDialogDedup(opts) {
  const o = opts || {};
  const windowSeconds = Number(o.windowSeconds) || 0;
  const now = typeof o.now === 'function' ? o.now : Date.now;
  let lastKey = null;
  let lastAt = 0;

  return {
    // true = 该喂判定器；false = 与上一轮同一段对话，跳过
    // ⚠️ 命中即记账：setImmediate 有异步窗口，不先记账会并发放行两条。
    accept(key) {
      const k = String(key == null ? '' : key);
      if (!k) return false;
      if (windowSeconds > 0 && k === lastKey && (now() - lastAt) < windowSeconds * 1000) {
        return false;
      }
      lastKey = k;
      lastAt = now();
      return true;
    },

    reset() { lastKey = null; lastAt = 0; },
    snapshot() { return { key: lastKey, at: lastAt }; },
    windowSeconds() { return windowSeconds; },
  };
}

module.exports = { createSceneCooldown, createDialogDedup };
