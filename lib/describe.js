'use strict';
// 描述层 —— 「我此刻在什么处境」的四段陈述
//
// ── 它从哪来 ────────────────────────────────────────────────
// 结构照抄引擎作者 `vendor/jiwen.js:751` 的 `defaultPromptContext`：
//   connection 4 档 / pride 5 档 / V×A 4 象限 + 2 / immersion 2 档
// 文案在 `config/tone-harlan.json` 的 `describe` 段，本文件只负责渲染。
// 之所以读 config 而不写死：文案是运营面，改措辞不该动代码 —— 与 45 格同理。
//
// ── 它为什么存在 ────────────────────────────────────────────
// 我们用的是作者 README 推荐的「两个槽都填 tone-grid」写法：45 格把
// `getPromptContext` / `getStyleGuidance` 两个槽都占了，代价是**描述层消失**。
// 于是块里只剩「用什么语气说话」，没有「我此刻在什么处境」。
// 2026-10-08 拍板补回这一层，并同时退役 contactOverride / urgencyBoost
// （它们就是在这块空白上打的补丁，且打歪了 —— 见各自 config 注释）。
//
// ── 与 45 格的分工（别让两边抢活）──────────────────────────
//   · 描述层 = 处境。陈述句、零祈使。「我在什么状态」
//   · 45 格 = 行为指令。全是祈使。「那就该怎么说话」
// 作者 GUIDE.md 对这个槽的原则同样适用：它不是角色设定、不是内心独白，
// 而是给 LLM 的行为指令 —— 所以别写成情绪标签（作者的坏例是
// 『心情不错，对她比较温柔。』，好例是『像只吃饱喝足的猫。』）。

// 与 vendor `tone-grid.js` 的 classifyCluster 阈值保持一致（±0.3）。
const MOOD_BAND = 0.3;
// 沉浸度：与 vendor 的 immersion 消费口径一致（>0.3 算在做事，<0.1 算空着）。
const IMMERSION_BUSY = 0.3;
const IMMERSION_IDLE = 0.1;

// 档位选取：`max` 是**开区间上界**（`value < max` 命中），末项不带 max = 兜底档。
// 用 `<` 而不是 `<=` 是为了与 vendor 的阈值口径一致：
//   classifyUrgency 是 `c >= 0.20 → aware`，所以 c=0.20 该落到「< 0.35」那一档，
//   而不是「< 0.20」那一档。边界不一致会让描述层与 45 格在同一个 c 上错开一格。
function pick(list, value) {
  if (!Array.isArray(list) || !list.length) return '';
  for (const item of list) {
    if (item.max === undefined || item.max === null) return item.text || '';
    if (value < item.max) return item.text || '';
  }
  return list[list.length - 1].text || '';
}

/**
 * @param {object} section config/tone-harlan.json 的 `describe` 段
 */
function createDescriber(section) {
  const cfg = section || {};
  const connection = cfg.connection || [];
  const pride = cfg.pride || [];
  const mood = cfg.mood || {};
  const immersion = cfg.immersion || {};

  function moodLine(v, a) {
    if (v > MOOD_BAND && a > MOOD_BAND) return mood.excited || '';
    if (v > MOOD_BAND && a < -MOOD_BAND) return mood.content || '';
    if (v < -MOOD_BAND && a > MOOD_BAND) return mood.agitated || '';
    if (v < -MOOD_BAND && a < -MOOD_BAND) return mood.depressed || '';
    if (v < -MOOD_BAND) return mood.low || '';       // v 单轴低
    if (v > MOOD_BAND) return mood.high || '';       // v 单轴高
    return '';                                        // |v| ≤ 0.3 且 |a| ≤ 0.3 → 不输出
  }

  function immersionLine(state) {
    const lv = typeof state.immersion === 'number' ? state.immersion : 0;
    const act = state.lastActivity;
    const label = act && act.label ? String(act.label) : '';
    // 只在「真在做点什么」且知道做的是什么时才说 —— 不编造活动。
    if (lv > IMMERSION_BUSY && label) {
      return String(immersion.doing || '').replace('{label}', label);
    }
    if (lv < IMMERSION_IDLE) return immersion.idle || '';
    return '';
  }

  /**
   * @param {object} state 五轴状态
   * @param {object} [opts] { withConnection, withImmersion }
   *   withConnection=false 用于「此刻块」（reactive）。段1 的问句全是**时间维度**的
   *   ——「她刚走，还没过多久。」「她很久没动静了。」——而此刻块的场景是"她刚说完这一句"，
   *   这些句子一句都不成立。段1 只留给主动唤醒（proactive）。
   *   （历史注：2026-10-08 之前这里还叠着一条物理理由 —— 那时桥每轮 resetConnection()
   *     把 c 硬置 0，段1 出了也是恒定一句。reset 已撤，c 现在是真值，理由只剩上面这条。）
   *
   *   withImmersion=false 用于「独处 + 有产物」的块。段4 说的是「刚才在网页检索。」
   *   （真来源是 `lib/activity.js` 登记的冲浪活动），而产物正文第一行就是
   *   「之前独处冲浪时发现的东西：」—— **同一次冲浪的两种说法**，并列就是同一件事说两遍。
   *   两者必居其一：产物在时留产物（它带了结果），无产物时留段4（它交代他手头在忙什么）。
   *   ⚠️ 只在有产物的那一支关掉，别全局关 —— 段4 的 idle 句（「没在做什么特别的事。」）
   *     与 reactive 此刻块的 doing 句（她开口时，他知道自己刚做完一件事）都还有用。
   * @returns {string[]} 行数组，调用方 join('\n') 后拼进块
   */
  return function describeState(state, opts) {
    const o = opts || {};
    const s = state || {};
    const lines = [];

    if (o.withConnection !== false) {
      lines.push(pick(connection, Number(s.connection) || 0));
    }
    lines.push(pick(pride, Number(s.pride) || 0));
    const m = moodLine(Number(s.valence) || 0, Number(s.arousal) || 0);
    if (m) lines.push(m);
    if (o.withImmersion !== false) {
      const im = immersionLine(s);
      if (im) lines.push(im);
    }

    return lines.filter((l) => l && l.trim());
  };
}

module.exports = { createDescriber, MOOD_BAND, IMMERSION_BUSY, IMMERSION_IDLE };
