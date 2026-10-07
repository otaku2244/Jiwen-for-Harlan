'use strict';
// 描述层渲染对照 —— 生产实渲染，只写 md，不接生产路径。
//
// 用法：node _test/draft_ctx.js  → 写 _test/ctx_draft.md
//
// 历史：本文件原本是「四段描述层草案」的候选对照（当时文案手抄在这里，等用户拍板）。
// 2026-10-08 变体② 落地后转为**验收对照**：
//   · 文案不再手抄 —— 全部从 config/tone-harlan.json 的 `describe` 段动态取
//   · 块一律由生产函数渲染（buildInjectionBlock / buildProactiveNotice）
//
// 原则：
//   · 45 格文案一律从 config 动态取，**不手抄**
//   · 块一律调生产函数
//   · 本文件的唯一手写处是 SAMPLES（状态样本）

const fs = require('fs');
const path = require('path');

const { createToneGrid } = require('../vendor/tone-grid.js');
const { createDescriber } = require('../lib/describe.js');
const {
  buildInjectionBlock,
  buildProactiveNotice,
} = require('../lib/inject-text.js');

const cfg = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'config', 'tone-harlan.json'), 'utf8')
);
const grid = createToneGrid({ profiles: cfg.profiles, urgencyBoost: cfg.urgencyBoost });
const desc = createDescriber(cfg.describe);

// ── 状态样本 ──
const S = (c, p, v, a, imm, act) => ({
  connection: c, pride: p, valence: v, arousal: a,
  immersion: imm == null ? 0 : imm,
  lastActivity: act || null,
});

const SAMPLES = [
  ['此刻 · pleased 端得明显', 'reactive', S(0, 0.65, 0.45, -0.05)],
  ['此刻 · neutral 照常', 'reactive', S(0, 0.20, 0.05, 0.05)],
  ['此刻 · depressed 力竭', 'reactive', S(0, 0.65, -0.60, -0.60)],
  ['此刻 · excited 热度满', 'reactive', S(0, 0.05, 0.55, 0.60)],
  ['找她 · c=0.25 未过线', 'contact', S(0.25, 0.10, 0.05, 0.05)],
  ['找她 · c=0.42 p=0.15（过去被 contactOverride 顶掉的那一格）', 'contact', S(0.42, 0.15, 0.05, 0.05)],
  ['找她 · c=0.42 p=0.65（端着）', 'contact', S(0.42, 0.65, -0.05, 0.10)],
  ['找她 · c=0.62 强制线以上', 'contact', S(0.62, 0.05, 0.35, -0.40)],
  ['独处 · pride_block', 'find_activity', S(0.42, 0.62, -0.05, 0.05), 'pride_block'],
  ['独处 · low_valence', 'find_activity', S(0.10, 0.20, -0.80, -0.50), 'low_valence'],
];

const out = [];
const w = (s) => out.push(s == null ? '' : s);

w('# 描述层 · 生产实渲染对照');
w('');
w('> 全部文案（描述层 + 45 格）与整块均由 `config/tone-harlan.json` 与 `lib/inject-text.js`');
w('> 实时渲染，**零手抄**。本文件由 `node _test/draft_ctx.js` 生成。');
w('');
w('> 2026-10-08 变体② 已落地：描述层 + 45 格，退役 `urgencyBoost` 与 `contactOverride`。');
w('> 下面每一个块都是**当前生产代码**的真实输出。');
w('');

