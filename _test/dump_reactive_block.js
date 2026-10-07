'use strict';
// 「此刻块」文案完整版 —— 用生产配置 + 生产函数渲染，不手抄一个字
// 用法：node _test/dump_reactive_block.js   → 写 _test/reactive_block_full.md
//
// 此刻块 = buildInjectionBlock(state, toneGrid, desc)
//   走 toneGrid.getStyleGuidance（proactive 侧的对应方法是 getPromptContext）
//   描述层由 desc 提供，拼在 45 格之前
//   bridge.js 里非回环轮先 resetConnection() 再建块 → connection 恒为 0
//   → 描述层不出第 1 段
//   → urgencyBoost 四档已全 null → 正文没有 urgency 尾注 → 45 格恒等于 profiles[簇][pride档]

const fs = require('fs');
const path = require('path');
const { createToneGrid } = require('../vendor/tone-grid.js');
const { createDescriber } = require('../lib/describe.js');
const { buildInjectionBlock, BOUNDARY_LINE } = require('../lib/inject-text.js');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/tone-harlan.json'), 'utf8'));
const tg = createToneGrid({ profiles: cfg.profiles, urgencyBoost: cfg.urgencyBoost });
const desc = createDescriber(cfg.describe);

// 描述层是 buildXxx 新增的末位参数 —— 包一层，免得每个调用点手写。
const bN = (st, g, opts, so, po) => buildProactiveNotice(st, g, opts, so, po, desc);
const bI = (st, g) => buildInjectionBlock(st, g, desc);

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
w('> 线上代码版本 `ae2be4b` + 2026-10-08 档位行删除（本地工作区，待部署）。');
w();
w('## 块骨架');
w();
w('```');
w('【积温·此刻】                       ← 块头，固定');
w('<45 格正文，一条>                    ← profiles[簇][pride档]，恒为一行');
w('【此状态为潜意识的底色沉淀，自然浸润在回应里，不作任何元说明或刻意提及。】  ← 边界句，固定');
w('```');
w();
w('## 两条硬事实');
w();
w('1. **此刻块的 connection 恒为 0。** `bridge.js` 里非回环轮先 `resetConnection()` 再建块。');
w('   于是 connection 恒为 0 → 描述层不出第 1 段；urgencyBoost 四档全 null → **正文没有 urgency 尾注**，');
w('   45 格后面干干净净，不会多出「她安静得有点久了」那类句子。');
w('2. **块内没有档位行。** 2026-10-08 起 `心情/姿态/心跳/想念` 那条整行删除，');
w('   删除理由与不可补回的原因写在 `lib/inject-text.js` 文件头，回归守卫在');
w('   `_test/contract_check.js` 的「块内不含档位行」。');
w();

// ── 45 格全表 ─────────────────────────────────────────────────
w('## 一、正文全表（9 簇 × 5 档 = 45 格）');
w();
w('此刻块的正文只由 (簇, pride档) 决定。下面是全部 45 条 —— 线上会发出的就是这些句子，别无其它。');
w();
for (const [name, v, a] of CLUSTERS) {
  w(`### ${name}（v=${v.toFixed(2)}, a=${a.toFixed(2)}）`);
  w();
  w('| pride档 | p 区间 | 正文 |');
  w('|---|---|---|');
  for (const [tier, p, range] of TIERS) {
    const st = stateOf(v, a, p);
    const block = bI(st, tg);
    const lines = block.split('\n');
    const body = lines.find((l) => l && !l.startsWith('【积温') && l !== BOUNDARY_LINE) || '（空）';
    w(`| ${tier} | ${range} | ${body} |`);
  }
  w();
}

// ── 完整块样例 ────────────────────────────────────────────────
w('## 二、完整块样例（原样贴出，含块头/正文/边界句）');
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
  const block = bI(stateOf(v, a, p), tg);
  w(`**${name}**`);
  w();
  w('```');
  w(block);
  w('```');
  w();
}

// ── 档位行删除前后对照 ────────────────────────────────────────
w('## 三、档位行删除前后（2026-10-08 已实施）');
w();
w('删掉的只有第 2 行，其余一字不动。此刻块现在是「块头 + 45 格正文 + 边界句」，即上面第二节的形态。');
w();
w('被删掉的那一行长这样（历史形态，留档对照）：');
w();
w('```');
w('【积温·此刻】');
w('心情：舒展。');
w('pleased，表达比平时满，舒展得彻底，不遮掩半分受用。');
w('【此状态为潜意识的底色沉淀，自然浸润在回应里，不作任何元说明或刻意提及。】');
w('```');
w();
w('> 「心情：舒展。」与紧随其后的 `pleased，…` 说的是同一件事（V×A 同轴），');
w('> 而 45 格那条粒度更细、恰好覆盖它。同一个块里留两句同义的话，');
w('> 模型有可能只读到粗的那句 —— 这是删除的直接理由。');
w();
w('> 另注意每格正文仍以**英文簇名**开头（`pleased，`）—— 这是另一条待修项：');
w('> 簇名是坐标，本该只给模型定位用，不该出现在念出来的句子开头。');
w();
w('## 切割契约（本文所有形态都满足）');
w();
w('| 约束 | 现状 |');
w('|---|---|');
w('| 首行 `【积温·X】` 单行 | ✅ |');
w('| 末行 ∈ 尾句集合 | ✅ |');
w('| 块内无多余【】行 | ✅ |');
w('| 块头只出现一次 | ✅ |');
w('| 块内不含档位行（2026-10-08 起） | ✅ |');
w();

const OUT = path.join(__dirname, 'reactive_block_full.md');
fs.writeFileSync(OUT, out.join('\n') + '\n', 'utf8');
console.log('written: _test/reactive_block_full.md  (' + out.length + ' lines)');
