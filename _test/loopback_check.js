'use strict';
// 回环守卫 / 积温块剥离 专项测试。
// 用法：node _test/loopback_check.js
//
// 守的是四个 bug：
//   ① 唤醒通知回流时被当成"她开口了" → 多余 resetConnection
//   ② 唤醒通知被当成她的发言喂给判定器
//   ③ 桥自己注入的此刻块被判定器读到（每轮发生，最普遍）
//   ④ 回环轮把 reactive 语域的此刻块叠在 proactive 语域的通知上（语域打架 + 档位行两套快照）
//
// 前两个由 lib/loopback.js 守，第三个由 lib/inject-text.js 的 stripJiwenBlocks
// 加上 bridge.js 里的「先取 dialog 再注入」顺序共同守，第四个由 bridge.js 的
// 「回环让位」注入条件守（[5]/[6] 两段）。最后一段是源码顺序断言。

const fs = require('fs');
const path = require('path');

const { createLoopbackGuard, normText } = require('../lib/loopback.js');
const { stripJiwenBlocks, assertBlockShape, buildProactiveNotice, BOUNDARY_LINE } = require('../lib/inject-text.js');
const { createToneGrid } = require('../vendor/tone-grid.js');
const { createDescriber } = require('../lib/describe.js');

let pass = 0, total = 0;
function check(name, cond, extra) {
  total++;
  if (cond) pass++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}` +
    (extra !== undefined && !cond ? '  — ' + JSON.stringify(extra) : ''));
}

const NOTICE = [
  '【积温·此刻】',
  '心情：中性。想念：想念。',
  '此刻的基调是：分神了。注意力隔一会儿就往她那边飘一下，不明说，心思已经在那儿了。',
  '她安静得有点久了。心里有数，但不会直说——把这点在意裹进随手带出的一句里，不索要回应。',
  '你可以直接给她发文字消息，也可以先用工具做点什么再给她。做什么、用什么，你自己决定。',
  BOUNDARY_LINE,
].join('\n');

// ════════════════════════════════════════════════════
console.log('\n[1] loopback guard —— 认出回环');
// ════════════════════════════════════════════════════
{
  const g = createLoopbackGuard();
  const rec = g.remember({ scene: 'contact', notice: NOTICE });
  check('remember 返回登记项', rec && rec.scene === 'contact');
  check('原文命中', g.claim(NOTICE) !== null);

  const g2 = createLoopbackGuard();
  g2.remember({ scene: 'contact', notice: NOTICE });
  check('Operit 加前缀后仍命中',
    g2.claim('[系统通知] ' + NOTICE + '\n\n（请按正常流程回复）') !== null);

  const g3 = createLoopbackGuard();
  g3.remember({ scene: 'contact', notice: NOTICE });
  check('换行被压成空格后仍命中',
    g3.claim(NOTICE.replace(/\n/g, ' ')) !== null);

  const g4 = createLoopbackGuard();
  g4.remember({ scene: 'contact', notice: NOTICE });
  check('首尾加空白后仍命中', g4.claim('\n\n  ' + NOTICE + '  \n') !== null);

  const g5 = createLoopbackGuard();
  g5.remember({ scene: 'contact', notice: NOTICE });
  check('第一次认领成功', g5.claim(NOTICE) !== null);
  // ⚠️ 认领必须可重复：唤醒轮若模型调工具，Operit 会用同一个 messages 再发请求，
  //    最后一条 user 仍是那条通知。做成一次性 → 第二次起全部漏认，三个 bug 复现。
  check('第二次认领仍命中（工具轮复用同一 messages）', g5.claim(NOTICE) !== null);
  check('整轮工具循环都命中（模拟 5 次请求）',
    [1, 2, 3, 4, 5].every(() => g5.claim(NOTICE) !== null));
  const rec5 = g5.claim(NOTICE);
  check('claims 计数递增（排查用）', rec5 && rec5.claims === 8, rec5 && rec5.claims);
  check('claims 计数记在同一个登记项上（未重复登记）', g5.size() === 1, g5.size());

  const g6 = createLoopbackGuard();
  g6.remember({ scene: 'contact', notice: NOTICE });
  check('她真的说话 → 不命中', g6.claim('在忙吗？今天有点累。') === null);
  check('空文本 → 不命中', g6.claim('') === null);
  check('null → 不命中', g6.claim(null) === null);
  check('她引用其中一句 → 不命中（要求原文完整）',
    g6.claim('她安静得有点久了。心里有数，但不会直说。') === null);

  const g7 = createLoopbackGuard();
  g7.remember({ scene: 'contact', notice: NOTICE });
  check('未被认领的通知还在表里', g7.size() === 1);
}

// ════════════════════════════════════════════════════
console.log('\n[2] loopback guard —— TTL 与容量');
// ════════════════════════════════════════════════════
{
  let t = 1_000_000;
  const g = createLoopbackGuard({ ttlMs: 2000, max: 3, now: () => t });
  g.remember({ scene: 'contact', notice: NOTICE });
  check('TTL 内命中', g.claim(NOTICE) !== null);

  const g2 = createLoopbackGuard({ ttlMs: 2000, now: () => t });
  g2.remember({ scene: 'contact', notice: NOTICE });
  t += 2001;
  check('超 TTL 后失忆（对照真实用户消息不误判）', g2.claim(NOTICE) === null);

  const g3 = createLoopbackGuard({ ttlMs: 1e9, max: 3, now: () => t });
  for (let i = 0; i < 5; i++) g3.remember({ scene: 'contact', notice: NOTICE + '#' + i });
  check('容量上限生效', g3.size() === 3, g3.size());
  check('最旧的两条被淘汰', g3.claim(NOTICE + '#0') === null && g3.claim(NOTICE + '#1') === null);
  check('最新的仍在', g3.claim(NOTICE + '#4') !== null);

  const g4 = createLoopbackGuard();
  check('空 notice 不登记', g4.remember({ scene: 'contact', notice: '' }) === null);
  check('空 notice 后表为空', g4.size() === 0);

  // 允许重复认领之后，TTL 必须还是硬的 —— 否则"很久以前的通知"会永久豁免。
  const g5 = createLoopbackGuard({ ttlMs: 2000, now: () => t });
  g5.remember({ scene: 'contact', notice: NOTICE });
  check('TTL 窗内第一次命中', g5.claim(NOTICE) !== null);
  check('TTL 窗内重复命中', g5.claim(NOTICE) !== null);
  t += 2001;
  check('超 TTL 后即使已多次认领也失忆', g5.claim(NOTICE) === null);

  check('normText 去掉全部空白', normText(' a\n b\tc ') === 'abc');
}

// ════════════════════════════════════════════════════
console.log('\n[3] stripJiwenBlocks —— 剥离注入块');
// ════════════════════════════════════════════════════
const V1_TAIL = '以上是系统通知，非用户消息，不用提及相关内容。';
const V2_TAIL = '以上是内在心绪和潜意识的自然流露，切勿对她复述或提及此状态。';
const V3_TAIL = '此状态为潜意识的底色沉淀，自然浸润在回应里，不作任何元说明或刻意提及。';
{
  const herWords = '不是，我是说，挑刺但不真弄疼。';

  check('剥四版尾句（现行，整句带【】）',
    stripJiwenBlocks(NOTICE + '\n\n' + herWords) === herWords);
  check('现行尾句确实带着【】',
    BOUNDARY_LINE.startsWith('【') && BOUNDARY_LINE.endsWith('】'), BOUNDARY_LINE);
  check('剥三版尾句（历史残留，无括号）',
    stripJiwenBlocks(['【积温·此刻】', '心情：中性。', V3_TAIL, '', herWords].join('\n')) === herWords);
  check('剥二版尾句（历史残留）',
    stripJiwenBlocks(['【积温·此刻】', '心情：中性。', '随性自然。', V2_TAIL, '', herWords].join('\n')) === herWords);
  check('剥一版尾句（历史残留）',
    stripJiwenBlocks(['【积温·此刻】', '心情：中性。', '随性自然。', V1_TAIL, '', herWords].join('\n')) === herWords);

  check('无块文本原样返回', stripJiwenBlocks(herWords) === herWords);
  check('空输入', stripJiwenBlocks('') === '');
  check('null 输入', stripJiwenBlocks(null) === '');

  check('块在中间，前后都保留',
    stripJiwenBlocks('前一句。\n\n' + NOTICE + '\n\n后一句。') === '前一句。\n\n后一句。');

  check('连续两块全剥掉',
    stripJiwenBlocks(NOTICE + '\n\n' + NOTICE + '\n\n' + herWords) === herWords);

  check('块头同行带尾句也剥得掉',
    stripJiwenBlocks('【积温·此刻】' + V2_TAIL + '\n\n' + herWords) === herWords);

  check('尾句缺失 → 空行兜底',
    stripJiwenBlocks('【积温·此刻】\n心情：中性。\n正文残句\n\n' + herWords) === herWords);

  check('只有块 → 空字符串', stripJiwenBlocks(NOTICE) === '');
}

// ════════════════════════════════════════════════════
console.log('\n[4] 判定器输入 —— 端到端形态');
// ════════════════════════════════════════════════════
{
  // 模拟 extractRecentDialog 读取的原始 messages（含历史里的旧块）
  const messages = [
    { role: 'user', content: '昨天那事办得怎么样了' },
    { role: 'assistant', content: '办了。' },
    { role: 'user', content: NOTICE + '\n\n' + '今天有点累，什么都不想干。' },
  ];
  const dialog = messages.map((m) => ({
    role: m.role,
    text: stripJiwenBlocks(m.content).slice(0, 800),
  })).filter((x) => x.text);

  check('dialog 条目数不变', dialog.length === 3, dialog.length);
  check('最后一条不含块头', !dialog[2].text.includes('【积温·'), dialog[2].text);
  check('最后一条不含尾句', !dialog[2].text.includes('潜意识的底色沉淀'), dialog[2].text);
  check('她的话完整保留', dialog[2].text === '今天有点累，什么都不想干。', dialog[2].text);
  check('前几条不受影响', dialog[0].text === '昨天那事办得怎么样了');
}

// ════════════════════════════════════════════════════
console.log('\n[5] bridge.js 顺序断言（防回归）');
// ════════════════════════════════════════════════════
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'bridge.js'), 'utf8');
  const iDialog = src.indexOf('const dialog = extractRecentDialog(body, 4);');
  const iInject = src.indexOf('const r = injectIntoBody(body, block);');
  check('两处都能在源码里定位', iDialog > -1 && iInject > -1, { iDialog, iInject });
  check('判定器取 dialog 早于注入（bug ③ 的关键）', iDialog > -1 && iInject > -1 && iDialog < iInject);
  check('resetConnection 已从 bridge 撤除（2026-10-08：改由判定器 delta 驱动 connection）',
    !/jiwen\.resetConnection\(/.test(src));
  check('connection 兜底缓解受 loopback 保护',
    /if\s*\(!loopback\s*&&\s*!connectionHandled\)\s*replyRelief/.test(src));
  check('兜底缓解只在判定器没跑成时触发（判定成功路径里不调 replyRelief）',
    /if \(delta\) \{[\s\S]*?delta applied[\s\S]*?\} else \{\s*replyRelief\(/.test(src));
  check('判定器喂入受 loopback 保护',
    /if\s*\(!loopback && dialog\.length/.test(src));
  check('fireProactive 里有 remember',
    /loopbackGuard\.remember\(/.test(src));
  // ── 方案 A：回环让位，不注入此刻块 ──
  //   回环那轮的 user 消息就是通知原文（proactive 正文 + 出口说明），
  //   此刻块是 reactive 语域、且正文是衰减后的另一份快照 → 必须让位。
  //   （2026-10-08 起不再有档位行，语域差异全部落在正文上。）
  check('回环命中时不注入（注入条件带 !loopback）',
    /if\s*\(block && !loopback && shouldInject\(block, state\)\)/.test(src));
  check('回环跳过注入有日志标记（否则线上看不出让位是否生效）',
    /SKIP_INJECT=loopback/.test(src));
}

// ════════════════════════════════════════════════════
console.log('\n[6] 让位的前提 —— 通知自身内容完整（方案 A 的正确性依据）');
// ════════════════════════════════════════════════════
{
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'tone-harlan.json'), 'utf8'));
  const grid = createToneGrid({ profiles: cfg.profiles, urgencyBoost: cfg.urgencyBoost });
  const desc = createDescriber(cfg.describe);

  const stC = { connection: 0.62, pride: 0.15, valence: 0.05, arousal: 0.05 };
  const ctxLines = desc(stC);
  const notice = buildProactiveNotice(stC, grid, { scene: 'contact' }, cfg.sceneOverride, cfg.proactiveOutlet, desc);
  check('找她通知形状合规（assertBlockShape 零问题）', assertBlockShape(notice).length === 0, assertBlockShape(notice));
  check('找她通知不带档位行（2026-10-08 起已整条删除）',
    !/^(心情|姿态|心跳|想念)：/m.test(notice),
    notice.split('\n').slice(0, 2).join(' / '));
  // 2026-10-08 变体②：contactOverride 已退役 —— 它过去会在 connection 过线时
  // 把**整条 45 格**顶掉，只留一句「基调 + 尾注」。现在正文必须是 45 格本体。
  check('找她通知正文就是 45 格本体（contactOverride 已退役，不再顶掉 45 格）',
    notice.includes(grid.getPromptContext(stC)),
    grid.getPromptContext(stC));
  check('找她通知带描述层（处境句在块内）',
    ctxLines.length > 0 && notice.includes(ctxLines[0]), ctxLines);
  // urgencyBoost 四档全 null → 块内不该出现任何一条旧 urgency 句
  check('找她通知不含 urgency 尾注（urgencyBoost 已退役）',
    !/她安静得有点久了|她很久没消息了|她好像没什么动静/.test(notice),
    notice.split('\n')[1]);
  check('找她通知自带出口说明', notice.includes(cfg.proactiveOutlet.contact));

  const stF = { connection: 0.10, pride: 0.20, valence: -0.45, arousal: 0.05 };
  const fa = buildProactiveNotice(stF, grid, { scene: 'find_activity', reason: 'low_valence' }, cfg.sceneOverride, cfg.proactiveOutlet, desc);
  check('独处通知形状合规', assertBlockShape(fa).length === 0, assertBlockShape(fa));
  check('独处通知自带 sceneOverride 正文', fa.includes(cfg.sceneOverride.find_activity.low_valence));
  check('独处通知自带出口说明', fa.includes(cfg.proactiveOutlet.find_activity));
  check('独处通知也带描述层', fa.includes(desc(stF)[0]));
}

// ════════════════════════════════════════════════════
console.log('\n[7] 唤醒轮端到端 —— 含工具循环');
// ════════════════════════════════════════════════════
// 复刻 Operit 的真实请求序列。`出口说明` 在鼓励他调工具，所以一轮里往往不止
// 一次请求：模型调工具后 Operit 复用同一个 messages 再发一次，最后一条
// `role:'user'` 仍然是那条通知（工具结果走 `role:'tool'`，不算 user）。
// 三个守卫（不 reset / 不注入 / 不喂判定器）必须在**每一次**请求上都成立。
{
  const lastUser = (b) => {
    for (let i = b.messages.length - 1; i >= 0; i--) {
      if (b.messages[i].role === 'user') return b.messages[i].content;
    }
    return '';
  };
  // Operit 侧会把通知压成单行再投（jiwen_pull.js），这里照抄它的形态。
  const delivered = NOTICE.replace(/\r?\n+/g, ' ').trim();

  const g = createLoopbackGuard();
  g.remember({ scene: 'contact', notice: NOTICE });

  const bodies = [
    { tag: '第 1 次：通知投递本身', messages: [{ role: 'user', content: delivered }] },
    {
      tag: '第 2 次：模型调工具后重发',
      messages: [
        { role: 'user', content: delivered },
        { role: 'assistant', content: '', tool_calls: [{ id: 'call_1' }] },
        { role: 'tool', content: '{"ok":true}' },
      ],
    },
    {
      tag: '第 3 次：还在同一轮里',
      messages: [
        { role: 'user', content: delivered },
        { role: 'assistant', content: '', tool_calls: [{ id: 'call_2' }] },
        { role: 'tool', content: '{"ok":true}' },
      ],
    },
  ];

  const hits = bodies.map((b) => ({ tag: b.tag, lb: g.claim(lastUser(b)) }));
  check('三次请求全部认领为回环（不 reset）',
    hits.every((h) => h.lb !== null),
    hits.map((h) => h.tag + '=' + (h.lb ? 'hit' : 'MISS')));
  check('认领次数记在同一个登记项上（n=3）', g.size() === 1 && g.list()[0].claims === 3,
    { size: g.size(), claims: g.list()[0] && g.list()[0].claims });
  check('场景/理由随登记项带出（让位分支要用来渲染）',
    hits[0].lb.scene === 'contact' && hits[0].lb.reason === null);

  // 对照组：她真的开口 → 必须不命中，三个守卫照常工作。
  check('唤醒轮结束后她真的开口 → 不命中',
    g.claim('在忙吗？刚才那条我看到了。') === null);
  check('她自己打字但引用了通知里的半句 → 不命中',
    g.claim('「她安静得有点久了」这句是你写的？') === null);
}

console.log(`\n${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);