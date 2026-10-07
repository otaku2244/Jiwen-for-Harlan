'use strict';
// 主动唤醒提示词 · 全量成型清单
// 用法：node _test/dump_proactive.js   → 写 ../主动唤醒清单.md
//
// 目的：把"模型实际会收到什么"完整摊开，供人工验收。
// 全部文本从 config/tone-harlan.json 现场装配，不手抄，改配置后重跑即可。
//
// 关键结构（容易误判，写在这里）：
//   contact（找她）的正文 = **描述层 + 45 格**。
//   ⚠️ 2026-10-08 之前不是这样：contactOverride 会在 connection 过线时把**整条 45 格**顶掉，
//      只留「基调句 + urgency 尾注」，于是找她块里 45 格一个字都出不来。那层已退役。
//   find_activity（独处）的正文来自 sceneOverride，固定 4 条，与状态无关；
//   有冲浪产物时换成产物切片（`buildFindingBody`）。

const fs = require('fs');
const path = require('path');
const { createToneGrid } = require('../vendor/tone-grid.js');
const { createDescriber } = require('../lib/describe.js');
const { buildProactiveNotice, BOUNDARY_LINE } = require('../lib/inject-text.js');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'tone-harlan.json'), 'utf8'));
const tg = createToneGrid({ profiles: cfg.profiles, urgencyBoost: cfg.urgencyBoost });
const desc = createDescriber(cfg.describe);

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
  buildProactiveNotice(st, tg, { scene, reason }, cfg.sceneOverride, cfg.proactiveOutlet, desc);

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
w('| ② | 描述层 1~4 行 | `describe` | **2026-10-08 新增**。处境陈述，见 3.1 |');
w('| ③ | ~~档位行~~ | — | **2026-10-08 已整条删除**（与 45 格同义重复，详见 `lib/inject-text.js` 文件头） |');
w('| ④ | 正文 | 见下两节 | 45 格 / `sceneOverride` / 冲浪产物 |');
w('| ⑤ | 出口说明 | `proactiveOutlet` | **只在主动唤醒加**，此刻块没有 |');
w('| ⑥ | 尾句 | `BOUNDARY_LINE` / `SURF_TAIL_LINE` | 固定，压尾 |');
w();
w('---');
w();
w('## 一、找她（contact）');
w();
w('触发条件由积温引擎给：`connection` 越过考虑线（0.35）。');
w('正文 = **描述层 + 45 格**。`pride` 只决定 45 格取哪一档，**不再有覆盖分支**。');
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

block('开口动机成立（c 过线，pride 不高）',
  { connection: 0.42, pride: 0.20, valence: 0.0, arousal: 0.0, immersion: 0.10 }, 'contact');
block('端着（c 过线但 pride 高）',
  { connection: 0.42, pride: 0.65, valence: 0.0, arousal: -0.5, immersion: 0.10 }, 'contact');
block('强制线以上（c ≥ 0.50）',
  { connection: 0.62, pride: 0.20, valence: 0.0, arousal: 0.0, immersion: 0.10 }, 'contact');
block('心情也在低位（c 过线 + v/a 双低）',
  { connection: 0.42, pride: 0.20, valence: -0.6, arousal: -0.6, immersion: 0.10 }, 'contact');

w('### 找她会出现的全部 45 格正文（9 簇 × 5 档 = 45 条）');
w();
w('下表取 `proactive` 列。`reactive` 列的同格文案略有不同（回复 vs 开口），本清单不重复展开，');
w('见 `_test/all-prompts.txt`。');
w();
w('| 簇 | pride 档 | 45 格正文（proactive） |');
w('|---|---|---|');
for (const [name, va] of Object.entries(CLUSTERS)) {
  for (const tier of [1, 2, 3, 4, 5]) {
    const st = { connection: 0.42, pride: PRIDE[tier], valence: va.v, arousal: va.a, immersion: 0.1 };
    w(`| \`${name}\` | ${tier} | ${(tg.getPromptContext(st) || '').replace(/\n/g, ' ')} |`);
  }
}
w();
w('---');
w();
w('## 二、独处（find_activity）');
w();
w('正文来自 `sceneOverride.find_activity[reason]`，**与状态无关**。');
w('描述层照常拼在前面 —— 它说的是"我此刻在什么处境"，与"我该去做什么"不冲突。');
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

w('### 独处 + 有冲浪产物');
w();
w('正文换成产物切片，出口说明与 sceneOverride 正文都停用，尾句换成 `SURF_TAIL_LINE`。');
w('描述层整段保留：段4 说**动作**（「刚才在上网冲浪。」），产物头说**结果**');
w('（「搜到了一条有意思的内容：」）—— 两句维度不同，是"他干了什么 → 摸到了什么"的顺承。');
w('⚠️ 别为了"防重复"在描述层加场景开关（加过一次，已撤）：重复是文案层的事。');
w();
{
  const st = {
    connection: 0.42, pride: 0.65, valence: -0.05, arousal: 0.05,
    immersion: 0.40,
    lastActivity: { type: 'search', label: '上网冲浪', at: new Date().toISOString() },
  };
  w('```text');
  w(buildProactiveNotice(st, tg, {
    scene: 'find_activity', reason: 'surf',
    finding: { title: 'Attention Is All You Need', url: 'https://arxiv.org/abs/1706.03762', note: '把注意力机制从循环结构里拆出来单独用，序列建模不再依赖逐步递归。' },
  }, cfg.sceneOverride, cfg.proactiveOutlet, desc));
  w('```');
  w();
}

