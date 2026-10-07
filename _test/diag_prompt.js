'use strict';
// diag_prompt.js —— 当前提示词实现相对原作者设计的偏离清单（穷举 + 可复跑）
//
// 用法（jiwen-bridge 目录下）: node _test/diag_prompt.js
//
// 三个对照对象：
//   作者默认  vendor/jiwen.js:743-905   defaultPromptContext() / defaultStyleGuidance()
//   作者 demo docs/index.html:236-267   ctx() / sty()
//   我们      config/tone-harlan.json + lib/tone-wrap.js + lib/inject-text.js
//
// 只报事实（计数 + 样例），不下结论。结论在 README/对话里。

const fs = require('fs');
const path = require('path');
const { createToneGrid } = require('../vendor/tone-grid.js');
const { createToneWrapper } = require('../lib/tone-wrap.js');
const { meaningfulLines, buildInjectionBlock, buildProactiveNotice } = require('../lib/inject-text.js');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/tone-harlan.json'), 'utf8'));
const grid = createToneGrid({ profiles: cfg.profiles, urgencyBoost: cfg.urgencyBoost });
const wrapped = createToneWrapper(grid, cfg.contactOverride);

const CLUSTERS = ['excited', 'content', 'pleased', 'agitated', 'depressed', 'sullen', 'restless', 'calm', 'neutral'];
const VS = [-1, -0.5, -0.2, 0, 0.2, 0.5, 1];
const AS = [-1, -0.5, -0.2, 0, 0.2, 0.5, 1];
const PS = [-1, -0.5, 0, 0.2, 0.4, 0.6, 0.9];
const CS = [0, 0.1, 0.25, 0.36, 0.5, 0.7];

const st = (v, a, p, c) => ({ valence: v, arousal: a, pride: p, connection: c, immersion: 0, lastActivity: null });

function hr(t) { console.log('\n' + '─'.repeat(66) + '\n' + t); }

// ════════════════════════════════════════════════════════════════
hr('[1] 正文是否以英文簇名开头（模型的说话风格指引）');
// ════════════════════════════════════════════════════════════════
{
  let total = 0, leaked = 0;
  const samples = [];
  for (const c of CLUSTERS) {
    for (const tier of [1, 2, 3, 4, 5]) {
      const line = (cfg.profiles[c] || {})[tier];
      if (!line) continue;
      for (const s of line) {
        total++;
        const hit = CLUSTERS.find((x) => s.startsWith(x));
        if (hit) { leaked++; if (samples.length < 4) samples.push(`    ${s.slice(0, 52)}…`); }
      }
    }
  }
  console.log(`  格内文案 ${total} 条，以英文簇名开头 ${leaked} 条（${(leaked / total * 100).toFixed(0)}%）`);
  console.log('  样例：');
  samples.forEach((s) => console.log(s));
  console.log(`  → 只要 c < 0.35（无开口动机），正文原样发出，簇名必现于模型可见文本。`);
}

// ════════════════════════════════════════════════════════════════
hr('[2] 开口动机成立时，45 格被顶掉的范围与残余信息量');
// ════════════════════════════════════════════════════════════════
{
  let n = 0, overridden = 0, kept = 0;
  const bodies = new Map();
  for (const v of VS) for (const a of AS) for (const p of PS) for (const c of CS) {
    n++;
    const state = st(v, a, p, c);
    const rawBody = grid.getStyleGuidance(state);
    const wrappedBody = wrapped.getStyleGuidance(state);
    if (rawBody === wrappedBody) { kept++; continue; }
    overridden++;
    bodies.set(wrappedBody, (bodies.get(wrappedBody) || 0) + 1);
  }
  console.log(`  穷举 ${n} 组（V×A×pride×c）：45 格保留 ${kept} 组，被顶掉 ${overridden} 组（${(overridden / n * 100).toFixed(0)}%）`);
  console.log(`  被顶掉后，模型能看到的**不同正文**只有 ${bodies.size} 种：`);
  for (const [text, cnt] of [...bodies.entries()].sort((x, y) => y[1] - x[1])) {
    console.log(`    [${String(cnt).padStart(4)} 组] ${text.replace(/\n/g, ' / ').slice(0, 74)}…`);
  }
  console.log('  → 顶掉后正文与 V / A / pride 完全无关：同一句覆盖全部情绪簇与全部 pride 档。');
}

// ════════════════════════════════════════════════════════════════
hr('[3] contactOverride 与 urgency 尾注的语义重叠');
// ════════════════════════════════════════════════════════════════
{
  const co = cfg.contactOverride;
  const ub = cfg.urgencyBoost;
  const pairs = [
    ['c≥0.50（forced / desperate）', co.proactive.forced, ub.desperate.proactive],
    ['0.35≤c<0.50 且 p<0.50（normal / urgent）', co.proactive.normal, ub.urgent.proactive],
  ];
  for (const [label, a, b] of pairs) {
    console.log(`  ${label}`);
    console.log(`    contactOverride : ${a}`);
    console.log(`    urgency 尾注    : ${b}`);
    console.log('');
  }
  console.log('  实测两者会**同时出现**在同一块里（同一状态触发同一档位），见 [5] 的实际拼接。');
}