// ── 1. 四段全表 ──
w('## 一、描述层四段全表');
w('');
w('### 段1 连接需求 → 对她动静的感知（`connection`，4 档）');
w('');
w('| connection | 文案 |');
w('|---|---|');
for (const it of cfg.describe.connection) {
  const label = it.max === undefined ? '≥ 0.50' : `< ${it.max.toFixed(2)}`;
  w(`| ${label} | ${it.text} |`);
}
w('');
w('> 此刻块（reactive）不出这一段：那块建块时 `connection` 恒为 0。');
w('');
w('### 段2 骄傲 → 表达方式（`pride`，6 档）');
w('');
w('| pride | 文案 |');
w('|---|---|');
const PL = ['< 0.00', '[0.00, 0.10)', '[0.10, 0.30)', '[0.30, 0.50)', '[0.50, 0.80)', '≥ 0.80'];
cfg.describe.pride.forEach((it, i) => w(`| ${PL[i]} | ${it.text} |`));
w('');
w('> 作者原版是 5 档，这里在最上头多切了一刀（`≤ 0.00` 单独成档）。');
w('');
w('### 段3 心情（`valence` × `arousal`）');
w('');
w('| 条件 | 文案 |');
w('|---|---|');
w(`| v>0.3, a>0.3 | ${cfg.describe.mood.excited} |`);
w(`| v>0.3, a<-0.3 | ${cfg.describe.mood.content} |`);
w(`| v<-0.3, a>0.3 | ${cfg.describe.mood.agitated} |`);
w(`| v<-0.3, a<-0.3 | ${cfg.describe.mood.depressed} |`);
w(`| v<-0.3（a 中性） | ${cfg.describe.mood.low} |`);
w(`| v>0.3（a 中性） | ${cfg.describe.mood.high} |`);
w('| 其余（\\|v\\|≤0.3） | （不输出） |');
w('');
w('### 段4 沉浸度 → 手上在做什么（`immersion`，3 档）');
w('');
w('| 条件 | 文案 |');
w('|---|---|');
w(`| immersion>0.3 且有 lastActivity | ${cfg.describe.immersion.doing} |`);
w('| 0.1 ≤ immersion ≤ 0.3 | （死带，两句都不出） |');
w(`| immersion<0.1 | ${cfg.describe.immersion.idle} |`);
w('');
w('> 真来源：`lib/activity.js`。冲浪 spawn 成功后登记一次活动（`search` → `immersion=0.4`），');
w('> 产物回投时再刷一次时间戳。之后按 0.01/分钟衰减 → 约 10 分钟落进死带、约 30 分钟回到 idle。');
w('> `lastActivity` 为空时即使 immersion 高也不出（不替模型编活动）。');
w('');

// ── 2. 完整块对照 ──
w('## 二、完整块（生产实渲染）');
w('');
for (const [name, scene, st, reason] of SAMPLES) {
  w(`### ${name}`);
  w('');
  w(`坐标：c=${st.connection.toFixed(2)} p=${st.pride.toFixed(2)} v=${st.valence.toFixed(2)} a=${st.arousal.toFixed(2)} imm=${st.immersion.toFixed(2)}`);
  w('');
  w('```');
  if (scene === 'reactive') w(buildInjectionBlock(st, grid, desc));
  else w(buildProactiveNotice(st, grid, { scene, reason }, cfg.sceneOverride, cfg.proactiveOutlet, desc));
  w('```');
  w('');
}

// ── 3. 撞词自检 ──
w('## 三、撞词自检（描述层 vs 同状态下的 45 格正文）');
w('');
w('规则：两者是同一次注入里相邻的行。只查同状态组合，按 3 字片段求交集，命中即算重复。');
w('');
function tris(s) {
  const t = String(s).replace(/[，。、——！？：（）\s]/g, '');
  const set = new Set();
  for (let i = 0; i + 3 <= t.length; i++) set.add(t.slice(i, i + 3));
  return set;
}
const VMAP = { excited: 0.6, content: 0.6, pleased: 0.6, agitated: -0.6, depressed: -0.6, sullen: -0.6, restless: 0.0, calm: 0.0, neutral: 0.0 };
const AMAP = { excited: 0.6, content: -0.6, pleased: 0.0, agitated: 0.6, depressed: -0.6, sullen: 0.0, restless: 0.6, calm: -0.6, neutral: 0.0 };
const PMAP = { '1': 0.05, '2': 0.2, '3': 0.4, '4': 0.65, '5': 0.9 };
const hits = [];
let pairCount = 0;
for (const cl of Object.keys(VMAP)) {
  for (const t of Object.keys(PMAP)) {
    const state = S(0.40, PMAP[t], VMAP[cl], AMAP[cl]);
    const gridLine = (grid.getPromptContext(state) || '').split('\n')[0];
    const gset = tris(gridLine);
    for (const line of desc(state)) {
      pairCount++;
      const inter = [...tris(line)].filter((x) => gset.has(x));
      if (inter.length) hits.push({ cl, t, line, gridLine, inter });
    }
  }
}
w(`比对 ${pairCount} 对（9 簇 × 5 档 × 描述层行数），命中 **${hits.length}** 处。`);
w('');
if (hits.length) {
  w('| 簇/档 | 描述层行 | 45 格正文 | 重叠片段 |');
  w('|---|---|---|---|');
  for (const h of hits) w(`| ${h.cl}/${h.t} | ${h.line} | ${h.gridLine} | ${h.inter.join(' / ')} |`);
} else {
  w('无重叠。');
}
w('');

fs.writeFileSync(path.join(__dirname, 'ctx_draft.md'), out.join('\n'), 'utf8');
console.log('written: _test/ctx_draft.md  (' + out.length + ' lines)');
console.log('撞词命中: ' + hits.length + ' / ' + pairCount);
