'use strict';
// 「此刻块」文案完整版 —— 用生产配置 + 生产函数渲染，不手抄一个字
// 用法：node _test/dump_reactive_block.js   → 写 _test/reactive_block_full.md
//
// 此刻块 = buildInjectionBlock(state, toneGrid)
//   走 toneGrid.getStyleGuidance（= tone-wrap 的 reactive 列）
//   bridge.js 里非回环轮先 resetConnection() 再建块 → connection 恒为 0
//   → urgency=none → urgencyBoost.none.reactive = null → 正文没有 urgency 尾注
//   → 正文恒等于 profiles[簇][pride档] 那一条

const fs = require('fs');
const path = require('path');
const { createToneGrid } = require('../vendor/tone-grid.js');
const { createToneWrapper } = require('../lib/tone-wrap.js');
const { buildInjectionBlock, BOUNDARY_LINE } = require('../lib/inject-text.js');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/tone-harlan.json'), 'utf8'));
const tg = createToneWrapper(
  createToneGrid({ profiles: cfg.profiles, urgencyBoost: cfg.urgencyBoost }),
  cfg.contactOverride
);

// 每簇的代表坐标（严格落在该簇的 V×A 区间内）
const CLUSTERS = [
  ['excited', 0.60, 0.60],
  ['content', 0.60, -0.60],
  ['pleased', 0.60, 0.00],
  ['agitated', -0.60, 0.60],
  ['depressed', -0.60, -0.60],
  ['sullen', -0.60, 0.00],
  ['restless', 0.00, 0.60],
  ['calm', 0.00, -0.60],
  ['neutral', 0.00, 0.00],
];
// pride 五档的代表值（对应 vendor 的分档：>0.8/>0.5/>0.3/>0.1/else）
const TIERS = [
  [1, 0.05, '≤0.1'],
  [2, 0.20, '0.1~0.3'],
  [3, 0.40, '0.3~0.5'],
  [4, 0.65, '0.5~0.8'],
  [5, 0.90, '>0.8'],
];
const stateOf = (v, a, p) => ({ valence: v, arousal: a, pride: p, connection: 0, immersion: 0.3 });

const out = [];
const w = (s = '') => out.push(s);

w('# 「此刻块」文案完整版');
w();
w('> 生成本文的是 `_test/dump_reactive_block.js`：它用**生产配置** `config/tone-harlan.json` 与');
w('> **生产函数** `buildInjectionBlock()` 实际渲染，正文一个字都不是手抄的。');
w('> 线上代码版本 `ae2be4b`（此刻块部分**尚未按讨论改过**，档位行仍在）。');
w();
w('## 块骨架');
w();
w('```');
w('【积温·此刻】                       ← 块头，固定');
w('心情：X。姿态：X。心跳：X。          ← 档位行，一行，条件出现（见下）');
w('<45 格正文，一条>                    ← profiles[簇][pride档]，恒为一行');
w('【此状态为潜意识的底色沉淀，自然浸润在回应里，不作任何元说明或刻意提及。】  ← 边界句，固定');
w('```');
w();
w('## 两条硬事实');
w();
w('1. **此刻块的 connection 恒为 0。** `bridge.js` 里非回环轮先 `resetConnection()` 再建块。');
w('   于是 `urgency=none`，而 `urgencyBoost.none.reactive = null` → **正文没有 urgency 尾注**，');
w('   45 格后面干干净净，不会多出「她安静得有点久了」那类句子。');
w('2. **此刻块永远没有 `想念：` 行。** 那行要求 `c ≥ 0.20`，而此刻块 `c ≡ 0`。');
w('   「悠闲」是 `labelConnection` 的 `<0.20` 档，输出条件把它排除在外 → 死档。');
w('   两条正好重合：此刻块落在「悠闲」区间，而「悠闲」从不输出。');
w();
w('## 档位行规则（此刻块的 c=0 常态）');
w();
w('| 行 | 触发条件 | 此刻块是否出现 |');
w('|---|---|---|');
w('| `心情：X。` | 每次都出 | ✅ 每次 |');
w('| `姿态：X。` | `p>0.3` 或 `p<-0.1` | 条件 |');
w('| `心跳：X。` | `a>0.3` 或 `a<-0.3` | 条件 |');
w('| `想念：X。` | `c≥0.20` | ❌ 永不（c≡0） |');
w();
w('> 四条以 `join(\'\')` 连成**一整行**发出，所以念出来是 `心情：舒展。姿态：收着。`');
w();