// ════════════════════════════════════════════════════════════════
hr('[4] 档位行：重字 / 与正文同义重复 / 死档位');
// ════════════════════════════════════════════════════════════════
{
  const LABELS = { 心情: ['舒展', '中性', '沉'], 姿态: ['完全收着', '收着', '留着一点余地', '略收', '平常', '松了', '完全不设防'], 心跳: ['起波', '慵懒', '平静'], 想念: ['悠闲', '留意', '想念', '挡不住'] };
  console.log('  字段名与档位词同名：');
  for (const [field, words] of Object.entries(LABELS)) {
    const dup = words.filter((w) => w === field);
    if (dup.length) console.log(`    「${field}」→ 档位词里也有「${dup.join('、')}」 → 渲染成 \`${field}：${dup[0]}。\``);
  }

  // 死档位：穷举可达性
  const reach = new Set();
  for (const c of CS) for (const p of PS) for (const v of VS) for (const a of AS) {
    for (const line of meaningfulLines(st(v, a, p, c))) {
      const m = line.match(/^想念：(.+)。$/);
      if (m) reach.add(m[1]);
    }
  }
  console.log(`  可实际输出的「想念」档位词：${[...reach].join('、')}（labelConnection 共 4 档）`);
  console.log(`  CS 集合含 0 与 0.1，两者都 < 0.20 → 说明 ${reach.has('悠闲') ? '悠闲可达' : '「悠闲」永不可达（inject-text.js:131-132 两支条件不同、动作相同）'}`);

  // 与簇名同义
  console.log('  与正文簇名的同义重复（簇名本身就是 V×A 的合成）：');
  console.log('    `心情：舒展。` ≈ 簇 pleased / excited / content（v>0.3 三种）');
  console.log('    `姿态：X。`    ≈ 45 格的 pride 档（同一根轴，同一阈值）');
  console.log('    `心跳：X。`    ≈ 簇内 arousal 分量（restless / calm 就是它单独成簇）');
  console.log('    `想念：X。`    ≈ urgency 尾注（同一根 connection 轴，同一组阈值 0.20/0.35/0.50）');
}

// ════════════════════════════════════════════════════════════════
hr('[5] 实际渲染：此刻块（默认路径 / 越线）与唤醒块');
// ════════════════════════════════════════════════════════════════
{
  const cases = [
    ['此刻块 · c=0.10（默认路径）', st(0.45, 0, 0.2, 0.1)],
    ['此刻块 · c=0.40 越线（45 格被顶掉）', st(0.45, 0, 0.2, 0.4)],
    ['此刻块 · c=0.40 越线 + pride 挡住', st(0.45, 0, 0.6, 0.4)],
  ];
  for (const [name, state] of cases) {
    console.log(`  【${name}】`);
    buildInjectionBlock(state, wrapped).split('\n').forEach((l) => console.log('    ' + l));
    console.log('');
  }
  console.log('  【唤醒块 · contact】');
  buildProactiveNotice(st(0.30, 0, 0.2, 0.4), wrapped, { scene: 'contact' }, cfg.sceneOverride, cfg.proactiveOutlet)
    .split('\n').forEach((l) => console.log('    ' + l));
}

// ════════════════════════════════════════════════════════════════
hr('[6] 作者有、我们丢的四层（逐层核对正文里是否存在）');
// ════════════════════════════════════════════════════════════════
{
  const probe = (text, pats) => pats.some((p) => p.test(text));
  let hasPosition = 0, hasQuadrant = 0, hasActivity = 0, hasCrossRef = 0;
  const N = VS.length * AS.length * PS.length * CS.length;
  for (const v of VS) for (const a of AS) for (const p of PS) for (const c of CS) {
    const body = wrapped.getStyleGuidance(st(v, a, p, c));
    if (probe(body, [/没动静/, /没说话/, /没听到/, /安静得/])) hasPosition++;
    if (probe(body, [/精力充沛/, /懒洋洋/, /坐不住/, /空落落/])) hasQuadrant++;
    if (probe(body, [/刚才在/, /没在做什么/])) hasActivity++;
    if (probe(body, [/别扭/, /拉不下脸/, /赌气/, /说漏嘴/])) hasCrossRef++;
  }
  const pct = (x) => `${x}/${N}（${(x / N * 100).toFixed(0)}%）`;
  console.log(`  ① connection 处境句（"她好久没动静了"）      出现于 ${pct(hasPosition)}`);
  console.log(`  ② V×A 四象限合成句（作者 defaultPromptContext） 出现于 ${pct(hasQuadrant)}`);
  console.log(`  ③ immersion 活动句（"刚才在reading"）          出现于 ${pct(hasActivity)}`);
  console.log(`  ④ 交叉条件（c×p / c×v×a / p×v）                 出现于 ${pct(hasCrossRef)}`);
  console.log('  作者默认实现里四层全部存在（vendor/jiwen.js:743-905）。');
  console.log('  注：②④ 属"与 45 格重叠"，①③ 属"45 格覆盖不到"。');
}

console.log('\n' + '═'.repeat(66));
console.log('说明：本脚本只测量，不判断。哪些该补、哪些该删，取决于设计取舍。');
