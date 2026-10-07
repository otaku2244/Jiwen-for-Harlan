'use strict';
// 积温状态 → 注入文本
//
// 两种投递形态：
//   1. buildInjectionBlock —— 用户开口时的「此刻块」（reactive），拼在最后一条 user 消息前
//   2. buildProactiveNotice —— 阈值触发时的主动唤醒块（proactive），作为一条 user 消息注入对话
//
// 定位说明（重要）：
//   这两块是**喂给模型的系统侧材料**，属于幕后输入，不是 Harlan 在说话。
//   因此这里的文案要求是：清晰、准确、无歧义——让模型正确理解当前状态。
//   人设里的"语言保留瑕疵/允许半截话"约束，对象是 Harlan 与椰椰子的对话正文，
//   由 tone-harlan.json 的行为指令去驱动，与本节无关。
//
// 设计约束：
//   · 不给数字、不给维度英文名（valence/arousal/pride/connection）—— 给了数模型会开始报数
//     但**簇名要给**（excited/pleased/…）：它是当前状态的坐标，不是维度，模型靠它定位
//   · 不得出现可被"报备"进对话的环境描述、不得伪造实体在场
//   · 不出现索取回应的句式
//   · 桥不碰"活动"，只发状态 + 边界句；活动由 Operit 工作流侧自理
//   · 边界句三场景统一，只声明"这是内在心绪，不宜元说明"，不声明"以下是她的消息"
//
// 头尾措辞变更（2026-10-05 / 10-06）：
//   旧头：【积温·此刻｜参考不是指令】   旧尾：以上是系统通知，非用户消息，不用提及相关内容。
//   二版头：【积温·此刻】              二版尾：以上是内在心绪和潜意识的自然流露，切勿对她复述或提及此状态。
//   三版头：【积温·此刻】              三版尾：此状态为潜意识的底色沉淀，自然浸润在回应里，不作任何元说明或刻意提及。
//   四版头：【积温·此刻】              四版尾：【此状态为潜意识的底色沉淀，自然浸润在回应里，不作任何元说明或刻意提及。】
//   原因：① 去掉"参考不是指令""系统通知"这类工单味的元话语；
//         ② 尾句只管"别复述"，刻意**不写**"以下是她的消息"——
//            因为用户消息后面可能紧跟文件传输的文本/地址，写"以下是她的消息"会把文件信息
//            误纳入"她的话"语义，产生错位；
//         ③ 三版比二版多一层正向指引（"自然浸润在回应里"= 该以什么方式在场）。
//            但三版与二版真正的差别在**禁止对象**：二版禁"复述此状态"，三版禁"元说明"。
//            ⚠️ 这个区别别改回去：模型说"我现在心情不错"是**正向反馈**（状态融进了表达），
//            不是要防的东西；要防的是**脚手架暴露**——"系统又告诉我…""根据我的设定…"
//            "参数显示…"这类。二版的"复述此状态"会把合法的状态自述一起误伤。
//            改措辞时以"模型能不能直接照做"为准，文采次之。
//            ⚠️ 也不要在提示词里列举反例（如"别说'系统提示'"）——那等于把那些词
//            直接摆到模型眼前，对 Flash 级模型反而是一种 priming。
//         ④ 四版给整句套上【】：块头是【积温·X】，块尾也落在【】上，
//            视觉上夹成一个完整段——既帮模型分清"哪句是系统侧材料"，
//            也免得尾句被当成她的话的开头（见 stripJiwenBlocks 的剥离逻辑）。
//   中间档位行（意义行）2026-10-08 已整条删除 —— 见下方「档位行删除」小节。
//
// ════════════════════════════════════════════════════════════════
// 档位行删除（2026-10-08 用户拍板）
// ════════════════════════════════════════════════════════════════
//
// 删掉的是这一行：`心情：X。姿态：X。心跳：X。想念：X。`（旧 `meaningfulLines()`）。
// 连带删掉 `labelValence / labelPride / labelArousal / labelConnection` 与 CONSIDER_LINE。
//
// 为什么删：它与紧随其后的 45 格正文**同义重复**——四条各自对应 45 格的某一维，
//   说的是同一件事、只是粒度更粗：
//     · `心情：` ← 45 格的簇（V×A）
//     · `姿态：` ← 45 格的 pride 档
//     · `心跳：` ← 簇内的 arousal
//     · `想念：` ← urgency 尾注（**同轴同阈值**，且会重字成「想念：想念。」）
//   其中 `悠闲` 是**死档**：进 `想念：` 行的条件是 `c >= 0.20`，而「悠闲」的区间是 `c < 0.20`，
//   两支 if 的动作又完全相同（`inject-text.js:131-132` 旧写法）—— 条件永不可达。
//   此刻块也永远不会出现 `想念：` 行 —— 档位行已整条删除，
//   它对应的那点信息由描述层段1 承担，而段1 只出在主动唤醒侧。
//
// 删除后的责任划分（别再补回来）：
//   · 「什么语气说话」→ 45 格（`config/tone-harlan.json` 的 profiles）
//   · 「我此刻在什么处境」→ 描述层（四段，`lib/describe.js` + config 的 `describe` 段）
//   · 档位行处在两者之间，两头都不占：粒度比 45 格粗、又比描述层琐碎。
// 历史分析留档：`_test/state_lines_probe.txt` / `_test/compare_state_lines.txt`。
//
// ════════════════════════════════════════════════════════════════
// 描述层上线（2026-10-08 用户拍板，变体②）
// ════════════════════════════════════════════════════════════════
//
// 与删档位行同一轮做的两件事：
//   ① 补 `lib/describe.js` —— 四段处境陈述，拼在块头之后、45 格之前。
//   ② 退役 `contactOverride` 与 `urgencyBoost`（config 侧）——
//      它们是在「描述层缺位」这块空白上打的补丁，且打歪了：
//      `lib/tone-wrap.js` 的 wrap() 在 connection 过线时**把整条 45 格顶掉**，
//      只留一行 urgency 尾注 → 「找她」块里最该体现语气的 45 格一个字都出不来，
//      只剩「基调句 + 尾注」两句同义反复。`tone-wrap.js` 已随之删除。
//
// 现在的块结构（三场景同构，差别只在正文来源）：
//
//   【积温·此刻】
//   {描述层 1~4 行}          ← lib/describe.js：处境（陈述句、零祈使）
//   {45 格 / sceneOverride / 冲浪产物}   ← 行为指令
//   {出口说明：仅主动唤醒}
//   【尾标记】
//
// ⚠️ 描述层是**裸行**，绝不能带【】 —— 块内除块头外任何【】行都会让 Serein
//    提前关掉跳过态（见下面 SURF_BOUNDARY_INNER 的注释）。

