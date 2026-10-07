'use strict';
// 穷举语调网格的全部可能性，导出成可读清单
// 用法：node _test/dump_all_prompts.js

const { createToneGrid } = require('../vendor/tone-grid.js');
const fs = require('fs');
const path = require('path');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'tone-harlan.json'), 'utf8'));
const tg = createToneGrid({ profiles: cfg.profiles, urgencyBoost: cfg.urgencyBoost });

// 构造能精确命中每个格子的代表状态
const CLUSTERS = {
  excited:   { v: 0.5,  a: 0.5  },
  content:   { v: 0.5,  a: -0.5 },
  pleased:   { v: 0.5,  a: 0.0  },
  agitated:  { v: -0.5, a: 0.5  },
  depressed: { v: -0.5, a: -0.5 },
  sullen:    { v: -0.5, a: 0.0  },
  restless:  { v: 0.0,  a: 0.5  },
  calm:      { v: 0.0,  a: -0.5 },
  neutral:   { v: 0.0,  a: 0.0  },
};
// pride → 档位（与 vendor classifyPride 一致）
const PRIDE = { 1: -0.05, 2: 0.2, 3: 0.4, 4: 0.65, 5: 0.9 };

const out = [];
function w(s) { out.push(s); }

w('# 积温桥 · 全部提示词穷举清单');
w('');
w('本文件由 _test/dump_all_prompts.js 自动生成，不要手改。');
w('');
w('结构：');
w('- reactive  = 用户开口时注入到消息里的「此刻块」风格指令（getStyleGuidance）');
w('- proactive = 阈值触发主动唤醒时的通知正文（getPromptContext）');
w('- 每条 = 45 格正文，由 V×A 簇 + pride 档决定。');
w('- 2026-10-08 起 `connection` **不再进 45 格**（urgency 尾注与 contactOverride 已退役），');
w('  它现在只作用在文末列出的**描述层第 1 段**。');
w('');

for (const [cluster, va] of Object.entries(CLUSTERS)) {
  w('');
  w('═'.repeat(74));
  w(`## 情绪簇：${cluster}  (valence=${va.v}, arousal=${va.a})`);
  w('═'.repeat(74));

  for (const tier of [1, 2, 3, 4, 5]) {
    const st = { connection: 0, pride: PRIDE[tier], valence: va.v, arousal: va.a };
    const re = tg.getStyleGuidance(st);
    const pr = tg.getPromptContext(st);

    w('');
    w(`── pride 档 ${tier} (p=${PRIDE[tier]}) ──`);
    w('  [reactive]');
    for (const ln of String(re || '(空)').split('\n')) w('    ' + ln);
    w('  [proactive]');
    for (const ln of String(pr || '(空)').split('\n')) w('    ' + ln);
  }
}

// ── 附：描述层四段（原始配置，未渲染）──
w('');
w('');
w('═'.repeat(74));
w('## 附 · 描述层四段（`describe`，2026-10-08 新增）');
w('═'.repeat(74));
w('');
w('拼在块头之后、45 格之前。陈述句、零祈使 —— 说「我此刻在什么处境」。');
w('');
w('### 段1 连接（`connection`，4 档）');
for (const it of cfg.describe.connection) {
  const label = it.max === undefined ? '≥ 0.50' : `< ${it.max.toFixed(2)}`;
  w(`  [${label}] ${it.text}`);
}
w('');
w('> 此刻块（reactive）不出这一段：那块建块时 connection 恒为 0。');
w('');
w('### 段2 骄傲（`pride`，6 档）');
for (const it of cfg.describe.pride) {
  const label = it.max === undefined ? '≥ 0.80' : `< ${it.max.toFixed(2)}`;
  w(`  [${label}] ${it.text}`);
}
w('');
w('### 段3 心情（`valence` × `arousal`）');
w(`  [v>0.3, a>0.3]   ${cfg.describe.mood.excited}`);
w(`  [v>0.3, a<-0.3]  ${cfg.describe.mood.content}`);
w(`  [v<-0.3, a>0.3]  ${cfg.describe.mood.agitated}`);
w(`  [v<-0.3, a<-0.3] ${cfg.describe.mood.depressed}`);
w(`  [v<-0.3]         ${cfg.describe.mood.low}`);
w(`  [v>0.3]          ${cfg.describe.mood.high}`);
w('  [其余]           （不输出）');
w('');
w('### 段4 沉浸（`immersion`，3 档）');
w(`  [immersion>0.3 且有活动] ${cfg.describe.immersion.doing}`);
w('  [0.1 ≤ immersion ≤ 0.3] （死带，两句都不出）');
w(`  [immersion<0.1]        ${cfg.describe.immersion.idle}`);
w('');
w('  注：有冲浪产物的块里段4 不出 —— 产物头「之前独处冲浪时发现的东西：」与段4 的');
w('      doing 句说的是同一次冲浪，并列即重复。');
w('');
w('> 真来源 `lib/activity.js`：冲浪 spawn 成功后登记活动（`search` → `immersion=0.4`），');
w('> 产物回投时刷时间戳；之后按 0.01/分钟衰减。`lastActivity` 为空时不出（不编造活动）。');
w('');

// ── 附：已退役的两层 ──
w('');
w('═'.repeat(74));
w('## 附 · 已退役（2026-10-08）');
w('═'.repeat(74));
w('');
w('### urgencyBoost —— 四档全 null');
w('原用途：给 45 格补一句「她多久没动静」。退役原因：与描述层第 1 段同轴同义，');
w('且在「找她」块里与 contactOverride 叠成三句同义反复。');
w('⚠️ 置 null 而非删键 —— 不传 urgencyBoost 会让 vendor 回落到内置 DEFAULT_URGENCY。');
w('');
w('### contactOverride —— 键已删除');
w('原用途：connection 过线时顶掉由 pride 决定的基础档。退役原因：它把**整条 45 格**');
w('一起顶掉（只留「基调句 + 尾注」），导致「找她」块里 45 格一个字都出不来。');
w('原文案留档：git 历史（de0af31 及之前）。');
w('');

// 统计
const lines = out.join('\n');
fs.writeFileSync(path.join(__dirname, 'all-prompts.txt'), lines, 'utf8');
console.log('已写出 _test/all-prompts.txt');
console.log('总行数: ' + out.length);
console.log('总格数: 9 簇 × 5 pride 档 = 45 格 × 2 模式 = 90 条（描述层另列）');
