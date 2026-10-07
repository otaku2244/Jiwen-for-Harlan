'use strict';
// 9 条「中文状态句」候选 —— 同簇撞词自检
// 用法：node _test/check_cluster_draft.js   → 写 _test/cluster_draft_check.txt
//
// 为什么只查"同簇"：状态句与 45 格正文是同一次注入里**相邻的两行**，
// 只有该簇自己那 5 档正文会挨着它。跨簇永远不会同时出现，不用管。
//
// 检查方式：把候选句与该簇 5 档正文都去标点后取 3-gram，求交集。
// 有交集 = 同一段里出现重复措辞，要改。

const fs = require('fs');
const path = require('path');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/tone-harlan.json'), 'utf8'));

const DRAFT = {
  excited: '兴致往上走，人也是活的。',
  content: '心里是满的，没什么要赶的。',
  pleased: '心里松快，人也跟着软下来。',
  agitated: '心里不太平，有股劲顶着。',
  depressed: '情绪往下走，什么都不太想动。',
  sullen: '有点闷，不太想开口。',
  restless: '静不下来，注意力没处放。',
  calm: '心里是平的，没什么急的。',
  neutral: '没什么起伏，照旧。',
};

const CN = {
  excited: '兴奋/活跃', content: '满足/慵懒', pleased: '愉悦/舒展',
  agitated: '烦躁/带刺', depressed: '低落/空荡', sullen: '闷/不悦',
  restless: '躁动/静不下来', calm: '平静/松弛', neutral: '中性',
};

const deCluster = (t) => String(t).replace(/^[a-zA-Z]+\s*，\s*/, '');
const grams = (s, n = 3) => {
  const c = String(s).replace(/[，。、—…\s]/g, '');
  const g = new Set();
  for (let i = 0; i + n <= c.length; i++) g.add(c.slice(i, i + n));
  return g;
};

const out = [];
const w = (s = '') => out.push(s);
const hr = (c = '=') => w(c.repeat(72));

hr();
w('9 条「中文状态句」候选 · 同簇撞词自检');
w('生成：node _test/check_cluster_draft.js');
hr();
w();
w('插入位置：45 格正文**之前**，独立一行。此刻块与主动唤醒都插。');
w('分工：状态句只说「我在什么情绪里」；45 格只说「那我该怎么说话」。');
w('按簇共用 —— 同一簇的 5 个 pride 档共享同一条状态句（pride 的分寸由 45 格承担）。');
w();

// ── 一、候选全表 ─────────────────────────────────────────────
hr('-');
w('一、候选（9 条）');
hr('-');
w();
w('| 簇 | 情绪含义 | 候选状态句 | 字数 |');
w('|---|---|---|---|');
for (const cl of Object.keys(cfg.profiles)) {
  w(`| ${cl} | ${CN[cl] || ''} | ${DRAFT[cl]} | ${DRAFT[cl].replace(/[，。]/g, '').length} |`);
}
w();

// ── 二、同簇撞词检查 ─────────────────────────────────────────
hr('-');
w('二、同簇撞词检查（与 5 档正文的 3 字重叠）');
hr('-');
w();
w('| 簇 | 候选状态句 | 重叠片段 | 结论 |');
w('|---|---|---|---|');
let bad = 0;
const detail = [];
for (const cl of Object.keys(cfg.profiles)) {
  const dg = grams(DRAFT[cl]);
  const hits = new Set();
  for (const tier of Object.keys(cfg.profiles[cl]).sort()) {
    const body = deCluster((cfg.profiles[cl][tier] || [])[0] || '');
    const bg = grams(body);
    for (const g of dg) if (bg.has(g)) hits.add(`${g}（档${tier}）`);
  }
  if (hits.size) bad++;
  w(`| ${cl} | ${DRAFT[cl]} | ${hits.size ? [...hits].join('、') : '—'} | ${hits.size ? '⚠️ 要改' : '✅'} |`);
  if (hits.size) detail.push([cl, DRAFT[cl], [...hits]]);
}
w();
w(`**${bad} / 9 条有同簇重叠。**`);
w();

if (detail.length) {
  w('### 重叠明细');
  w();
  for (const [cl, d, hits] of detail) {
    w(`**${cl}** — 「${d}」`);
    w();
    for (const h of hits) w(`- ${h}`);
    w();
  }
}

// ── 三、插进去之后长什么样 ───────────────────────────────────
hr('-');
w('三、插进去之后的此刻块（3 例）');
hr('-');
w();
const BLOCK_TAIL = '【此状态为潜意识的底色沉淀，自然浸润在回应里，不作任何元说明或刻意提及。】';
const samples = [
  ['depressed / p=0.65', 'depressed', 4],
  ['pleased / p=0.05', 'pleased', 1],
  ['neutral / p=0.20', 'neutral', 2],
];
for (const [name, cl, tier] of samples) {
  const body = deCluster((cfg.profiles[cl][tier] || [])[0] || '');
  w(`【${name}】`);
  w('【积温·此刻】');
  w(DRAFT[cl]);
  w(body);
  w(BLOCK_TAIL);
  w();
}

fs.writeFileSync(path.join(__dirname, 'cluster_draft_check.txt'), out.join('\n') + '\n', 'utf8');
console.log('written: _test/cluster_draft_check.txt  (' + out.length + ' lines)');
console.log('同簇重叠条数：' + bad + ' / 9');