// ════════════════════════════════════════════════════════════════
// ⚠️ 跨系统契约常量 —— 改这里必须同步 Serein
// ════════════════════════════════════════════════════════════════
//
// 这行尾标记同时是 Serein 侧 `EXTERNAL_CONTEXT_BLOCK_END_MARKERS` 的匹配目标
// （`src/serein/chat_context.py`，fork 提交 `a5c1bdd`）。
//
// Serein 靠它把"积温块"关掉：见到 `【积温·X】` 就进跳过态，
// 之后**只有**「下一个行首【】标题行」或「这行尾标记」能出来——空行不算。
//
// ⚠️ 破裂的代价（Serein 侧用例 8 实测）：块头发出、尾标记不匹配 →
//    跳过态一直持续到消息结尾 → **紧接着的她的原话被整段吞掉**（返回 ''）。
//
// 形状差异（别记混）：
//   桥侧发出     【此状态为潜意识的底色沉淀，自然浸润在回应里，不作任何元说明或刻意提及。】
//   Serein 存   此状态为潜意识的底色沉淀，自然浸润在回应里，不作任何元说明或刻意提及。
//               （它先按行剥掉【】取标题，再拿内文去比对）
//
// 所以这里只用**内文**作为单一来源，括号由下面那行拼出来 ——
// 想写错括号都写不出来。要改措辞只改 BOUNDARY_INNER，然后通知 Serein 侧同步。
const BOUNDARY_INNER = '此状态为潜意识的底色沉淀，自然浸润在回应里，不作任何元说明或刻意提及。';
const BOUNDARY_LINE = '【' + String(BOUNDARY_INNER).replace(/^【|】$/g, '') + '】';