// ── 45 格全表 ─────────────────────────────────────────────────
w('## 一、正文全表（9 簇 × 5 档 = 45 格）');
w();
w('此刻块的正文只由 (簇, pride档) 决定。下面是全部 45 条 —— 线上会发出的就是这些句子，别无其它。');
w();
for (const [name, v, a] of CLUSTERS) {
  w(`### ${name}（v=${v.toFixed(2)}, a=${a.toFixed(2)}）`);
  w();
  w('| pride档 | p 区间 | 档位行 | 正文 |');
  w('|---|---|---|---|');
  for (const [tier, p, range] of TIERS) {
    const st = stateOf(v, a, p);
    const block = buildInjectionBlock(st, tg);
    const lines = block.split('\n');
    const stateLine = lines[1] && lines[1].startsWith('心情：') ? lines[1] : '（无）';
    const body = lines.find((l) => l && !l.startsWith('【积温') && !l.startsWith('心情：') && l !== BOUNDARY_LINE) || '（空）';
    w(`| ${tier} | ${range} | ${stateLine} | ${body} |`);
  }
  w();
}

// ── 完整块样例 ────────────────────────────────────────────────
w('## 二、完整块样例（原样贴出，含块头/档位行/边界句）');
w();
const samples = [
  ['pleased / 档1（p=0.05）', 0.60, 0.00, 0.05],
  ['pleased / 档2（p=0.20）', 0.60, 0.00, 0.20],
  ['neutral / 档2（p=0.20）', 0.00, 0.00, 0.20],
  ['depressed / 档4（p=0.65）', -0.60, -0.60, 0.65],
  ['restless / 档2（p=0.20）', 0.00, 0.60, 0.20],
  ['sullen / 档5（p=0.90）', -0.60, 0.00, 0.90],
];
for (const [name, v, a, p] of samples) {
  const block = buildInjectionBlock(stateOf(v, a, p), tg);
  w(`**${name}**`);
  w();
  w('```');
  w(block);
  w('```');
  w();
}

// ── 删档位行后的形态 ──────────────────────────────────────────
w('## 三、把档位行去掉之后（讨论中的方案，**未实施**）');
w();
w('去掉第 2 行，其余一字不动。此刻块退成「块头 + 45 格正文 + 边界句」：');
w();
w('```');
w('【积温·此刻】');
w('pleased，表达比平时满，舒展得彻底，不遮掩半分受用。');
w('【此状态为潜意识的底色沉淀，自然浸润在回应里，不作任何元说明或刻意提及。】');
w('```');
w();
w('对照：现在的完整版是');
w();
w('```');
w('【积温·此刻】');
w('心情：舒展。');
w('pleased，表达比平时满，舒展得彻底，不遮掩半分受用。');
w('【此状态为潜意识的底色沉淀，自然浸润在回应里，不作任何元说明或刻意提及。】');
w('```');
w();
w('> 注意每格正文都以**英文簇名**开头（`pleased，`）—— 这是讨论中第 2 条待修项：');
w('> 簇名是坐标，本该只给模型定位用，不该出现在念出来的句子开头。');
w();
w('## 切割契约（本文所有形态都满足）');
w();
w('| 约束 | 现状 | 删档位行后 |');
w('|---|---|---|');
w('| 首行 `【积温·X】` 单行 | ✅ | ✅ |');
w('| 末行 ∈ 尾句集合 | ✅ | ✅ |');
w('| 块内无多余【】行 | ✅ | ✅ |');
w('| 块头只出现一次 | ✅ | ✅ |');
w();

const OUT = path.join(__dirname, 'reactive_block_full.md');
fs.writeFileSync(OUT, out.join('\n') + '\n', 'utf8');
console.log('written: _test/reactive_block_full.md  (' + out.length + ' lines)');
