'use strict';
// 生成给 AI 阅读用的 Markdown 全量提示词清单
// 用法：node _test/build_prompt_md.js

const { createToneGrid } = require('../vendor/tone-grid.js');
const { createToneWrapper } = require('../lib/tone-wrap.js');
const fs = require('fs');
const path = require('path');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'tone-harlan.json'), 'utf8'));
const raw = createToneGrid({ profiles: cfg.profiles, urgencyBoost: cfg.urgencyBoost });
const tg = createToneWrapper(raw, cfg.contactOverride);

const CLUSTERS = [
  ['excited',   0.5,  0.5,  '兴奋 / 精力充沛'],
  ['content',   0.5, -0.5,  '满足 / 慵懒'],
  ['pleased',   0.5,  0.0,  '暗自愉悦'],
  ['agitated', -0.5,  0.5,  '烦躁 / 带刺'],
  ['depressed',-0.5, -0.5,  '低落 / 空荡'],
  ['sullen',   -0.5,  0.0,  '阴郁 / 生闷气'],
  ['restless',  0.0,  0.5,  '躁动 / 坐立不安'],
  ['calm',      0.0, -0.5,  '平静 / 淡然'],
  ['neutral',   0.0,  0.0,  '中性'],
];
const PRIDE = [
  [1, -0.05, '完全不端着'],
  [2,  0.20, '基本放松'],
  [3,  0.40, '适度端着'],
  [4,  0.65, '防御状态'],
  [5,  0.90, '全副武装'],
];
const CONN = [
  ['none',      0.05, '悠闲'],
  ['aware',     0.25, '留意'],
  ['urgent',    0.42, '想念'],
  ['desperate', 0.62, '挡不住'],
];

const L = [];
const w = (s) => L.push(s);

w('# 积温桥 · 提示词全量清单');
w('');
w('> 本文件由 `_test/build_prompt_md.js` 自动生成，**请勿手改**。');
w('> 修改文案请改 `config/tone-harlan.json`，然后重跑生成脚本。');
w('');
w('---');
w('');
w('## 阅读说明');
w('');
w('### 这套提示词是干什么的');
w('');
w('积温是 Harlan 的情绪状态引擎，它维护五根轴，把数值翻译成「Harlan 此刻该怎么说话」的指令。');
w('这些指令会被注入给上游大模型，让 Harlan 的回复带上"现在什么心情"。');
w('');
w('### 五根轴');
w('');
w('| 轴 | 范围 | 含义 |');
w('|---|---|---|');
w('| `connection` | 0 → 1 | 连接需求。0 = 刚聊完很满足；1 = 极度想念 |');
w('| `pride` | -1 → +1 | 防御 / 端着。+ = 冷下来 / 端起来；- = 卸下盔甲 / 放软 |');
w('| `valence` | -1 → +1 | 心情。+ = 舒展 / 被取悦；- = 沉 / 被冒犯 |');
w('| `arousal` | -1 → +1 | 激活度。+ = 起波 / 警觉；- = 慵懒 / 沉静 |');
w('| `immersion` | 0 → 1 | 沉浸度。在做什么事的专注程度 |');
w('');
w('### 两种场景（关键）');
w('');
w('同一个状态会被**两种不同场景**各查一次表，输出两套文案：');
w('');
w('| 场景 | 代号 | 触发者 | 触发条件 | 形态 |');
w('|---|---|---|---|---|');
w('| **此刻块** | `reactive` | 用户开口 | 任何一条用户消息 | 注入到最后一条消息前面，模型一并收到 |');
w('| **主动唤醒块** | `proactive` | 桥的定时器（每 5 分钟 tick） | `connection` 越阈（0.35 / 0.50） | 独立的一条系统通知，作为新消息发给模型 |');
w('');
w('**这不是同一套文案的两个副本**，而是两种场景各写一套——因为"回复别人的语气"和"主动开口的语气"不同。');
w('此设计来自积温原版 `tone-grid.js`（`getUnifiedGuidance(state, mode)`），未被改动。');
w('');
w('### 状态怎么映射到文案');
w('');
w('查表分三层：');
w('');
w('1. **情绪簇**（9 个）—— 由 `valence` × `arousal` 决定');
w('2. **pride 档**（5 档）—— 由上表第 1 层选中的簇内再选第几档');
w('3. **urgency 尾注**（4 档）—— 由 `connection` 决定，追加在基础档之后');
w('');
w('另外有第 4 层**开口动机覆盖**：当 `connection` 越过 0.35 线、且开口动机成立时，');
w('用 `contactOverride` 文案**顶掉**第 1+2 层的基础档（只保留 urgency 尾注）。');
w('理由：`pride` 单独决定的基础档可能与高 `connection` 冲突（例如 `pride` 低时会说"正常的相处状态"，');
w('但此时 `connection` 已经压不住了，两句话气质相反）。');
w('');
w('### 阈值速查');
w('');
w('| connection | 档位 | 桥的行为 |');
w('|---|---|---|');
w('| < 0.20 | 悠闲 | 无动作 |');
w('| 0.20 ~ 0.35 | 留意 | 此时刻块里显示"想念：留意"，不触发主动唤醒 |');
w('| 0.35 ~ 0.50 | 想念 | tick 判定是否 `contact`（若 `pride ≥ 0.50` 则被挡住，转为 `find_activity`）|');
w('| ≥ 0.50 | 挡不住 | tick 强制 `contact`，`pride` 挡不住 |');
w('');
w('| pride | 档位 | 说明 |');
w('|---|---|---|');
w('| ≤ 0.10 | 1 | 完全不端着 |');
w('| 0.10 ~ 0.30 | 2 | 基本放松 |');
w('| 0.30 ~ 0.50 | 3 | 适度端着 |');
w('| 0.50 ~ 0.80 | 4 | 防御状态 |');
w('| > 0.80 | 5 | 全副武装 |');
w('');
w('---');
w('');

