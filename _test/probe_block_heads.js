'use strict';
// 块头统一 + 主动唤醒三条路径文案对照
//
// 背景（用户 2026-10-07 要求）：
//   ① 块头不再按场景区分，三个场景统一用【积温·此刻】。
//   ② 复核 find_activity 走冲浪（surf）时呈现的文案，与不走冲浪时应有什么不同。
//
// 本脚本用**生产配置 + 生产函数**渲染，不手抄任何文案。
// 输出：_test/block_heads_probe.txt

const fs = require('fs');
const path = require('path');
const {
  buildInjectionBlock, buildProactiveNotice, stripJiwenBlocks,
  assertBlockShape, SCENE_TAG, SURF_TAIL_LINE, BOUNDARY_LINE,
} = require('../lib/inject-text.js');
const { createToneGrid } = require('../vendor/tone-grid.js');
const { createDescriber } = require('../lib/describe.js');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'tone-harlan.json'), 'utf8'));
const tg = createToneGrid({ profiles: cfg.profiles, urgencyBoost: cfg.urgencyBoost });
const desc = createDescriber(cfg.describe);

// 描述层是 buildXxx 新增的末位参数 —— 包一层，免得每个调用点手写。
const bN = (st, g, opts, so, po) => buildProactiveNotice(st, g, opts, so, po, desc);
const bI = (st, g) => buildInjectionBlock(st, g, desc);

const out = [];
const w = (s) => out.push(s === undefined ? '' : s);

const S = (o) => Object.assign({ connection: 0, pride: 0, valence: 0, arousal: 0, immersion: 0 }, o);

// 昨天（10-06 15:17:06Z）线上真实回投的产物 —— 从 bridge.log 逐字抄来，
// 用来保证对照里产物正文与线上一致。
const REAL_FINDING = {
  title: 'The evil eye is irrational. Abandon it at your peril',
  url: 'https://psyche.co/ideas/the-evil-eye-is-irrational-abandon-it-at-your-peril',
  image: 'https://images.aeonmedia.io/images/ac69c0e8-c944-48d2-8854-de08b9cc3f8c/sz-gettyimages-2277777330.jpg?top=143&left=0&cropWidth=2736&cropHeight=1539&width=1200&quality=75&format=auto',
  note: '邪眼信仰在理性时代依然存续，作者认为这不只是残余迷信。它处理的是人际间无法证实的恶意与嫉妒——一种理性框架难以覆盖的社会风险。放弃它意味着失去一套应对模糊敌意的民间机制，代价可能高于表面上的认知洁净。',
};

// ── 用例表 ─────────────────────────────────────────────
const CASES = [
  ['此刻块（reactive，每次聊天）', () => bI(S({ pride: 0.2, valence: 0.35 }), tg)],
  ['找她 · c=0.30（未过线）', () => bN(S({ connection: 0.30, pride: 0.1 }), tg, { scene: 'contact' }, cfg.sceneOverride, cfg.proactiveOutlet)],
  ['找她 · c=0.42 p=0.15（过线，pride 不高）', () => bN(S({ connection: 0.42, pride: 0.15 }), tg, { scene: 'contact' }, cfg.sceneOverride, cfg.proactiveOutlet)],
  ['找她 · c=0.62（强制线以上）', () => bN(S({ connection: 0.62, pride: 0.15 }), tg, { scene: 'contact' }, cfg.sceneOverride, cfg.proactiveOutlet)],
  ['独处 · pride_block（无产物）', () => bN(S({ connection: 0.40, pride: 0.60 }), tg, { scene: 'find_activity', reason: 'pride_block' }, cfg.sceneOverride, cfg.proactiveOutlet)],
  ['独处 · low_valence（无产物）', () => bN(S({ valence: -0.55, arousal: 0.1 }), tg, { scene: 'find_activity', reason: 'low_valence' }, cfg.sceneOverride, cfg.proactiveOutlet)],
  ['独处 · high_arousal（无产物）', () => bN(S({ arousal: 0.65 }), tg, { scene: 'find_activity', reason: 'high_arousal' }, cfg.sceneOverride, cfg.proactiveOutlet)],
  ['独处 · surf 有产物（昨天线上那条）', () => bN(S({ connection: 0.23 }), tg, { scene: 'find_activity', reason: 'surf', finding: REAL_FINDING }, cfg.sceneOverride, cfg.proactiveOutlet)],
  ['独处 · surf 失败兜底', () => bN(S({ connection: 0.23 }), tg, { scene: 'find_activity', reason: 'surf', failure: '刚才想去翻点东西，没翻成（超时）。' }, cfg.sceneOverride, cfg.proactiveOutlet)],
];

// 模拟手机侧搬运脚本的压平（jiwen_pull.js: notice.replace(/\r?\n+/g,' ')）
const flatten = (s) => String(s).replace(/\r?\n+/g, ' ').trim();

function renderAll() {
  return CASES.map(([label, fn]) => {
    const block = fn();
    const first = block.split('\n')[0];
    const problems = assertBlockShape(block);
    return { label, block, first, problems };
  });
}

