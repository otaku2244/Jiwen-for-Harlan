'use strict';
// 描述层草案渲染 —— 离线对照，不接生产路径。
//
// 目的：把「四段描述层」的候选文案用生产配置（tone-harlan.json）真实渲染出来，
//       并和线上现状块并排对照。
//
// 原则：
//   · 45 格文案一律从 config/tone-harlan.json 动态取，**不手抄**
//   · 现状块一律调生产函数（buildInjectionBlock / buildProactiveNotice）
//   · 草案块由本文件的 CTX 渲染，是唯一手写处

const fs = require('fs');
const path = require('path');

const { createToneGrid } = require('../vendor/tone-grid.js');
const { createToneWrapper } = require('../lib/tone-wrap.js');
const {
  buildInjectionBlock,
  buildProactiveNotice,
  BOUNDARY_LINE,
} = require('../lib/inject-text.js');

const cfg = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'config', 'tone-harlan.json'), 'utf8')
);
const grid = createToneGrid({ profiles: cfg.profiles, urgencyBoost: cfg.urgencyBoost });
const wrapped = createToneWrapper(grid, cfg.contactOverride);

// 45 格正文（cluster × pride 那一格），**不含** urgency 尾注。
// 做法与 tone-wrap.js 一致：取整段，末行若命中 urgency 文案就切掉。
const URGENCY_TEXTS = new Set();
for (const lvl of Object.keys(cfg.urgencyBoost)) {
  for (const m of ['reactive', 'proactive']) {
    const t = cfg.urgencyBoost[lvl] && cfg.urgencyBoost[lvl][m];
    if (typeof t === 'string') URGENCY_TEXTS.add(t);
  }
}
function coreOnly(state) {
  const full = grid.getPromptContext(state);
  const lines = full.split('\n');
  if (lines.length > 1 && URGENCY_TEXTS.has(lines[lines.length - 1].trim())) lines.pop();
  return lines.join('\n');
}

// ══════════════════════════════════════════════════════════════
// 草案：描述层（四段）。口径 = 纯陈述、零祈使，只说「我此刻在什么处境」。
// 45 格负责「那就该怎么说话」，两者不许互相抢活。
// ══════════════════════════════════════════════════════════════
const CTX = {
  // 段1 连接需求 → 对她动静的感知（4 档，自带强度梯度）
  connection: [
    { max: 0.20, text: '刚和她聊完不久，没什么挂念的。' },
    { max: 0.35, text: '有一会儿没听到她的动静了，不着急。' },
    { max: 0.50, text: '她好一阵子没说话了。心思自己飘了过去。' },
    { max: Infinity, text: '她很久没动静了。注意力全在她那一头，别处的动静接不上。' },
  ],
  connectionGuess: '她很久没动静了。有点在意——她去哪了？',

  // 段2 骄傲 → 表达方式（5 档）
  pride: [
    { max: 0.00, text: '难得地不设防。' },
    { max: 0.10, text: '基本没端着，只剩一点习惯性的克制。' },
    { max: 0.30, text: '留了点余地，开口不是不行。' },
    { max: 0.50, text: '端着。不至于不开口，只是不想显得太主动。' },
    { max: 0.80, text: '收着。不会让人看出这边有任何需要。' },
    { max: Infinity, text: '全副武装。一点需要都不会露出来。' },
  ],

  // 段3 心情（V×A 四象限 + 单轴兜底）
  mood: {
    excited: '兴致上来了，人是活的。',
    content: '心里是舒服的，人懒懒的。',
    agitated: '烦躁，静不下来。',
    depressed: '情绪低落，空落落的。',
    low: '心情不太好。',
    high: '心情还不错。',
  },

  // 段4 沉浸度 → 手上在做什么（2 档）
  immersion: {
    doing: (a) => `刚才在${a.type}${a.label ? '（' + a.label + '）' : ''}。`,
    idle: '没在做什么特别的事。',
  },
};

function pick(list, value) {
  for (const item of list) if (value <= item.max) return item.text;
  return list[list.length - 1].text;
}

