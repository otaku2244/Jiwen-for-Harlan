'use strict';
// 回环守卫 / 积温块剥离 专项测试。
// 用法：node _test/loopback_check.js
//
// 守的是三个 bug：
//   ① 唤醒通知回流时被当成"她开口了" → 多余 resetConnection
//   ② 唤醒通知被当成她的发言喂给判定器
//   ③ 桥自己注入的此刻块被判定器读到（每轮发生，最普遍）
//
// 前两个由 lib/loopback.js 守，第三个由 lib/inject-text.js 的 stripJiwenBlocks
// 加上 bridge.js 里的「先取 dialog 再注入」顺序共同守。最后一段是源码顺序断言。

const fs = require('fs');
const path = require('path');

const { createLoopbackGuard, normText } = require('../lib/loopback.js');
const { stripJiwenBlocks, BOUNDARY_LINE } = require('../lib/inject-text.js');

let pass = 0, total = 0;
function check(name, cond, extra) {
  total++;
  if (cond) pass++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}` +
    (extra !== undefined && !cond ? '  — ' + JSON.stringify(extra) : ''));
}

const NOTICE = [
  '【积温·找她】',
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
  check('第二次认领为 null（一次性）', g5.claim(NOTICE) === null);

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

  check('normText 去掉全部空白', normText(' a\n b\tc ') === 'abc');
}

// ════════════════════════════════════════════════════
console.log('\n[3] stripJiwenBlocks —— 剥离注入块');
// ════════════════════════════════════════════════════
const V1_TAIL = '以上是系统通知，非用户消息，不用提及相关内容。';
const V2_TAIL = '以上是内在心绪和潜意识的自然流露，切勿对她复述或提及此状态。';
{
  const herWords = '不是，我是说，挑刺但不真弄疼。';

  check('剥三版尾句（当前版）',
    stripJiwenBlocks(NOTICE + '\n\n' + herWords) === herWords);
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
  check('resetConnection 受 loopback 保护',
    /if\s*\(!loopback\)\s*\{[\s\S]*?resetConnection/.test(src));
  check('判定器喂入受 loopback 保护',
    /if\s*\(!loopback && dialog\.length/.test(src));
  check('fireProactive 里有 remember',
    /loopbackGuard\.remember\(/.test(src));
}

console.log(`\n${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);
