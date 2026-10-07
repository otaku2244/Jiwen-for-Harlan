'use strict';
// 生成给 AI 阅读用的 Markdown 全量提示词清单
// 用法：node _test/build_prompt_md.js

const { createToneGrid } = require('../vendor/tone-grid.js');
const { createDescriber } = require('../lib/describe.js');
const { buildInjectionBlock, buildProactiveNotice, BOUNDARY_LINE } = require('../lib/inject-text.js');
const fs = require('fs');
const path = require('path');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'tone-harlan.json'), 'utf8'));
const tg = createToneGrid({ profiles: cfg.profiles, urgencyBoost: cfg.urgencyBoost });
const desc = createDescriber(cfg.describe);

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
w('每次注入的块 = **描述层**（处境）+ **45 格**（语气）。');
w('');
w('**描述层**（`lib/describe.js`，四段，2026-10-08 新增）—— 说「我此刻在什么处境」，陈述句、零祈使：');
w('');
w('| 段 | 轴 | 档数 |');
w('|---|---|---|');
w('| 1 连接 | `connection` | 4 |');
w('| 2 骄傲 | `pride` | 6 |');
w('| 3 心情 | `valence` × `arousal` | 4 象限 + 2 单轴 |');
w('| 4 沉浸 | `immersion` | 2 |');
w('');
w('**45 格**（本清单第一节）—— 说「那就该怎么说话」，全是行为指令：');
w('');
w('1. **情绪簇**（9 个）—— 由 `valence` × `arousal` 决定');
w('2. **pride 档**（5 档）—— 在选中的簇内再选第几档');
w('');
w('> 历史：查表曾多两层 —— `urgency 尾注`（由 `connection` 决定）与**开口动机覆盖**');
w('> （`contactOverride`：越线时顶掉基础档）。两者 2026-10-08 一并退役。原因：');
w('> `contactOverride` 会把**整条 45 格**顶掉，只留「基调句 + 尾注」，于是「找她」块里');
w('> 45 格一个字都出不来；而 urgency 尾注与描述层第 1 段同轴同义。现在这两件事都归描述层管。');
w('');
w('### 阈值速查');
w('');
w('| connection | 档位 | 桥的行为 |');
w('|---|---|---|');
w('| < 0.20 | 悠闲 | 无动作 |');
w('| 0.20 ~ 0.35 | 留意 | 此刻块照常出 45 格正文，不触发主动唤醒 |');
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
w('## 一、全部格子（9 簇 × 5 pride）');
w('');
w('每格给出该状态下的 45 格正文（reactive / proactive 两个模式）。');
w('2026-10-08 起 `connection` **不再影响 45 格** —— 它的 4 档只作用在描述层第 1 段（见附录 A）。');
w('');

for (const [key, v, a, cn] of CLUSTERS) {
  w(`### ${cn} \`${key}\``);
  w('');
  w(`情绪簇条件：\`valence=${v}\`, \`arousal=${a}\``);
  w('');

  for (const [tier, p, tierCn] of PRIDE) {
    const st = { connection: 0.42, pride: p, valence: v, arousal: a };
    const re = tg.getStyleGuidance(st) || '（空）';
    const pr = tg.getPromptContext(st) || '（空）';

    w(`#### pride 档 ${tier}（\`pride=${p}\`，${tierCn}）`);
    w('');
    w(`- **此刻块**（reactive）：${re.replace(/\n/g, ' ')}`);
    w(`- **主动唤醒**（proactive）：${pr.replace(/\n/g, ' ')}`);
    w('');
  }
}