// ── 冲浪产物尾句（第二条块尾标记）────────────────────────────────────────
// 「独处 + 有产物」的块用它收尾，替掉 proactiveOutlet.find_activity。
//
// ⚠️ 与 Serein 的 `EXTERNAL_CONTEXT_BLOCK_END_MARKERS`（`chat_context.py`）逐字一致。
//    那边是**集合**，两种块各用各的收尾行，不是二选一 —— 登两条不会互相干扰。
//    新增/改措辞改这里，然后同步 Serein。
//
// ⚠️ 块内除了块头，**不允许再出现任何【】行**。Serein 见到行首【X】会重算
//    `skipping = (X in TITLES)`，内层多一个【】就提前出块，产物（标题/网址/原图/摘要）
//    会整段泄漏进归档与检索 query。所以产物正文必须是裸行（`_test/probe_surf_draft.py`
//    有 A原样 ❌ / A去括号 ✅ 的对照）。
const SURF_BOUNDARY_INNER = '以上为你独处时的真实切片，你可以留下你的独自思考、也可以把内容直接呈现给她，如何行动由你决定。';
const SURF_TAIL_LINE = '【' + String(SURF_BOUNDARY_INNER).replace(/^【|】$/g, '') + '】';

// 所有合法的块尾标记。assertBlockShape 用它判"末行是不是收尾行"。
const BLOCK_TAILS = new Set([BOUNDARY_LINE, SURF_TAIL_LINE]);

/**
 * 通用骨架：场景标签 + 描述层 + 场景正文 + 边界句。
 *
 * ⚠️ 2026-10-08 起**不再有档位行**（`心情/姿态/心跳/想念` 那条）。原因见文件头。
 *    所以块内只剩三种行：块头 / 正文（描述层 + 指令，都可能多行） / 尾标记。
 * @param {string} sceneTag 【积温·XX】里的 XX（2026-10-07 起三场景统一为「此刻」）
 * @param {string[]} contextLines 描述层行（`lib/describe.js` 的产物）；空数组 = 不出
 * @param {string} body 已按场景取好的正文（语调网格指令 / 场景覆盖尾注 / 冲浪产物）
 * @param {string} [tail] 尾标记。默认 BOUNDARY_LINE；有产物的块传 SURF_TAIL_LINE。
 */
function composeBlock(sceneTag, contextLines, body, tail) {
  const parts = [];
  parts.push(`【积温·${sceneTag}】`);
  if (contextLines && contextLines.length) parts.push(contextLines.join('\n'));
  if (body) parts.push(body);
  // 尾标记**无条件**拼在最后。这是与 Serein 的切割线，任何调用方都不需要记得加。
  parts.push(tail || BOUNDARY_LINE);
  return parts.join('\n');
}

// 描述层是可选依赖：拿不到（老配置 / 调用方没传）就不拼，块照常成立。
function safeDescribe(describer, state, opts) {
  if (typeof describer !== 'function') return [];
  try {
    const lines = describer(state, opts);
    return Array.isArray(lines) ? lines : [];
  } catch (_) { return []; }
}

/**
 * 块形状自断言（返回问题列表，空数组 = 合规）。
 *
 * 为什么需要：积温块与 Serein 之间是一个**隐式契约** ——
 * 块头让 Serein 进跳过态，只有尾标记能让它出来。任何"块头发了、尾标记不对"的
 * 情况都会让她的原话被整段吞掉。这个契约跨越两个仓库，只能靠断言守。
 *
 * 三条检查：
 *   ① 首行是【积温·X】单行；
 *   ② 末行 ∈ BLOCK_TAILS（带【】的合法收尾行，不只有 BOUNDARY_LINE）；
 *   ③ 块头只出现一次（正文里若混入另一个块头，Serein 的跳过态会错位）。
 *
 * ④ 顺带挡掉块内**多余的【】行**：除首行外任何以【开头、且不在 BLOCK_TAILS 里的行，
 *   都会让 Serein 重算 skipping（内层标题若不在 TITLES 白名单，跳过态提前关闭 →
 *    产物整段泄漏）。这条是 2026-10-06 加的：文案草稿里内层小标题带了【】，
 *    实测泄漏。宁可拒发也不要让她的话被污染。
 */
