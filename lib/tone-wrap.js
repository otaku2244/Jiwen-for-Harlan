'use strict';
// 语调网格包装层 —— 修「pride 定基础档、connection 只补尾注」的脱节
//
// 脱节现象（实测）：
//   pride=0.15（落在"平常"区间）+ connection=0.62（已过强制线）
//   基础档取到 neutral / tier2「得体、温和。保持舒适的距离…正常的相处状态」，
//   再由 urgency 尾注补一句"她很久没出现了…"。
//   两句话气质相反：基础档说"正常相处"，尾注说"压不住想找她"。
//
// 修法（轻修，不改 vendor）：
//   当 connection 越过 considerContact(0.35) 线时，判定"开口动机"是否成立，
//   按开口动机覆盖基础档；urgency 尾注保留（它本来就在描述 connection 侧）。
//   · c ≥ forceContact(0.50)  → 强制开口，完全覆盖
//   · considerContact ≤ c < forceContact 且 pride < prideBlock(0.50) → 过了 pride 闸门，完全覆盖
//   · considerContact ≤ c < forceContact 且 pride ≥ prideBlock → pride 挡住开口
//       → 不覆盖（此时"端着"的基础档是对的），也无 urgency 尾注
//
// 注意：开口动机文案从 config/tone-harlan.json 的 "contactOverride" 读，
//       由我们自己维护，仍属"框架用积温、文案自己写"的边界内。

const FORCE_LINE = 0.50;   // 与 vendor jiwen 的 forceContact 一致
const CONSIDER_LINE = 0.35; // 与 vendor jiwen 的 considerContact 一致
const PRIDE_BLOCK = 0.50;  // 与 vendor jiwen 的 prideBlock 一致

/**
 * @param {object} toneGrid vendor createToneGrid 实例
 * @param {object} [override] { reactive: {...}, proactive: {...} } 开口动机文案
 */
function createToneWrapper(toneGrid, override) {
  const ov = override || {};
  const reactiveOv = ov.reactive || {};
  const proactiveOv = ov.proactive || {};

  // 判定当前状态是否处于"开口动机成立"的区间
  function contactMotive(state) {
    const c = state.connection;
    const p = state.pride;
    if (c >= FORCE_LINE) return 'forced';
    if (c >= CONSIDER_LINE && p < PRIDE_BLOCK) return 'normal';
    return null; // pride 挡住，或未到线
  }

  function wrap(mode, picker) {
    return function (state) {
      let base = '';
      try {
        base = picker(state) || '';
      } catch (_) { base = ''; }

      const motive = contactMotive(state);
      if (!motive) return base;

      const table = mode === 'proactive' ? proactiveOv : reactiveOv;
      const line = table[motive];
      if (!line) return base;

      // 覆盖基础档：只保留 urgency 尾注（它在说 connection 侧，与本覆盖不冲突）
      const tail = urgencyTail(base);
      return tail ? line + '\n' + tail : line;
    };
  }

  // 从 vendor 输出里切出 urgency 尾注 —— vendor 输出结构是
  //   [基础档段落（可能多行）] + [urgency 行（可选）]
  // 基础档来自 profile[prideTier]，是同一批次 push 进去的数组；
  // urgency 行来自 urgency[level][mode]，固定是最后一行。
  // 我们按"末行是否等于任一 urgency 文案"来判断。
  const allUrgency = new Set();
  try {
    const cfg = toneGrid.config && toneGrid.config.urgency;
    if (cfg) {
      for (const lvl of Object.keys(cfg)) {
        for (const m of ['reactive', 'proactive']) {
          const t = cfg[lvl] && cfg[lvl][m];
          if (typeof t === 'string') allUrgency.add(t);
        }
      }
    }
  } catch (_) { /* 拿不到就不切尾注，退化为完全覆盖 */ }

  function urgencyTail(text) {
    if (!text) return '';
    const lines = text.split('\n');
    if (lines.length <= 1) return '';
    const last = lines[lines.length - 1].trim();
    if (allUrgency.has(last)) return last;
    return '';
  }

  return {
    getStyleGuidance: wrap('reactive', (s) => toneGrid.getStyleGuidance(s)),
    getPromptContext: wrap('proactive', (s) => toneGrid.getPromptContext(s)),
    // 透传原始查表，便于调试对照
    raw: toneGrid,
    contactMotive,
  };
}

module.exports = { createToneWrapper, FORCE_LINE, CONSIDER_LINE, PRIDE_BLOCK };