// ── 附录 A ──
w('---');
w('');
w('## 附录 A · 描述层四段（`describe`）');
w('');
w('说「我此刻在什么处境」，陈述句、零祈使。拼在块头之后、45 格之前。');
w('');
w('| 段 | 档位 | 文案 |');
w('|---|---|---|');
for (const it of cfg.describe.connection) {
  const label = it.max === undefined ? 'connection ≥ 0.50' : `connection < ${it.max.toFixed(2)}`;
  w(`| 1 连接 | \`${label}\` | ${it.text} |`);
}
const PRIDE_LABEL = ['pride < 0.00', '0.00 ≤ pride < 0.10', '0.10 ≤ pride < 0.30', '0.30 ≤ pride < 0.50', '0.50 ≤ pride < 0.80', 'pride ≥ 0.80'];
cfg.describe.pride.forEach((it, i) => w(`| 2 骄傲 | \`${PRIDE_LABEL[i]}\` | ${it.text} |`));
w(`| 3 心情 | \`v>0.3, a>0.3\` | ${cfg.describe.mood.excited} |`);
w(`| 3 心情 | \`v>0.3, a<-0.3\` | ${cfg.describe.mood.content} |`);
w(`| 3 心情 | \`v<-0.3, a>0.3\` | ${cfg.describe.mood.agitated} |`);
w(`| 3 心情 | \`v<-0.3, a<-0.3\` | ${cfg.describe.mood.depressed} |`);
w(`| 3 心情 | \`v<-0.3\`（a 中性） | ${cfg.describe.mood.low} |`);
w(`| 3 心情 | \`v>0.3\`（a 中性） | ${cfg.describe.mood.high} |`);
w('| 3 心情 | `\\|v\\|≤0.3` 且 `\\|a\\|≤0.3` | （不输出） |');
w(`| 4 沉浸 | \`immersion>0.3\` 且有活动 | ${cfg.describe.immersion.doing} |`);
w('| 4 沉浸 | `0.1 ≤ immersion ≤ 0.3` | （死带，两句都不出） |');
w(`| 4 沉浸 | \`immersion<0.1\` | ${cfg.describe.immersion.idle} |`);
w('');
w('> **「独处 + 有产物」的块里第 4 段照出** —— 两句分工：段4 说**动作**（「刚才在上网冲浪。」），');
w('> 产物头说**结果**（「搜到了一条有意思的内容：」），合起来是顺承，不是同一件事两遍。');
w('> ⚠️ 2026-10-08 曾试过"有产物时关掉段4"（给描述层加 `withImmersion` 开关），**已撤** ——');
w('> 那是把文案问题当渲染问题修：加一个接口就得在骨骼里加一条判断，而重复只需改一句话。');
w('> 判据 = **两层各说各的维度**（描述层=处境/动作，产物层=结果）。');
w('');
w('> **此刻块（reactive）不出第 1 段** —— 段1 的问句全是时间维度的（「她很久没动静了。」），');
w('> 而此刻块的场景是"她刚说完这一句"，一句都不成立 → 段1 只留给主动唤醒侧。');
w('');
w('> 第 4 段的真来源是 `lib/activity.js`：冲浪 spawn 成功后登记一次活动');
w('> （`search` → `immersion = 0.4`），产物回投时再刷一次时间戳。之后按 0.01/分钟');
w('> 自然衰减 —— 约 10 分钟后落进死带（两句都不出），约 30 分钟后回到 idle。');
w('> `lastActivity` 为空时即使 `immersion` 高也不出段4（桥不替模型编活动）。');
w('');

// ── 附录 B ──
w('---');
w('');
w('## 附录 B · urgency 尾注 —— 已退役');
w('');
w('`urgencyBoost` 四档于 2026-10-08 **全部置 null**。原用途是给 45 格补一句');
w('「她多久没动静」，退役原因：');
w('');
w('1. 与描述层第 1 段**同轴同义** —— 同一根 `connection` 轴、同一组阈值（0.20 / 0.35 / 0.50）；');
w('2. 在「找她」块里它与 `contactOverride` 叠成三句同义反复。');
w('');
w('> ⚠️ 是置 null 而不是从 config 删键：vendor 的 `createToneGrid` 在**不传** `urgencyBoost`');
w('> 时会回落到内置 `DEFAULT_URGENCY`（作者文案，风格与本部署不符）。四档全 null 才是真关掉。');
w('');

// ── 附录 C ──
w('---');
w('');
w('## 附录 C · 注入文本模板（不由本表生成，见 `lib/inject-text.js`）');
w('');
w('### 三场景同构 —— 差别只在正文来源');
w('');
w('```');
w('【积温·此刻】                          ← 块头。2026-10-07 起三场景统一');
w('{描述层 1~4 行}                        ← 处境。陈述句、零祈使（附录 A）');
w('{正文：该场景的行为指令}                ← 45 格 / sceneOverride / 冲浪产物');
w('{出口说明：主动唤醒里才有，见下表}');
w(BOUNDARY_LINE + '   ← 尾句整句带【】，与块头呼应');
w('```');
w('');
w('> ⚠️ 块内除块头外**不得出现任何【】行** —— Serein 的剥离器见到行首【X】会重算跳过态，');
w('> 内层多一个【】就提前出块，产物会整段泄漏进归档与检索。描述层与产物正文都是裸行。');
w('');
w('> ⚠️ 2026-10-08 起块内**没有档位行**。旧形态的第二行是');
w('> `心情：{档位词}。姿态：…。心跳：…。想念：…。`，与紧随其后的 45 格正文同义重复');
w('> （四条各自 ≈ 正文的某一维），已整条删除。');
w('');
w('正文来源：');
w('');
w('| 场景 | 触发 | 正文来源 | 出口说明 |');
w('|---|---|---|---|');
w('| `此刻` | 用户开口（reactive） | 描述层（不出第 1 段）+ `getStyleGuidance` | 无（他已在回话） |');
w('| `找她` | connection 过线 | 描述层 + `getPromptContext`（纯 45 格） | `proactiveOutlet.contact` |');
w('| `独处` | pride 挡住开口 / 心情过低 / arousal 过高 | 描述层 + `sceneOverride.find_activity[reason]` | `proactiveOutlet.find_activity` |');
w('| `独处 + 有产物` | 冲浪回投 `/surf/finding` | 描述层 + 产物切片（`buildFindingBody`） | 无（改由冲浪尾句收尾） |');
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
w('三版尾 `此状态为潜意识的底色沉淀，自然浸润在回应里，不作任何元说明或刻意提及。` →');
w('四版尾 `' + BOUNDARY_LINE + '`（现行，整句套【】）。');
w('尾句刻意不写"以下是她的消息"（用户消息可能紧跟文件传输文本/地址，会被误纳入"她的话"语义）。');
w('三版与二版的关键差别在禁止对象：三版起禁「元说明」，不禁状态自述 —— 模型说"我现在心情不错"是正向反馈，不是要防的东西。');
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