function assertBlockShape(block) {
  const problems = [];
  const lines = String(block == null ? '' : block).split('\n');
  if (lines.length < 2) return ['块为空或只有一行'];
  if (!/^【积温·[^】]+】$/.test(lines[0])) problems.push('首行不是【积温·X】单行：' + lines[0]);
  if (!BLOCK_TAILS.has(lines[lines.length - 1])) problems.push('末行不是合法尾标记：' + lines[lines.length - 1]);
  if (lines.filter((l) => /^【积温·/.test(l)).length !== 1) problems.push('块头出现次数不为 1');
  // 内层残留【】行（首行、末行之外）→ 会让 Serein 提前出块。
  const innerBrackets = lines.slice(1, -1).filter((l) => /^\s*【[^】]*】/.test(l));
  if (innerBrackets.length) {
    problems.push('块内出现多余【】行（会提前关闭 Serein 的跳过态、泄漏产物）：' + innerBrackets.join(' / '));
  }
  return problems;
}

/**
 * 生成「此刻块」。拼在最后一条 user 消息前面。
 * @param {object} state 积温状态
 * @param {object} toneGrid 语调网格实例（用 getStyleGuidance 取风格指令）
 * @param {function} [describer] `lib/describe.js` 的 describeState；缺省则无描述层
 */
function buildInjectionBlock(state, toneGrid, describer) {
  let style = '';
  try {
    style = toneGrid ? toneGrid.getStyleGuidance(state) : '';
  } catch (_) { style = ''; }
  // 段1 全是时间维度的问句（「她很久没动静了。」），而此刻块是"她刚说完这一句"的场景
  // → 一句都不成立，只留给主动唤醒侧。理由见 lib/describe.js 的 describeState 注释。
  const ctx = safeDescribe(describer, state, { withConnection: false });
  return composeBlock(SCENE_TAG.reactive, ctx, style);
}

/**
 * 生成主动唤醒块。由 Operit 工作流作为一条 user 消息注入对话。
 *
 * 场景 → 正文来源：
 *   contact（找她）      → toneGrid.getPromptContext（**纯 45 格**：urgencyBoost 已退役）
 *   find_activity（独处）→ sceneOverride.find_activity[reason]，语义是「她不在，这是你自己的时间」
 *                          reason: pride_block / low_valence / high_arousal
 *
 * 两个场景都追加一句「出口说明」（proactiveOutlet，见 tone-harlan.json）：
 * 告诉他这件事可以怎么做（发消息 / 用工具 / 自言自语），插在正文之后、边界句之前。
 * 只在主动唤醒里加 —— 此刻块他已经在回话了，不需要出口指引。
 *
 * ── 描述层（2026-10-08 加）───────────────────────────────────────────
 * 三个分支都在正文之前拼 1~4 行处境陈述（`lib/describe.js`）。
 * 主动唤醒侧 connection 有意义（它就是被「惦记」推起来的）→ 段1 照常出。
 *
 * ── 有产物分支（opts.finding，2026-10-06 加）─────────────────────────────
 * 独处冲浪跑出了东西时，正文换成「产物切片 + SURF_TAIL_LINE」：
 *   · proactiveOutlet.find_activity 停用 —— 与新尾句语义重叠（都说"你可以…由你决定"）。
 *   · sceneOverride.find_activity 的 reason 正文也去掉：此刻要交代的是"摸到了什么"，
 *     不是"该去做什么"，两者并列模型会当双重指令。
 *   · 尾标记换成 SURF_TAIL_LINE，Serein 侧已登记（集合第二条）。
 *   · 描述层保留：它说的是"我此刻在什么处境"，与产物（"我摸到了什么"）不冲突。
 *
 * @param {object} state
 * @param {object} toneGrid
 * @param {object} [opts] { scene, reason, finding: {title,url,image,note} | null, failure: string }
 * @param {object} [sceneOverride] tone-harlan.json 的 sceneOverride 段
 * @param {object} [proactiveOutlet] tone-harlan.json 的 proactiveOutlet 段
 * @param {function} [describer] `lib/describe.js` 的 describeState；缺省则无描述层
 */