w('---');
w();
w('## 三、用到的全部片段（去重后）');
w();
w('### 3.1 `describe` —— 描述层四段（2026-10-08 新增）');
w();
w('| 段 | 档位 | 文案 |');
w('|---|---|---|');
for (const it of cfg.describe.connection) {
  const label = it.max === undefined ? '`connection ≥ 0.50`' : `\`< ${it.max.toFixed(2)}\``;
  w(`| 1 连接 | ${label} | ${it.text} |`);
}
const PL = ['`< 0.00`', '`[0.00, 0.10)`', '`[0.10, 0.30)`', '`[0.30, 0.50)`', '`[0.50, 0.80)`', '`≥ 0.80`'];
cfg.describe.pride.forEach((it, i) => w(`| 2 骄傲 | ${PL[i]} | ${it.text} |`));
w(`| 3 心情 | \`v>0.3, a>0.3\` | ${cfg.describe.mood.excited} |`);
w(`| 3 心情 | \`v<-0.3, a<-0.3\` | ${cfg.describe.mood.depressed} |`);
w(`| 3 心情 | 其余象限 | （见 config） |`);
w(`| 4 沉浸 | \`immersion>0.3\` 且有活动 | ${cfg.describe.immersion.doing} |`);
w(`| 4 沉浸 | \`0.1 ≤ immersion ≤ 0.3\` | （死带，不出） |`);
w(`| 4 沉浸 | \`immersion<0.1\` | ${cfg.describe.immersion.idle} |`);
w();
w('> 主动唤醒侧 `connection` 一定越线，所以段1 只可能取到第 3、4 档。');
w('> 段4 的真来源是 `lib/activity.js`：冲浪 spawn 成功后登记一次活动（`search` → `immersion=0.4`）。');
w('> 之后按 0.01/分钟自然衰减 —— 约 10 分钟后落进死带（两句都不出），约 30 分钟后回到 idle。');
w('> 桥不替模型编活动：`lastActivity` 为空时即使 immersion 高也不出段4。');
w();
w('### 3.2 `urgencyBoost` —— 2026-10-08 已退役');
w();
w('四档全部置 null。原用途是给 45 格补一句「她多久没动静」，退役原因：与描述层第 1 段');
w('同轴同义（同一根 `connection` 轴、同一组阈值），且在「找她」块里与 `contactOverride`');
w('叠成三句同义反复。');
w();
w('> ⚠️ 是置 null 而非删键：vendor 的 `createToneGrid` 在**不传** `urgencyBoost` 时会回落到');
w('> 内置 `DEFAULT_URGENCY`（作者文案，风格与本部署不符）。');
w();
w('### 3.3 `contactOverride` —— 2026-10-08 已退役（键已删除）');
w();
w('原用途：`connection` 过线时顶掉由 `pride` 决定的基础档。退役原因：它把**整条 45 格**');
w('一起顶掉了（只留「基调句 + 尾注」）。原文案留档 git 历史（`de0af31` 及之前）。');
w();
w('### 3.4 `sceneOverride.find_activity`');
w();
for (const [k, v] of Object.entries(cfg.sceneOverride.find_activity)) w(`- **${k}**　${v}`);
w();
w('### 3.5 `proactiveOutlet`（出口说明）');
w();
for (const [k, v] of Object.entries(cfg.proactiveOutlet)) w(`- **${k}**　${v}`);
w();
w('### 3.6 档位行 —— 2026-10-08 已整条删除');
w();
w('原来这里是 `心情：X。姿态：X。心跳：X。想念：X。` 的四行取值表。');
w('删除理由：四条各自 ≈ 45 格正文的某一维（心情←簇 / 姿态←pride 档 / 心跳←簇内 arousal /');
w('想念←urgency 尾注，同轴同阈值），属同义重复；且「想念」会重字成 `想念：想念。`、');
w('「悠闲」是永不可达的死档。');
w();
w('> 历史分析留档：`_test/state_lines_probe.txt` 与 `_test/compare_state_lines.txt`');
w('> （生成脚本已随对象一并退役）。');
w();
w('### 3.7 尾句');
w();
w('```text');
w(BOUNDARY_LINE);
w('```');
w();

const target = path.join(__dirname, '..', '..', '主动唤醒清单.md');
fs.writeFileSync(target, out.join('\n'), 'utf8');
console.log('written: ' + target);
console.log('lines: ' + out.length);
