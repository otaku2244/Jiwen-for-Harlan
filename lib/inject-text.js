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
//   · 不给数字、不给维度英文名（valence/arousal/pride/connection）—— 给了数模型会开始报数
//     但**簇名要给**（excited/pleased/…）：它是当前状态的坐标，不是维度，模型靠它定位
//   · 不得出现可被"报备"进对话的环境描述、不得伪造实体在场
//   · 不出现索取回应的句式
//   · 桥不碰"活动"，只发状态 + 边界句；活动由 Operit 工作流侧自理
//   · 边界句三场景统一，只声明"这是内在心绪，不宜元说明"，不声明"以下是她的消息"
//
// 头尾措辞变更（2026-10-05 / 10-06）：
//   旧头：【积温·此刻｜参考不是指令】   旧尾：以上是系统通知，非用户消息，不用提及相关内容。
//   二版头：【积温·此刻】              二版尾：以上是内在心绪和潜意识的自然流露，切勿对她复述或提及此状态。
//   三版头：【积温·此刻】              三版尾：此状态为潜意识的底色沉淀，自然浸润在回应里，不作任何元说明或刻意提及。
//   四版头：【积温·此刻】              四版尾：【此状态为潜意识的底色沉淀，自然浸润在回应里，不作任何元说明或刻意提及。】
//   原因：① 去掉"参考不是指令""系统通知"这类工单味的元话语；
//         ② 尾句只管"别复述"，刻意**不写**"以下是她的消息"——
//            因为用户消息后面可能紧跟文件传输的文本/地址，写"以下是她的消息"会把文件信息
//            误纳入"她的话"语义，产生错位；
//         ③ 三版比二版多一层正向指引（"自然浸润在回应里"= 该以什么方式在场）。
//            但三版与二版真正的差别在**禁止对象**：二版禁"复述此状态"，三版禁"元说明"。
//            ⚠️ 这个区别别改回去：模型说"我现在心情不错"是**正向反馈**（状态融进了表达），
//            不是要防的东西；要防的是**脚手架暴露**——"系统又告诉我…""根据我的设定…"
//            "参数显示…"这类。二版的"复述此状态"会把合法的状态自述一起误伤。
//            改措辞时以"模型能不能直接照做"为准，文采次之。
//            ⚠️ 也不要在提示词里列举反例（如"别说'系统提示'"）——那等于把那些词
//            直接摆到模型眼前，对 Flash 级模型反而是一种 priming。
//         ④ 四版给整句套上【】：块头是【积温·X】，块尾也落在【】上，
//            视觉上夹成一个完整段——既帮模型分清"哪句是系统侧材料"，
//            也免得尾句被当成她的话的开头（见 stripJiwenBlocks 的剥离逻辑）。
//   中间档位行（意义行）保持原样不动：模型念不念、混不混，由头尾边界句决定，与档位行文体无关。

// ── 五轴 → 可读短词 ──
// 与 tone-wrap.js 的阈值保持一致
const CONSIDER_LINE = 0.35;

const BOUNDARY_LINE = '【此状态为潜意识的底色沉淀，自然浸润在回应里，不作任何元说明或刻意提及。】';

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
 *   find_activity（独处）→ sceneOverride.find_activity[reason]，语义是「她不在，这是你自己的时间」
 *                          reason: pride_block / low_valence / high_arousal
 *
 * 两个场景都追加一句「出口说明」（proactiveOutlet，见 tone-harlan.json）：
 * 告诉他这件事可以怎么做（发消息 / 用工具 / 自言自语），插在正文之后、边界句之前。
 * 只在主动唤醒里加 —— 此刻块他已经在回话了，不需要出口指引。
 *
 * @param {object} state
 * @param {object} toneGrid
 * @param {object} [opts] { scene: 'contact'|'find_activity', reason: string }
 * @param {object} [sceneOverride] tone-harlan.json 的 sceneOverride 段
 * @param {object} [proactiveOutlet] tone-harlan.json 的 proactiveOutlet 段
 */
const SCENE_TAG = {
  contact: '找她',
  find_activity: '独处',
};

function buildProactiveNotice(state, toneGrid, opts, sceneOverride, proactiveOutlet) {
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

  // 出口说明：接在正文后面。正文为空时它就是正文。
  // 没有它（老配置 / 旧调用）时行为不变。
  const outlet = (proactiveOutlet && proactiveOutlet[scene]) || '';
  if (outlet) body = body ? body + '\n' + outlet : outlet;

  return composeBlock(tag, state, body);
}

// ── 剥离积温块 ────────────────────────────────────
//
// 为什么要剥：积温块是拼进 user 消息正文的，会随请求体一路流转，
// 也可能被上游记忆库当"她说的话"存进历史再随下一轮回流。
// 任何"读对话内容"的地方（判定器、检索、续接材料）都必须先剔掉它，
// 否则积温会读到自己上一轮的输出，变成一个自我锚定的闭环。
//
// 形态：【积温·XXX】 + 档位行 + 正文 + 尾句，整体占若干行。
// 遍历按行：遇到块头进块，遇到尾句或空行出块，块内行全部丢弃。
//
// 尾句三版都认（历史里可能残留旧版块）：
//   三版 此状态为潜意识的底色沉淀，…
//   二版 以上是内在心绪和潜意识的自然流露，…
//   一版 以上是系统通知，非用户消息，…
const BLOCK_HEAD_RE = /^\s*【积温·[^】]*】\s*(.*)$/;
// 尾句要同时认「带方括号」与「不带方括号」两种写法：
// 四版起尾句整句用【】包住（与块头呼应，让模型一眼看出这是有头有尾的独立段），
// 但 raw_events 里残留着一、二、三版的无括号块，剥离逻辑必须照样认得。
const BLOCK_TAIL_RE = /^\s*【?\s*(此状态为潜意识的底色沉淀|以上是内在心绪和潜意识的自然流露|以上是系统通知)/;

function stripJiwenBlocks(text) {
  if (!text) return '';
  const out = [];
  let inBlock = false;
  for (const line of String(text).split('\n')) {
    if (!inBlock) {
      const m = line.match(BLOCK_HEAD_RE);
      if (m) {
        // 块头同行若已带尾句，视作一行块，直接丢弃
        inBlock = !BLOCK_TAIL_RE.test(m[1] || '');
        continue;
      }
      out.push(line);
      continue;
    }
    // 块内
    if (BLOCK_TAIL_RE.test(line)) { inBlock = false; continue; }
    if (line.trim() === '') { inBlock = false; out.push(line); continue; }
    // 其余块内正文丢弃
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

module.exports = {
  buildInjectionBlock,
  buildProactiveNotice,
  meaningfulLines,
  stripJiwenBlocks,
  BOUNDARY_LINE,
};