// 场景 → 块头标签。
//
// ⚠️ 2026-10-07 起**统一为「此刻」，不再按场景区分**。
//    理由：块头不是在给"哪一种通知"编号，它是在告诉模型"这是你此刻的状态"。
//    三个场景的块，性质完全一样（系统侧的此刻状态材料），差别只该由**正文**承担。
//    分场景写块头会把"通知类型"这个实现细节暴露给模型，也让它一眼分心去猜"我为什么收到这个"。
//    场景的区分依旧存在，只是挪到了别处：
//      · 内容  —— 找她块正文走 `getPromptContext`；独处块走 `sceneOverride`；有产物走 `buildFindingBody`
//      · 落点  —— 由 Operit 工作流按 MCP 返回的 `SCENE=`/`TARGET=` 决定投哪个窗口
//                （`jiwen_pull.js` 的 `TARGET_OF_SCENE`，与块头无关）
//
// ⚠️ key 全部保留，`SCENE_TAG[scene]` 的调用方式不变 —— 只是三个值现在相同。
//    这样将来若要重新分场景，改值即可，不用动调用方。
//
// ⚠️ Serein 侧 `EXTERNAL_CONTEXT_BLOCK_TITLES` 里只留 `积温·此刻` **一条**
//    （历史块头 `积温·找她` / `积温·独处` 已一并删除，**不要补回来**）。
//
//    为什么历史块头宁可不剥离也不能补进白名单：
//      Serein 的剥离函数只处理"进了跳过态"的行，而**出跳过态只认下一个白名单标题行
//      或尾标记行**。一/二版历史块的尾句是**裸行**（不带【】），永远结束不了跳过态 →
//      一旦把旧块头补进白名单，跳过态会一路吃到文本结尾，
//      把**她紧随其后的原话整段吞掉**（归档与检索里只留一个空 ''）。
//      不进白名单则只是"不剥离"：旧块内容留在归档里，但不会毁掉任何正文。
//      两害相权取其轻 —— 漏块本身 < 吞她的话。
//
//    契约核对见 `_test/contract_check.js`：断言白名单里的积温标题**恰好等于**桥的产出集合。
const SCENE_TAG = {
  reactive: '此刻',
  contact: '此刻',
  find_activity: '此刻',
};

// 产物小标题。裸行，**不能带【】** —— 带了会被 Serein 当成块标题重算跳过态，
// 后面的标题/网址/原图/摘要会整段泄漏进归档（`_test/probe_surf_draft.py` 有对照）。
const FINDING_HEAD = '之前独处冲浪时发现的东西：';