// ════════════════════════════════════════════════════
w('# 块头统一 + 主动唤醒三条路径复核');
w('');
w('> 全部由 `_test/probe_block_heads.js` 用生产配置（`config/tone-harlan.json`）');
w('> 与生产函数（`lib/inject-text.js` / `lib/describe.js`）实时渲染，文案零手抄。');
w('');

// 统一前的块头（历史值，仅用于对照；生产代码已统一为「此刻」）
const LEGACY_TAGS = { reactive: '此刻', contact: '找她', find_activity: '独处' };

// ── 一、统一后（现行） ──
function renderUnder(tags) {
  const keep = Object.assign({}, SCENE_TAG);
  Object.assign(SCENE_TAG, tags);
  const r = renderAll();
  Object.assign(SCENE_TAG, keep);
  return r;
}

const unified = renderUnder(SCENE_TAG);       // 现行 = 统一后
const asIs = renderUnder(LEGACY_TAGS);        // 对照 = 统一前

w('## 一、统一前（历史形态，块头按场景分）');
w('');
for (const r of asIs) {
  w('### ' + r.label);
  w('块头：`' + r.first + '`' + (r.problems.length ? '  ⚠️ ' + r.problems.join('; ') : ''));
  w('```');
  w(r.block);
  w('```');
  w('');
}

// ── 二、统一块头 ──
w('## 二、块头统一为【积温·此刻】之后（现行；只改首行，其余逐字不变）');
w('');
w('| 用例 | 原块头 | 统一后 | 首行以外是否变化 |');
w('|---|---|---|---|');
for (let i = 0; i < unified.length; i++) {
  const a = asIs[i];
  const b = unified[i];
  const same = a.block.split('\n').slice(1).join('\n') === b.block.split('\n').slice(1).join('\n');
  w(`| ${b.label} | \`${a.first}\` | \`${b.first}\` | ${same ? '否' : '**是**'} |`);
}
w('');
w('形状自检（`assertBlockShape`）+ 剥离自检（`stripJiwenBlocks`）：');
w('');
w('| 用例 | 形状 | 剥离后残留 |');
w('|---|---|---|');
for (const b of unified) {
  const her = b.block + '\n她说了一句题外话。';
  const stripped = stripJiwenBlocks(her);
  w(`| ${b.label} | ${b.problems.length ? '❌ ' + b.problems.join('; ') : '✅ 合规'} | ${stripped === '她说了一句题外话。' ? '✅ 干净' : '❌ ' + JSON.stringify(stripped.slice(0, 60))} |`);
}
w('');

// ── 三、三条路径文案差异 ──
w('## 三、find_activity 的三条路径，文案长什么样');
w('');
const noFinding = bN(S({ connection: 0.40, pride: 0.60 }), tg, { scene: 'find_activity', reason: 'pride_block' }, cfg.sceneOverride, cfg.proactiveOutlet);
const withFinding = bN(S({ connection: 0.23 }), tg, { scene: 'find_activity', reason: 'surf', finding: REAL_FINDING }, cfg.sceneOverride, cfg.proactiveOutlet);
const failed = bN(S({ connection: 0.23 }), tg, { scene: 'find_activity', reason: 'surf', failure: '刚才想去翻点东西，没翻成（超时）。' }, cfg.sceneOverride, cfg.proactiveOutlet);
const contactBlk = bN(S({ connection: 0.42, pride: 0.15 }), tg, { scene: 'contact' }, cfg.sceneOverride, cfg.proactiveOutlet);

const table = [
  ['找她（contact）', contactBlk],
  ['独处 · 无产物', noFinding],
  ['独处 · 有产物', withFinding],
  ['独处 · 失败兜底', failed],
];
w('| 路径 | 描述层 | 正文来源 | 尾标记 |');
w('|---|---|---|---|');
w('| 找她 | 有 | `getPromptContext` = 45 格 + `proactiveOutlet.contact` | 边界句 |');
w('| 独处 · 无产物 | 有 | `sceneOverride.find_activity[reason]` + `proactiveOutlet.find_activity` | 边界句 |');
w('| 独处 · 有产物 | 有 | `buildFindingBody(finding)` —— 小标题+标题+网址+原图+摘要，**多行** | **冲浪尾句** |');
w('| 独处 · 失败 | 有 | `failure` 一句兜底 | **冲浪尾句** |');
w('');
w('逐条渲染：');
w('');
for (const [label, blk] of table) {
  w('### ' + label);
  w('```');
  w(blk);
  w('```');
  w('');
}

// ── 四、压平后注入给模型的形态 ──
w('## 四、手机侧搬运脚本压平后的形态（`jiwen_pull.js` 把换行换成空格）');
w('');
for (const [label, blk] of table) {
  w('### ' + label);
  w('```');
  w(flatten(blk));
  w('```');
  w('');
}

// ── 五、判定器读路径的剥离（回流时） ──
w('## 五、回流时判定器/归档看到的（`stripJiwenBlocks` 剥掉整块）');
w('');
for (const [label, blk] of table) {
  const mixed = blk + '\n她：在吗';
  w(`- ${label} → ${JSON.stringify(stripJiwenBlocks(mixed))}`);
}
w('');

fs.writeFileSync(path.join(__dirname, 'block_heads_probe.txt'), out.join('\n'), 'utf8');
console.log('written: _test/block_heads_probe.txt');