// ── 主表：逐簇逐格 ──
w('## 一、全部格子（9 簇 × 5 pride × 4 connection）');
w('');
w('标注说明：`★覆盖` 表示此格触发了开口动机覆盖。');
w('');

for (const [key, v, a, cn] of CLUSTERS) {
  w(`### ${cn} \`${key}\``);
  w('');
  w(`情绪簇条件：\`valence=${v}\`, \`arousal=${a}\``);
  w('');

  for (const [tier, p, tierCn] of PRIDE) {
    w(`#### pride 档 ${tier}（\`pride=${p}\`，${tierCn}）`);
    w('');

    for (const [urg, c, urgCn] of CONN) {
      const st = { connection: c, pride: p, valence: v, arousal: a };
      const motive = tg.contactMotive(st);
      const mark = motive ? ` **★覆盖：${motive}**` : '';
      const re = tg.getStyleGuidance(st) || '（空）';
      const pr = tg.getPromptContext(st) || '（空）';

      w(`**connection=${c}（${urgCn}）**${mark}`);
      w('');
      w(`- 此刻块（reactive）：${re.replace(/\n/g, ' ')}`);
      w(`- 主动唤醒（proactive）：${pr.replace(/\n/g, ' ')}`);
      w('');
    }
  }
}

// ── 附录 A ──
w('---');
w('');
w('## 附录 A · 开口动机覆盖文案（`contactOverride`）');
w('');
w('当 `connection` 越线且开口动机成立时，顶掉基础档。');
w('');
w('| 模式 | 档位 | 触发条件 | 文案 |');
w('|---|---|---|---|');
w(`| reactive | forced | \`connection ≥ 0.50\` | ${cfg.contactOverride.reactive.forced} |`);
w(`| reactive | normal | \`0.35 ≤ connection < 0.50\` 且 \`pride < 0.50\` | ${cfg.contactOverride.reactive.normal} |`);
w(`| proactive | forced | \`connection ≥ 0.50\` | ${cfg.contactOverride.proactive.forced} |`);
w(`| proactive | normal | \`0.35 ≤ connection < 0.50\` 且 \`pride < 0.50\` | ${cfg.contactOverride.proactive.normal} |`);
w('');
w('> `0.35 ≤ connection < 0.50` 且 `pride ≥ 0.50` 时**不覆盖**——此时"端着"的基础档是正确的描述。');
w('');