// 单行清洗：压平换行、剥掉【】。产物来自外部抓取，标题里可能带任意字符。
function cleanLine(value) {
  return String(value == null ? '' : value)
    .replace(/[\r\n]+/g, ' ')
    .replace(/【/g, '')
    .replace(/】/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 拼「有产物」正文：小标题 + 标题 + 网址 + 原图（有才带） + 脱水摘要。
 * 失败时（opts.failure）只给一句兜底，不留空壳。
 */
function buildFindingBody(opts) {
  const o = opts || {};
  const f = o.finding;
  if (!f) {
    const fallback = cleanLine(o.failure) || '刚才想去翻点东西，没翻成。';
    return fallback;
  }
  const lines = [FINDING_HEAD];
  const title = cleanLine(f.title);
  if (title) lines.push(title);
  const url = cleanLine(f.url);
  if (url) lines.push(url);
  const image = cleanLine(f.image);
  if (image) lines.push(image);
  const note = cleanLine(f.note);
  if (note) lines.push(note);
  return lines.join('\n');
}

function buildProactiveNotice(state, toneGrid, opts, sceneOverride, proactiveOutlet, describer) {
  const o = opts || {};
  const scene = o.scene || 'contact';
  // ⚠️ fallback 必须是「此刻」而不是别的词：块头一旦落进 Serein 白名单之外，
  //    它整块（含她紧随的原话）都会被吞进归档。SCENE_TAG 已三值相同，这里再兜一层。
  const tag = SCENE_TAG[scene] || '此刻';
  const ctx = safeDescribe(describer, state, { withConnection: scene !== 'reactive' });

  // ── 有产物：独立正文 + 独立尾标记，不走 outlet ──
  if (o.finding || o.failure) {
    return composeBlock(tag, ctx, buildFindingBody(o), SURF_TAIL_LINE);
  }

  let body = '';
  if (scene === 'contact') {
    try {
      body = toneGrid ? toneGrid.getPromptContext(state) : '';
    } catch (_) { body = ''; }
  } else {
    const tbl = (sceneOverride && sceneOverride[scene]) || {};
    body = tbl[o.reason] || tbl.default || '';
  }

  // 出口说明：接在正文后面。正文为空时它就是正文。
  // 没有它（老配置 / 旧调用）时行为不变。
  const outlet = (proactiveOutlet && proactiveOutlet[scene]) || '';
  if (outlet) body = body ? body + '\n' + outlet : outlet;

  return composeBlock(tag, ctx, body);
}

// ── 剥离积温块 ────────────────────────────────────
//
// 为什么要剥：积温块是拼进 user 消息正文的，会随请求体一路流转，
// 也可能被上游记忆库当"她说的话"存进历史再随下一轮回流。
// 任何"读对话内容"的地方（判定器、检索、续接材料）都必须先剔掉它，
// 否则积温会读到自己上一轮的输出，变成一个自我锚定的闭环。
//
// 形态：【积温·XXX】 + 档位行 + 正文 + 尾句，整体占若干行。
// 遍历按行：遇到块头进块，遇到尾句或空行出块，块内行全部丢弃。
//
// 尾句三版都认（历史里可能残留旧版块）：
//   三版 此状态为潜意识的底色沉淀，…
//   二版 以上是内在心绪和潜意识的自然流露，…
//   一版 以上是系统通知，非用户消息，…
const BLOCK_HEAD_RE = /^\s*【积温·[^】]*】\s*(.*)$/;
// 尾句要同时认「带方括号」与「不带方括号」两种写法：
// 四版起尾句整句用【】包住（与块头呼应，让模型一眼看出这是有头有尾的独立段），
// 但 raw_events 里残留着一、二、三版的无括号块，剥离逻辑必须照样认得。
//
// ⚠️ 冲浪产物尾句（SURF_BOUNDARY_INNER）必须在列。它不在这里时，通知回流后
//    判定器读实时请求体会把整块当成她的发言 —— 自我锚定闭环。这条 assertBlockShape
//    拦不住（形状是合规的），只能靠这里守。
const BLOCK_TAIL_INNERS = [
  '此状态为潜意识的底色沉淀',
  '以上是内在心绪和潜意识的自然流露',
  '以上是系统通知',
  '以上为你独处时的真实切片',
];
const BLOCK_TAIL_RE = new RegExp('^\\s*【?\\s*(' + BLOCK_TAIL_INNERS.join('|') + ')');

function stripJiwenBlocks(text) {
  if (!text) return '';
  const out = [];
  let inBlock = false;
  for (const line of String(text).split('\n')) {
    if (!inBlock) {
      const m = line.match(BLOCK_HEAD_RE);
      if (m) {
        // 块头同行若已带尾句，视作一行块，直接丢弃
        inBlock = !BLOCK_TAIL_RE.test(m[1] || '');
        continue;
      }
      out.push(line);
      continue;
    }
    // 块内
    if (BLOCK_TAIL_RE.test(line)) { inBlock = false; continue; }
    if (line.trim() === '') { inBlock = false; out.push(line); continue; }
    // 其余块内正文丢弃
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

module.exports = {
  buildInjectionBlock,
  buildProactiveNotice,
  buildFindingBody,
  stripJiwenBlocks,
  assertBlockShape,
  SCENE_TAG,
  BOUNDARY_LINE,
  BOUNDARY_INNER,
  SURF_TAIL_LINE,
  SURF_BOUNDARY_INNER,
  BLOCK_TAILS,
  FINDING_HEAD,
};
