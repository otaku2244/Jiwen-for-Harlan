'use strict';
// 积温状态 → 注入文本
//
// 两种投递形态：
//   1. buildInjectionBlock —— 用户开口时的「此刻块」（reactive），拼在最后一条 user 消息前
//   2. buildProactiveNotice —— 阈值触发时的主动唤醒块（proactive），作为一条 user 消息注入对话
//
// 定位说明（重要）：
//   这两块是**喂给模型的系统侧材料**，属于幕后输入，不是 Harlan 在说话。
//   因此这里的文案要求是：清晰、准确、无歧义——让模型正确理解当前状态。
//   人设里的"语言保留瑕疵/允许半截话"约束，对象是 Harlan 与椰椰子的对话正文，
//   由 tone-harlan.json 的行为指令去驱动，与本节无关。
//
// 设计约束：
//   · 不给数字、不给维度英文名 —— 给了数模型会开始报数
//   · 不得出现可被"报备"进对话的环境描述、不得伪造实体在场
//   · 不出现索取回应的句式
//   · 桥不碰"活动"，只发状态 + 边界句；活动由 Operit 工作流侧自理
//   · 边界句三场景统一，只声明"这是内在心绪，切勿复述"，不声明"以下是她的消息"
//
// 头尾措辞变更（2026-10-05）：
//   旧头：【积温·此刻｜参考不是指令】   旧尾：以上是系统通知，非用户消息，不用提及相关内容。
//   新头：【积温·此刻】                新尾：以上是内在心绪和潜意识的自然流露，切勿对她复述或提及此状态。
//   原因：① 去掉"参考不是指令""系统通知"这类工单味的元话语；
//         ② 尾句只管"别复述"，刻意**不写**"以下是她的消息"——
//            因为用户消息后面可能紧跟文件传输的文本/地址，写"以下是她的消息"会把文件信息
//            误纳入"她的话"语义，产生错位。
//   中间档位行（意义行）保持原样不动：模型念不念、混不混，由头尾边界句决定，与档位行文体无关。

// ── 五轴 → 可读短词 ──
// 与 tone-wrap.js 的阈值保持一致
const CONSIDER_LINE = 0.35;

const BOUNDARY_LINE = '以上是内在心绪和潜意识的自然流露，切勿对她复述或提及此状态。';

function labelConnection(c) {
  if (c < 0.20) return '悠闲';
  if (c < 0.35) return '留意';
  if (c < 0.50) return '想念';
  return '挡不住';
}
function labelPride(p) {
  if (p > 0.8) return '完全收着';
  if (p > 0.5) return '收着';
  if (p > 0.3) return '留着一点余地';
  if (p > 0.1) return '略收';
  if (p > -0.1) return '平常';
  if (p > -0.3) return '松了';
  return '完全不设防';
}
function labelValence(v) {
  if (v > 0.3) return '舒展';
  if (v < -0.3) return '沉';
  return '中性';
}
function labelArousal(a) {
  if (a > 0.3) return '起波';
  if (a < -0.3) return '慵懒';
  return '平静';
}

// ── 只挑"值得说"的行，避免每次都把五行塞满 ──
function meaningfulLines(state) {
  const lines = [];
  const { connection: c, pride: p, valence: v, arousal: a } = state;

  // 心情（常态也报，这是基线）
  lines.push(`心情：${labelValence(v)}。`);

  // 姿态（只在非中性时提）
  if (p > 0.3) lines.push(`姿态：${labelPride(p)}。`);
  else if (p < -0.1) lines.push(`姿态：${labelPride(p)}。`);

  // 激活度（只在极端时提）
  if (a > 0.3) lines.push(`心跳：${labelArousal(a)}。`);
  else if (a < -0.3) lines.push(`心跳：${labelArousal(a)}。`);

  // 想念（只在超过留意时提；越线时换更贴切的档位词）
  if (c >= CONSIDER_LINE) lines.push(`想念：${labelConnection(c)}。`);
  else if (c >= 0.20) lines.push(`想念：${labelConnection(c)}。`);

  return lines;
}

/**
 * 通用骨架：场景标签 + 五轴档位词 + 场景正文 + 边界句。
 * @param {string} sceneTag 【积温·XX｜参考不是指令】里的 XX
 * @param {object} state
 * @param {string} body 已按场景取好的正文（语调网格指令 / 场景覆盖尾注）
 */
function composeBlock(sceneTag, state, body) {
  const lines = meaningfulLines(state);
  const parts = [];
  parts.push(`【积温·${sceneTag}】`);
  if (lines.length) parts.push(lines.join(''));
  if (body) parts.push(body);
  parts.push(BOUNDARY_LINE);
  return parts.join('\n');
}

/**
 * 生成「此刻块」。拼在最后一条 user 消息前面。
 * @param {object} state 积温状态
 * @param {object} toneGrid 语调网格实例（用 getStyleGuidance 取风格指令）
 */
function buildInjectionBlock(state, toneGrid) {
  let style = '';
  try {
    style = toneGrid ? toneGrid.getStyleGuidance(state) : '';
  } catch (_) { style = ''; }
  return composeBlock('此刻', state, style);
}

/**
 * 生成主动唤醒块。由 Operit 工作流作为一条 user 消息注入对话。
 *
 * 场景 → 正文来源：
 *   contact（找她）      → toneGrid.getPromptContext（沿用 urgencyBoost 的 proactive 列）
 *   find_activity（自留地）→ sceneOverride.find_activity[reason]，语义是「她不在，这是你的时间」
 *                            reason: pride_block / low_valence / high_arousal
 *
 * @param {object} state
 * @param {object} toneGrid
 * @param {object} [opts] { scene: 'contact'|'find_activity', reason: string }
 * @param {object} [sceneOverride] tone-harlan.json 的 sceneOverride 段
 */
const SCENE_TAG = {
  contact: '找她',
  find_activity: '自留地',
};

function buildProactiveNotice(state, toneGrid, opts, sceneOverride) {
  const o = opts || {};
  const scene = o.scene || 'contact';
  const tag = SCENE_TAG[scene] || '自主唤醒';

  let body = '';
  if (scene === 'contact') {
    try {
      body = toneGrid ? toneGrid.getPromptContext(state) : '';
    } catch (_) { body = ''; }
  } else {
    const tbl = (sceneOverride && sceneOverride[scene]) || {};
    body = tbl[o.reason] || tbl.default || '';
  }

  return composeBlock(tag, state, body);
}

module.exports = {
  buildInjectionBlock,
  buildProactiveNotice,
  meaningfulLines,
  BOUNDARY_LINE,
};