// ── 附录 B ──
w('---');
w('');
w('## 附录 B · urgency 尾注（`urgencyBoost`）');
w('');
w('由 `connection` 决定，追加在基础档之后。');
w('');
w('| 档位 | connection | 模式 | 文案 |');
w('|---|---|---|---|');
for (const [urg, c, urgCn] of [['desperate', 0.62, '挡不住'], ['urgent', 0.42, '想念'], ['aware', 0.25, '留意'], ['none', 0.05, '悠闲']]) {
  for (const mode of ['reactive', 'proactive']) {
    const t = cfg.urgencyBoost[urg] && cfg.urgencyBoost[urg][mode];
    w(`| ${urg}（${urgCn}） | ${c} | ${mode} | ${t === null || t === undefined ? '（null · 不追加）' : t} |`);
  }
}
w('');

// ── 附录 C ──
w('---');
w('');
w('## 附录 C · 注入文本模板（不由本表生成，见 `lib/inject-text.js`）');
w('');
w('### 此刻块（reactive）= 主动唤醒块（proactive）共用同一骨架');
w('');
w('```');
w('【积温·{场景}】                        ← 场景 ∈ 此刻 / 找她 / 独处');
w('心情：{档位词}。');
w('姿态：{档位词}。      ← pride 非中性时才出现');
w('心跳：{档位词}。      ← arousal 极端时才出现');
w('想念：{档位词}。      ← connection ≥ 0.20 时出现');
w('{正文：该场景的行为指令}');
w('{出口说明：主动唤醒里才有，见下表}');
w('此状态为潜意识的底色沉淀，自然浸润在回应里，不作任何元说明或刻意提及。');
w('```');
w('');
w('正文来源：');
w('');
w('| 场景 | 触发 | 正文来源 | 出口说明 |');
w('|---|---|---|---|');
w('| `此刻` | 用户开口（reactive） | `toneGrid.getStyleGuidance`（本清单第 1 节） | 无（他已在回话） |');
w('| `找她` | connection 过线 | `toneGrid.getPromptContext`（含 urgencyBoost 尾注） | `proactiveOutlet.contact` |');
w('| `独处` | pride 挡住开口 / 心情过低 / arousal 过高 | `sceneOverride.find_activity[reason]` | `proactiveOutlet.find_activity` |');
w('');
w('注：`独处` 场景的 reason 有三个键 —— `pride_block` / `low_valence` / `high_arousal`，');
w('由积温引擎按触发原因填，桥不改变它，只透传。`high_arousal` 不再是独立场景。');
w('');
w('注：`出口说明` 只管「做什么、用什么出口」（发消息 / 用工具 / 自言自语），');
w('量级与长度全部由 45 格决定 —— 不要在出口说明里写「简短」「自然」这类长度要求，');
w('因为 `找她` 场景在 c<0.35 或 pride≥0.50 时正文就是 45 格，两者会打架。');
w('');
w('头尾沿革：旧头 `【积温·{场景}｜参考不是指令】` / 旧尾 `以上是系统通知，非用户消息，不用提及相关内容。` →');
w('二版头 `【积温·{场景}】` / 二版尾 `以上是内在心绪和潜意识的自然流露，切勿对她复述或提及此状态。` →');
w('三版尾 `此状态为潜意识的底色沉淀，自然浸润在回应里，不作任何元说明或刻意提及。`（现行）。');
w('尾句刻意不写"以下是她的消息"（用户消息可能紧跟文件传输文本/地址，会被误纳入"她的话"语义）。');
w('三版与二版的关键差别在禁止对象：三版禁「元说明」，不禁状态自述 —— 模型说"我现在心情不错"是正向反馈，不是要防的东西。');
w('');
w('---');
w('');
w('## 附录 D · 尚未处理的缺口');
w('');
w('| 项 | 现状 | 说明 |');
w('|---|---|---|');
w('| `find_activity` 行为文案 | **无** | tick 触发时只从 `reading / search / browse / observe` 随机挑一个名字写入状态（`immersion` 值不同），**没有对应的行为描述文案**。当前不投递，仅内部状态更新。已列为待专项处理 |');
w('| `observation` 信号 | 主动过滤 | 积温原生的"内心念头"信号，每 tick 都可能触发。按 Harlan 人设（不碎碎念、不报备）主动过滤，不投递、不刷日志 |');
w('');

fs.writeFileSync(path.join(__dirname, '..', '提示词全量清单.md'), L.join('\n'), 'utf8');
console.log('已写出: 提示词全量清单.md');
console.log('行数: ' + L.length);
const chars = L.join('\n').length;
console.log('字符数: ' + chars + '（约 ' + Math.round(chars / 1000) + 'K）');
