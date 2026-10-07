'use strict';
// 主动唤醒提示词 · 全量成型清单
// 用法：node _test/dump_proactive.js   → 写 ../主动唤醒清单.md
//
// 目的：把"模型实际会收到什么"完整摊开，供人工验收。
// 全部文本从 config/tone-harlan.json 现场装配，不手抄，改配置后重跑即可。
//
// 关键结构（容易误判，写在这里）：
//   contact 场景的正文**不总是** 45 格。tone-wrap 的 contactOverride 会整条顶掉基础档，
//   只保留 urgency 尾注。于是 contact 只有三种形态：
//     c ≥ 0.50                    → forced 覆盖 + desperate 尾注
//     0.35 ≤ c < 0.50 且 p < 0.50 → normal 覆盖 + urgent 尾注
//     0.35 ≤ c < 0.50 且 p ≥ 0.50 → 45 格（pride 档 4/5）+ urgent 尾注   ← 只有这里进 45 格
//   find_activity 场景的正文来自 sceneOverride，固定 4 条，与状态无关。

const fs = require('fs');
const path = require('path');
const { createToneGrid } = require('../vendor/tone-grid.js');
const { createToneWrapper } = require('../lib/tone-wrap.js');
const { buildProactiveNotice, meaningfulLines, BOUNDARY_LINE } = require('../lib/inject-text.js');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'tone-harlan.json'), 'utf8'));
const tg = createToneWrapper(
  createToneGrid({ profiles: cfg.profiles, urgencyBoost: cfg.urgencyBoost }),
  cfg.contactOverride
);

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
const PRIDE = { 1: -0.05, 2: 0.2, 3: 0.4, 4: 0.65, 5: 0.9 };

const notice = (st, scene, reason) =>
  buildProactiveNotice(st, tg, { scene, reason }, cfg.sceneOverride, cfg.proactiveOutlet);

const out = [];
const w = (s = '') => out.push(s);

w('# 主动唤醒提示词 · 全量成型清单');
w();
w('> 自动生成（`node _test/dump_proactive.js`）。所有文本取自 `config/tone-harlan.json`，不与配置漂移。');
w('> 场景标签：`找她` = 桥判定"想找她"；`独处` = 桥判定"该做点别的"。');
w();
w('---');
w();
w('## 〇、一个通知块的装配顺序');
w();
w('| # | 段落 | 来源 | 说明 |');
w('|---|---|---|---|');
w('| ① | `【积温·此刻】` | `SCENE_TAG` | 块头。2026-10-07 起三场景统一，不再区分 |');
w('| ② | 档位行 `心情：… 姿态：… 心跳：… 想念：…` | `meaningfulLines()` | 只挑"值得说"的行，中性行不出现（心情除外） |');
w('| ③ | 正文 | 见下两节 | 语调指令 |');
w('| ④ | 出口说明 | `proactiveOutlet` | **只在主动唤醒加**，此刻块没有 |');
w('| ⑤ | 尾句 | `BOUNDARY_LINE` | 固定，压尾 |');
w();
w('---');
w();
w('## 一、找她（contact）');
w();
w('触发条件由积温引擎给：`connection` 越过考虑线（0.35）。');
w('正文取决于 **pride 闸门**，所以只有三种形态——');
w();
w('| 形态 | 条件 | 正文构成 |');
w('|---|---|---|');
w('| **A 强制** | `c ≥ 0.50` | `contactOverride.proactive.forced` ＋ `urgencyBoost.desperate.proactive` |');
w('| **B 常规** | `0.35 ≤ c < 0.50` 且 `pride < 0.50` | `contactOverride.proactive.normal` ＋ `urgencyBoost.urgent.proactive` |');
w('| **C 被 pride 挡住** | `0.35 ≤ c < 0.50` 且 `pride ≥ 0.50` | **45 格之一**（pride 档 4/5）＋ `urgencyBoost.urgent.proactive` |');
w();
w('⚠️ 只有形态 C 会把 45 格正文带进主动唤醒。A / B 两种形态下 45 格被整条顶掉，');
w('   只有档位行还在变。');
w();

function block(title, st, scene, reason) {
  w('### ' + title);
  w();
  w('状态：`' + ['connection', 'pride', 'valence', 'arousal']
    .map((k) => `${k}=${st[k]}`).join('  ') + '`');
  w();
  w('```text');
  w(notice(st, scene, reason));
  w('```');
  w();
}

block('形态 A · 强制（c ≥ 0.50）',
  { connection: 0.62, pride: 0.20, valence: 0.0, arousal: 0.0, immersion: 0.10 }, 'contact');
block('形态 B · 常规（0.35 ≤ c < 0.50，pride < 0.50）',
  { connection: 0.42, pride: 0.20, valence: 0.0, arousal: 0.0, immersion: 0.10 }, 'contact');