function moodOf(v, a) {
  if (v > 0.3 && a > 0.3) return CTX.mood.excited;
  if (v > 0.3 && a < -0.3) return CTX.mood.content;
  if (v < -0.3 && a > 0.3) return CTX.mood.agitated;
  if (v < -0.3 && a < -0.3) return CTX.mood.depressed;
  if (v < -0.3) return CTX.mood.low;
  if (v > 0.3) return CTX.mood.high;
  return '';
}

function draftContext(state, opts) {
  const o = opts || {};
  const lines = [];
  if (o.withConnection !== false) lines.push(pick(CTX.connection, state.connection));
  lines.push(pick(CTX.pride, state.pride));
  const mood = moodOf(state.valence, state.arousal);
  if (mood) lines.push(mood);
  if (state.immersion > 0.3 && state.lastActivity) lines.push(CTX.immersion.doing(state.lastActivity));
  else if (state.immersion < 0.1) lines.push(CTX.immersion.idle);
  return lines;
}

/**
 * 草案块（变体②：描述层 + 45 格，退役 urgencyBoost 与 contactOverride）
 * @param {'reactive'|'contact'|'find_activity'} scene
 */
function draftBlock(scene, state, reason) {
  const parts = [];
  const tag = scene === 'reactive' ? '此刻' : scene === 'contact' ? '找她' : '独处';
  parts.push(`【积温·${tag}】`);
  // 此刻块的 connection 恒为 0（resetConnection 在建块之前），段1 恒定 → 不出
  const ctx = draftContext(state, { withConnection: scene !== 'reactive' });
  if (ctx.length) parts.push(ctx.join('\n'));
  if (scene === 'find_activity') {
    const tbl = cfg.sceneOverride.find_activity;
    parts.push(tbl[reason] || tbl.default);
  } else {
    parts.push(coreOnly(state));
  }
  const outlet = cfg.proactiveOutlet && cfg.proactiveOutlet[scene];
  if (outlet) parts.push(outlet);
  parts.push(BOUNDARY_LINE);
  return parts.join('\n');
}

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
  ['找她 · aware 档', 'contact', S(0.25, 0.10, 0.05, 0.05)],
  ['找她 · urgent 档 + 端着', 'contact', S(0.40, 0.55, -0.05, 0.10)],
  ['找她 · desperate 档 + 不设防', 'contact', S(0.62, 0.05, 0.35, -0.40)],
  ['独处 · pride_block', 'find_activity', S(0.42, 0.62, -0.05, 0.05), 'pride_block'],
];

const out = [];
const w = (s) => out.push(s == null ? '' : s);

w('# 描述层草案 · 渲染对照');
w('');
w('> 45 格文案与现状块均由生产配置/生产函数实时渲染，非手抄。');
w('> 草案文案 = 本文件 `CTX` 的候选，是唯一手写处。');
w('');

// ── 1. 四段全表 ──
w('## 一、四段候选文案全表');
w('');
w('### 段1 连接需求 → 对她动静的感知（4 档）');
w('');
w('| connection | 文案 |');
w('|---|---|');
for (const it of CTX.connection) {
  const label = it.max === Infinity ? '≥ 0.50' : `< ${it.max.toFixed(2)}`;
  w(`| ${label} | ${it.text} |`);
}
w('');
w(`> 备选第四档（带「她去哪了」的猜测，作者默认句写法）：${CTX.connectionGuess}`);
w('> 你此前说过这个猜测建议不加，默认按上表走。');
w('');
w('### 段2 骄傲 → 表达方式（5 档）');
w('');
w('| pride | 文案 |');
w('|---|---|');
const PRIDE_LABEL = [
  '≤ 0.00',
  '0.00 < p ≤ 0.10',
  '0.10 < p ≤ 0.30',
  '0.30 < p ≤ 0.50',
  '0.50 < p ≤ 0.80',
  'p > 0.80',
];
for (let i = 0; i < CTX.pride.length; i++) {
  w(`| ${PRIDE_LABEL[i]} | ${CTX.pride[i].text} |`);
}
w('');
w('### 段3 心情（V×A 四象限 + 单轴兜底）');
w('');
w('| 条件 | 文案 |');
w('|---|---|');
w(`| v>0.3, a>0.3 | ${CTX.mood.excited} |`);
w(`| v>0.3, a<-0.3 | ${CTX.mood.content} |`);
w(`| v<-0.3, a>0.3 | ${CTX.mood.agitated} |`);
w(`| v<-0.3, a<-0.3 | ${CTX.mood.depressed} |`);
w(`| v<-0.3（a 中性） | ${CTX.mood.low} |`);
w(`| v>0.3（a 中性） | ${CTX.mood.high} |`);
w(`| 其余（\\|v\\|≤0.3） | （不输出） |`);
w('');
w('### 段4 沉浸度 → 手上在做什么（2 档）');
w('');
w('| 条件 | 文案 |');
w('|---|---|');
w(`| immersion>0.3 且有 lastActivity | ${CTX.immersion.doing({ type: 'reading', label: '某本书' })} |`);
w(`| immersion<0.1 | ${CTX.immersion.idle} |`);
w('');
w('> ⚠️ 桥目前从不调 `setActivity`，`immersion` 恒为 0、`lastActivity` 恒为 null →');
w('> 段4 现在**永远只输出最后那一句**，是恒定噪声。');
w('> 建议：要么先把 surf 产物接进 `setActivity`，要么这一版先不启用段4。');
w('');

