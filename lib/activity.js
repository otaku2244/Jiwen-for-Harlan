'use strict';
// 活动登记 —— 描述层段4（「手上在做什么」）的唯一真实来源
//
// ── 为什么需要这一层 ────────────────────────────────────────
// 段4 读的是 `immersion` + `lastActivity`（见 lib/describe.js 的 immersionLine）。
// 桥此前从不调 `setActivity`，于是 `immersion` 恒 0、`lastActivity` 恒 null
// → 段4 **恒定输出**「没在做什么特别的事。」这一句，等于白占一行。
//
// 而引擎侧本来就是为这件事留的口子：`immersionMap`（vendor/jiwen.js:122）
// 的注释是「外部行为更新沉浸度」。上游的设计里，活动枚举是
// `reading / search / browse_snitch / browse / observe`，
// 对应 immersion 0.6 / 0.4 / 0.35 / 0.35 / 0.15。
//
// 我们只登记**真实发生过的**一种活动：冲浪（surf）。
// 理由：find_activity 越阈 = 「他该回头去找点事做」，而冲浪是目前
// find_activity 唯一的真实行动（`bridge.js` 的 spawnSurf）。
// 除了它，桥里没有任何"他正在做什么"的事实来源 ——
// 编一个出来就违背了 describe.js 里「不编造活动」的原则。
//
// ── 两条硬约束（改调用点时别破坏）─────────────────────────────
//   ① 只在**子进程真的起来了**之后记（`child.on('spawn')`），
//      不在"打算 spawn"时记。否则段4 会声称一件没发生的事：
//      entry 路径配错、spawn EACCES 这类情况下进程根本没跑起来。
//   ② 记的是 `label`（中文短语），不是 `type`（英文枚举）。
//      `type` 只用来查 immersionMap 取值，它不该出现在模型可见的文本里
//      —— 块里出现 `search` 这种英文枚举，模型会开始复述它。
//
// ── 它和 connection 的关系 ──────────────────────────────────
// `setActivity` 里有一处 `activityConnectionRelief` 会扣 connection，
// 本仓库**没有**开启它（vendor 默认 0，bridge.js 的 rates 也没传）——
// 冲浪是"他自己想做的事"，不该被算成缓解惦记的手段。
// 另外 `sameType` 判断保证同一种活动连续登记不会重复扣减。

/**
 * 登记一次活动。
 * @param {object} jiwen 积温实例（只需有 setActivity 方法）
 * @param {object} spec { type, label } —— type 查 immersionMap，label 进渲染
 * @param {function} [log] 日志函数 (level, msg) => void
 * @returns {Promise<boolean>} true = 记上了；false = 参数不全或引擎报错
 */
async function recordActivity(jiwen, spec, log) {
  const s = spec || {};
  const type = String(s.type == null ? '' : s.type).trim();
  const label = String(s.label == null ? '' : s.label).trim();
  // 参数不全时**静默跳过**而不是记一个空活动：
  // 段4 的渲染依赖 label，记成空等于把 immersion 抬起来却什么都不说 ——
  // 那会让段4 既不出 doing 也不出 idle（immersion 落在 0.1~0.3 的死带里）。
  if (!type || !label) return false;
  if (!jiwen || typeof jiwen.setActivity !== 'function') return false;
  try {
    await jiwen.setActivity(type, label);
    if (log) log('INFO', `activity recorded: ${type}（${label}）`);
    return true;
  } catch (e) {
    // 记不上不该影响主流程（积温状态是辅助材料，不是业务事实）
    if (log) log('WARN', 'setActivity failed: ' + e.message);
    return false;
  }
}

module.exports = { recordActivity };