block('形态 C · 被 pride 挡住（0.35 ≤ c < 0.50，pride ≥ 0.50）',
  { connection: 0.42, pride: 0.65, valence: 0.0, arousal: -0.5, immersion: 0.10 }, 'contact');

w('### 形态 C 会出现的全部正文（45 格 × pride 档 4/5）');
w();
w('九簇 × 两档 = 18 条。这是 45 格中唯一能进主动唤醒的部分。');
w();
w('| 簇 | pride 档 | 正文（正文之后统一接 `urgencyBoost.urgent.proactive`） |');
w('|---|---|---|');
for (const [name, va] of Object.entries(CLUSTERS)) {
  for (const tier of [4, 5]) {
    const st = { connection: 0.42, pride: PRIDE[tier], valence: va.v, arousal: va.a, immersion: 0.1 };
    const body = tg.getPromptContext(st);
    const lines = body.split('\n');
    const core = lines.slice(0, lines.length - 1).join(' '); // 去掉 urgency 尾注
    w(`| \`${name}\` | ${tier} | ${core} |`);
  }
}
w();
w('---');
w();
w('## 二、独处（find_activity）');
w();
w('正文来自 `sceneOverride.find_activity[reason]`，**与状态无关**（档位行另算）。');
w('引擎给三个 reason，另有一条 `default` 兜底。');
w();
for (const [reason, st] of [
  ['pride_block', { connection: 0.20, pride: 0.70, valence: -0.10, arousal: -0.20, immersion: 0.10 }],
  ['low_valence', { connection: 0.10, pride: 0.20, valence: -0.80, arousal: -0.50, immersion: 0.10 }],
  ['high_arousal', { connection: 0.10, pride: 0.20, valence: 0.00, arousal: 0.80, immersion: 0.10 }],
  ['default（兜底）', { connection: 0.10, pride: 0.20, valence: 0.00, arousal: 0.00, immersion: 0.10 }],
]) {
  const key = reason.startsWith('default') ? 'default' : reason;
  block('reason = `' + reason + '`', st, 'find_activity', key);
}

w('---');
w();
w('## 三、用到的全部片段（去重后）');
w();
w('### 3.1 `contactOverride.proactive`（顶掉 45 格的两条）');
w();
for (const [k, v] of Object.entries(cfg.contactOverride.proactive)) w(`- **${k}**　${v}`);
w();
w('### 3.2 `urgencyBoost` 的 proactive 列');
w();
w('| 档 | connection | 文案 |');
w('|---|---|---|');
const URANGE = { desperate: 'c ≥ 0.50', urgent: 'c ≥ 0.35', aware: 'c ≥ 0.20', none: '< 0.20' };
for (const [k, v] of Object.entries(cfg.urgencyBoost)) {
  w(`| \`${k}\` | ${URANGE[k] || ''} | ${v.proactive === null ? '（无）' : v.proactive} |`);
}
w();
w('> 找她场景的 c 一定 ≥ 0.35，所以只可能用到 `urgent` 与 `desperate` 两档。');
w('> `aware` 那条不会进主动唤醒，但会出现在此刻块里。');
w();
w('### 3.3 `sceneOverride.find_activity`');
w();
for (const [k, v] of Object.entries(cfg.sceneOverride.find_activity)) w(`- **${k}**　${v}`);
w();
w('### 3.4 `proactiveOutlet`（出口说明）');
w();
for (const [k, v] of Object.entries(cfg.proactiveOutlet)) w(`- **${k}**　${v}`);
w();
w('### 3.5 档位行取值表（`meaningfulLines`）');
w();
w('| 行 | 出现条件 | 取值 |');
w('|---|---|---|');
w('| 心情 | **恒出现** | `valence > 0.3` → 舒展 ／ `< -0.3` → 沉 ／ 否则 中性 |');
w('| 姿态 | `pride > 0.3` 或 `pride < -0.1` | `>0.8` 完全收着 ／ `>0.5` 收着 ／ `>0.3` 留着一点余地 ／ `>-0.1` 平常 ／ `>-0.3` 松了 ／ 否则 完全不设防 |');
w('| 心跳 | `arousal > 0.3` 或 `< -0.3` | `>0.3` 起波 ／ `< -0.3` 慵懒 |');
w('| 想念 | `connection ≥ 0.20` | `≥0.50` 挡不住 ／ `≥0.35` 想念 ／ `≥0.20` 留意 |');
w();
w('> 阈值实现在 `lib/inject-text.js` 的 `labelConnection / labelPride / labelValence / labelArousal`。');
w('> 主动唤醒时 `connection` 一定 ≥ 0.20，所以「想念」这一行基本都会出现。');
w();
w('### 3.6 尾句');
w();
w('```text');
w(BOUNDARY_LINE);
w('```');
w();

const target = path.join(__dirname, '..', '..', '主动唤醒清单.md');
fs.writeFileSync(target, out.join('\n'), 'utf8');
console.log('written: ' + target);
console.log('lines: ' + out.length);