// ── 2. 完整块对照 ──
w('## 二、完整块对照（现状 vs 草案）');
w('');
for (const [name, scene, st, reason] of SAMPLES) {
  w(`### ${name}`);
  w('');
  w(`坐标：c=${st.connection.toFixed(2)} p=${st.pride.toFixed(2)} v=${st.valence.toFixed(2)} a=${st.arousal.toFixed(2)} imm=${st.immersion.toFixed(2)}`);
  w('');
  w('**现状**');
  w('```');
  if (scene === 'reactive') w(buildInjectionBlock(st, wrapped));
  else w(buildProactiveNotice(st, wrapped, { scene, reason }, cfg.sceneOverride, cfg.proactiveOutlet));
  w('```');
  w('');
  w('**草案**');
  w('```');
  w(draftBlock(scene, st, reason));
  w('```');
  w('');
}

// ── 3. 撞词自检 ──
w('## 三、撞词自检（描述层 vs 同状态下的 45 格正文）');
w('');
w('规则：两者是同一次注入里相邻的行。只查同状态组合。按 3 字片段求交集，命中即算重复。');
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
    const st = S(0.40, PMAP[t], VMAP[cl], AMAP[cl]);
    const gridLine = coreOnly(st).split('\n')[0];
    const gset = tris(gridLine);
    for (const line of draftContext(st)) {
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

// ── 4. 段1 可达性 ──
w('## 四、段1 在两条链路上的实际取值');
w('');
w('| 链路 | connection | 段1 输出 |');
w('|---|---|---|');
w('| 此刻块（reactive） | **恒为 0** | 恒定「刚和她聊完不久…」→ 本就不输出 |');
w('| 找她（proactive） | 越线时 ∈ [0.35, 1] | 只可能取到第 3、4 档 |');
w('');
w('> `bridge.js` 顺序是 `resetConnection()` → 建块，所以此刻块里 connection 永远是 0。');
w('');

// ── 5. 变体对照 ──
w('## 五、两个变体');
w('');
w('| 变体 | 块结构 | 改动面 |');
w('|---|---|---|');
w('| ① 最小改动 | 描述层 + 45 格 + urgencyBoost 尾注 + contactOverride | 只加描述层，其余照旧 |');
w('| ② 推荐 | 描述层 + 45 格（退役 urgencyBoost + contactOverride） | 描述层接管 connection 侧，删两处重复源 |');
w('');
w('② 之所以成立：段1 已经把「她多久没动静 + 这边什么反应」说全了，');
w('而 `urgencyBoost.proactive` 与 `contactOverride.proactive` 说的是同一件事 ——');
w('三个来源叠在一段里，就是现在「找她」块里那三句同义反复的成因。');
w('');
w('另有一条现状事实：**`urgencyBoost` 的 reactive 三档在线上永远不触发**。');
w('此刻块建块时 c≡0 → `none` → 三档全是 `null`。所以真正要处理的只有 proactive 侧。');
w('');

fs.writeFileSync(path.join(__dirname, 'ctx_draft.md'), out.join('\n'), 'utf8');
console.log('written: _test/ctx_draft.md  (' + out.length + ' lines)');
console.log('撞词命中: ' + hits.length + ' / ' + pairCount);
