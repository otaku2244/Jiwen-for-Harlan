'use strict';
// 积温块 × Serein 剥离器 —— 跨仓库契约测试
// 用法：node _test/contract_check.js
//
// ── 为什么单独一个文件 ──────────────────────────────
//
// 积温块与 Serein 之间是一个**隐式契约**，横跨两个仓库：
//
//   桥：拼一块  【积温·X】 …正文… 【尾标记】   → 发出去
//   Serein：见到【积温·X】进跳过态，靠【尾标记】出来
//
// 契约破裂的代价不对称 —— 大得多的一侧在 Serein：
//   末行不对 → 跳过态一直持续到消息结尾 → **她的原话被整段吞掉**。
//   （Serein 侧用例 8 实测，chat_context.py Fork 提交 a5c1bdd）
//
// 而两侧常量形状不同（桥发带【】的整行，Serein 存去【】的内文），最容易被改错。
// 所以这里做两件事：
//   A. 穷举桥能产出的每一个块，断言形状合规；
//   B. 直接读 Serein 源码，断言两侧常量逐字对得上 —— 这是唯一能自动发现
//      "改了一侧忘了另一侧"的地方。

const fs = require('fs');
const path = require('path');

const {
  buildInjectionBlock, buildProactiveNotice, stripJiwenBlocks, assertBlockShape,
  SCENE_TAG, BOUNDARY_LINE, BOUNDARY_INNER, SURF_TAIL_LINE, SURF_BOUNDARY_INNER, BLOCK_TAILS,
} = require('../lib/inject-text.js');
const { createToneGrid } = require('../vendor/tone-grid.js');
const { createToneWrapper } = require('../lib/tone-wrap.js');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'tone-harlan.json'), 'utf8'));
const tg = createToneWrapper(
  createToneGrid({ profiles: cfg.profiles, urgencyBoost: cfg.urgencyBoost }),
  cfg.contactOverride
);

let pass = 0, total = 0, skipped = 0;
function check(name, cond, extra) {
  total++;
  if (cond) pass++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}` +
    (extra !== undefined && !cond ? '  — ' + JSON.stringify(extra) : ''));
}

const CLUSTERS = {
  excited: { v: 0.5, a: 0.5 }, content: { v: 0.5, a: -0.5 }, pleased: { v: 0.5, a: 0.0 },
  agitated: { v: -0.5, a: 0.5 }, depressed: { v: -0.5, a: -0.5 }, sullen: { v: -0.5, a: 0.0 },
  restless: { v: 0.0, a: 0.5 }, calm: { v: 0.0, a: -0.5 }, neutral: { v: 0.0, a: 0.0 },
};
const PRIDE = [0.0, 0.2, 0.4, 0.65, 0.9];
const CONN = [0.05, 0.25, 0.42, 0.62];   // none / aware / urgent / desperate
const STATES = [];
for (const [name, va] of Object.entries(CLUSTERS)) {
  for (const p of PRIDE) {
    for (const c of CONN) {
      STATES.push({ cluster: name, connection: c, pride: p, valence: va.v, arousal: va.a, immersion: 0.1 });
    }
  }
}
const HER_WORDS = '今天有点累，什么都不想说。';

// ════════════════════════════════════════════════════
console.log('\n[1] 尾标记常量形状');
// ════════════════════════════════════════════════════
{
  check('BOUNDARY_LINE 以【开头', BOUNDARY_LINE.startsWith('【'), BOUNDARY_LINE);
  check('BOUNDARY_LINE 以】结尾', BOUNDARY_LINE.endsWith('】'), BOUNDARY_LINE);
  check('BOUNDARY_LINE 是单行（无换行）', !BOUNDARY_LINE.includes('\n'));
  check('BOUNDARY_INNER 不含【】', !/[【】]/.test(BOUNDARY_INNER), BOUNDARY_INNER);
  check('BOUNDARY_LINE === 【 + INNER + 】',
    BOUNDARY_LINE === '【' + BOUNDARY_INNER + '】');
  check('尾标记前后无空白', BOUNDARY_LINE === BOUNDARY_LINE.trim());

  // ── 冲浪产物尾句（2026-10-06 加，END_MARKERS 第二条）──
  check('SURF_TAIL_LINE 以【开头', SURF_TAIL_LINE.startsWith('【'), SURF_TAIL_LINE);
  check('SURF_TAIL_LINE 以】结尾', SURF_TAIL_LINE.endsWith('】'), SURF_TAIL_LINE);
  check('SURF_TAIL_LINE 是单行', !SURF_TAIL_LINE.includes('\n'));
  check('SURF_BOUNDARY_INNER 不含【】', !/[【】]/.test(SURF_BOUNDARY_INNER), SURF_BOUNDARY_INNER);
  check('SURF_TAIL_LINE === 【 + INNER + 】',
    SURF_TAIL_LINE === '【' + SURF_BOUNDARY_INNER + '】');
  check('两条尾标记不相同', SURF_TAIL_LINE !== BOUNDARY_LINE);
  check('BLOCK_TAILS 恰含两条', BLOCK_TAILS.size === 2, [...BLOCK_TAILS]);
}

// ════════════════════════════════════════════════════
console.log('\n[2] 穷举此刻块 + 主动唤醒块，逐条断言形状');
// ════════════════════════════════════════════════════
const allBlocks = [];
{
  for (const st of STATES) allBlocks.push(['此刻/' + st.cluster, buildInjectionBlock(st, tg)]);
  for (const st of STATES) {
    allBlocks.push(['找她/' + st.cluster,
      buildProactiveNotice(st, tg, { scene: 'contact' }, cfg.sceneOverride, cfg.proactiveOutlet)]);
  }
  for (const st of STATES) {
    for (const reason of ['pride_block', 'low_valence', 'high_arousal', 'default']) {
      allBlocks.push(['独处/' + reason + '/' + st.cluster,
        buildProactiveNotice(st, tg, { scene: 'find_activity', reason }, cfg.sceneOverride, cfg.proactiveOutlet)]);
    }
  }

  const bad = [];
  for (const [label, blk] of allBlocks) {
    const problems = assertBlockShape(blk);
    if (problems.length) bad.push(label + ' → ' + problems.join('; '));
  }
  check(`穷举 ${allBlocks.length} 个块，全部形状合规`, bad.length === 0, bad.slice(0, 5));

  // 逐条再核一遍独立条件（不完全依赖 assertBlockShape 自身实现）
  const noTail = allBlocks.filter(([, b]) => !BLOCK_TAILS.has(b.split('\n').pop()));
  check('每块末行 ∈ 合法尾标记集合', noTail.length === 0, noTail.slice(0, 3).map((x) => x[0]));

  // ── 有产物 / 失败兜底：穷举一遍，形状必须同样合规 ──
  const surfBlocks = [];
  for (const st of STATES) {
    surfBlocks.push(['有产物/' + st.cluster, buildProactiveNotice(st, tg, {
      scene: 'find_activity', reason: 'surf',
      finding: { title: '《标题》', url: 'https://example.com/a', image: 'https://example.com/a.jpg', note: '摘要。' },
    }, cfg.sceneOverride, cfg.proactiveOutlet)]);
    surfBlocks.push(['失败兜底/' + st.cluster, buildProactiveNotice(st, tg, {
      scene: 'find_activity', reason: 'surf', failure: '刚才想去翻点东西，没翻成（超时）。',
    }, cfg.sceneOverride, cfg.proactiveOutlet)]);
  }
  const surfBad = surfBlocks.filter(([, b]) => assertBlockShape(b).length);
  check(`穷举 ${surfBlocks.length} 个产物/兜底块，全部形状合规`,
    surfBad.length === 0, surfBad.slice(0, 3).map((x) => [x[0], assertBlockShape(x[1])]));

  const surfTail = surfBlocks.filter(([, b]) => b.split('\n').pop() !== SURF_TAIL_LINE);
  check('产物/兜底块末行都是 SURF_TAIL_LINE', surfTail.length === 0, surfTail.slice(0, 3).map((x) => x[0]));

  // 内层不能有【】行 —— 带了会让 Serein 提前出块、产物整段泄漏
  const innerBracket = surfBlocks.filter(([, b]) =>
    b.split('\n').slice(1, -1).some((l) => /^\s*【[^】]*】/.test(l)));
  check('产物块内无多余【】行（内层标题必须裸行）',
    innerBracket.length === 0, innerBracket.slice(0, 3).map((x) => x[0]));

  // 有产物时不该再出现 proactiveOutlet 的措辞（语义重叠）
  const outletLeak = surfBlocks.filter(([, b]) => b.includes('也可以只是自言自语'));
  check('产物块内不带 proactiveOutlet.find_activity 文案',
    outletLeak.length === 0, outletLeak.slice(0, 2).map((x) => x[0]));

  // 兜底块必须有可读的失败描述，不能是空壳
  const emptyFail = surfBlocks.filter(([label, b]) =>
    label.startsWith('失败兜底') && !b.includes('没翻成'));
  check('失败兜底块带可读说明', emptyFail.length === 0, emptyFail.slice(0, 2).map((x) => x[0]));

  const multiHead = allBlocks.filter(([, b]) => b.split('\n').filter((l) => /^【积温·/.test(l)).length !== 1);
  check('每块恰有一个块头', multiHead.length === 0, multiHead.slice(0, 3).map((x) => x[0]));

  const blank = allBlocks.filter(([, b]) => b.split('\n').some((l) => l.trim() === ''));
  check('块内不含空行（Serein 不把空行当出块信号，含空行会留隐患）',
    blank.length === 0, blank.slice(0, 3).map((x) => x[0]));

  const heads = new Set(allBlocks.map(([, b]) => b.split('\n')[0]));
  check('块头统一为【积温·此刻】（2026-10-07 起不再按场景区分）',
    [...heads].every((h) => /^【积温·此刻】$/.test(h)), [...heads]);
}

// ════════════════════════════════════════════════════
console.log('\n[3] 负向用例 —— 断言必须抓得住破裂');
// ════════════════════════════════════════════════════
{
  const good = buildInjectionBlock(STATES[0], tg);

  const dropTail = good.split('\n').slice(0, -1).join('\n');
  check('末行缺失 → 判为不合规', assertBlockShape(dropTail).length > 0);

  const bareTail = good.split('\n').slice(0, -1).concat(BOUNDARY_INNER).join('\n');
  check('末行丢了【】→ 判为不合规（Serein 的 marker 去括号后仍相同，但形状说明已写错）',
    assertBlockShape(bareTail).length > 0);

  const twoHeads = good.split('\n');
  twoHeads.splice(1, 0, '【积温·此刻】');
  check('块头出现两次 → 判为不合规', assertBlockShape(twoHeads.join('\n')).length > 0);

  check('空串 → 判为不合规', assertBlockShape('').length > 0);
  check('单行 → 判为不合规', assertBlockShape(BOUNDARY_LINE).length > 0);

  // ── 产物块专属负向：内层【】必须被抓，否则 Serein 提前出块、产物泄漏 ──
  const surfGood = buildProactiveNotice(STATES[0], tg, {
    scene: 'find_activity', reason: 'surf',
    finding: { title: '《标题》', url: 'https://example.com/a', image: '', note: '摘要。' },
  }, cfg.sceneOverride, cfg.proactiveOutlet);
  check('产物块本身合规（基线）', assertBlockShape(surfGood).length === 0, assertBlockShape(surfGood));

  const surfInnerBracket = surfGood.split('\n');
  surfInnerBracket.splice(2, 0, '【之前独处冲浪时发现的东西】：');
  check('产物块内层带【】→ 判为不合规',
    assertBlockShape(surfInnerBracket.join('\n')).length > 0);

  const surfNoTail = surfGood.split('\n').slice(0, -1).join('\n');
  check('产物块末行缺失 → 判为不合规', assertBlockShape(surfNoTail).length > 0);

  const surfBareTail = surfGood.split('\n').slice(0, -1).concat(SURF_BOUNDARY_INNER).join('\n');
  check('产物块末行丢了【】→ 判为不合规', assertBlockShape(surfBareTail).length > 0);
}

// ════════════════════════════════════════════════════
console.log('\n[4] 剥离语义 —— 与 Serein 行为对齐');
// ════════════════════════════════════════════════════
{
  // Serein 的规则本地镜像：块进跳过态 → 尾标记出块 → 她的话保留。
  for (const [label, blk] of allBlocks.slice(0, 40)) {
    const ok = stripJiwenBlocks(blk + '\n\n' + HER_WORDS) === HER_WORDS;
    if (!ok) { check('剥离 ' + label, false, stripJiwenBlocks(blk + '\n\n' + HER_WORDS)); break; }
  }
  check('抽 40 个块，剥离后只剩她的话', true);

  // 尾标记后的空行 + 她的话必须都保留（Serein 侧用例 4 的同型）
  const blk = allBlocks[0][1];
  check('尾标记 → 空行 → 她的话：全保留',
    stripJiwenBlocks(blk + '\n\n' + HER_WORDS) === HER_WORDS);
  check('尾标记后紧接她的话（无空行）',
    stripJiwenBlocks(blk + '\n' + HER_WORDS) === HER_WORDS);

  // ── 产物块 / 失败兜底块的剥离（走 Serein 同型逻辑）──
  const surfSample = [
    buildProactiveNotice(STATES[0], tg, {
      scene: 'find_activity', reason: 'surf',
      finding: { title: '《标题》', url: 'https://example.com/a', image: 'https://example.com/a.jpg', note: '摘要。' },
    }, cfg.sceneOverride, cfg.proactiveOutlet),
    buildProactiveNotice(STATES[3], tg, {
      scene: 'find_activity', reason: 'surf', failure: '刚才想去翻点东西，没翻成（超时）。',
    }, cfg.sceneOverride, cfg.proactiveOutlet),
  ];
  let surfStripOk = true;
  for (const b of surfSample) {
    if (stripJiwenBlocks(b + '\n\n' + HER_WORDS) !== HER_WORDS) {
      surfStripOk = false;
      check('剥离产物块', false, stripJiwenBlocks(b + '\n\n' + HER_WORDS));
      break;
    }
  }
  check('产物块 / 失败兜底块：剥离后只剩她的话', surfStripOk);

  // ⚠️ 最隐蔽的一条：BLOCK_TAIL_RE 若不认 SURF_TAIL_LINE，
  //    判定器读实时请求体会把整块当成她的发言 → 自我锚定闭环。
  const surfBlk = surfSample[0];
  const innerBody = surfBlk.split('\n').slice(1, -1).join('\n');
  check('产物块的内层正文会被剥离（尾句已进 BLOCK_TAIL_RE）',
    !stripJiwenBlocks(surfBlk + '\n' + HER_WORDS).includes('之前独处冲浪时发现的东西'),
    stripJiwenBlocks(surfBlk + '\n' + HER_WORDS));
}

// ════════════════════════════════════════════════════
console.log('\n[5] 跨仓库常量一致性（读 Serein 源码）');
// ════════════════════════════════════════════════════
{
  const CANDIDATES = [
    process.env.SEREIN_SRC,
    path.join(__dirname, '..', '..', 'Serein-fork', 'src', 'serein', 'chat_context.py'),
    path.join(__dirname, '..', '..', 'Serein', 'src', 'serein', 'chat_context.py'),
    '/root/Serein/src/serein/chat_context.py',
  ].filter(Boolean);

  const found = CANDIDATES.find((p) => { try { return fs.statSync(p).isFile(); } catch (_) { return false; } });

  if (!found) {
    skipped++;
    console.log('  SKIP  （找不到 Serein 源码，跳过跨仓库校验）');
    console.log('        试过：' + CANDIDATES.join('  |  '));
    console.log('        可设环境变量 SEREIN_SRC 指向 src/serein/chat_context.py');
  } else {
    console.log('  源：' + found);
    const src = fs.readFileSync(found, 'utf8');

    const pickSet = (name) => {
      const m = src.match(new RegExp(name + '\\s*=\\s*\\{([\\s\\S]*?)\\n\\}'));
      if (!m) return null;
      return new Set([...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]));
    };

    const titles = pickSet('EXTERNAL_CONTEXT_BLOCK_TITLES');
    const markers = pickSet('EXTERNAL_CONTEXT_BLOCK_END_MARKERS');

    check('解析出 EXTERNAL_CONTEXT_BLOCK_TITLES', !!titles, found);
    check('解析出 EXTERNAL_CONTEXT_BLOCK_END_MARKERS', !!markers, found);

    if (titles && markers) {
      // ① 尾标记：Serein 存的是去【】的内文
      check('Serein 的 END_MARKERS 含尾标记内文（逐字一致）',
        markers.has(BOUNDARY_INNER),
        { 桥侧内文: BOUNDARY_INNER, Serein侧: [...markers] });

      // ①b 冲浪产物尾句也必须在（END_MARKERS 是集合，两条各管一种块）
      check('Serein 的 END_MARKERS 含冲浪产物尾句内文（逐字一致）',
        markers.has(SURF_BOUNDARY_INNER),
        { 桥侧内文: SURF_BOUNDARY_INNER, Serein侧: [...markers] });

      // ①c 反向：桥侧声明的每条尾句，Serein 都必须认得（漏一条 = 那种块整段泄漏）
      const tailInners = [...BLOCK_TAILS].map((l) => l.replace(/^【|】$/g, ''));
      const missingTails = tailInners.filter((t) => !markers.has(t));
      check('桥侧所有尾标记都在 Serein 的 END_MARKERS 里', missingTails.length === 0,
        { 缺失: missingTails });

      // ② 桥能产出的每个块头，都必须在 Serein 的白名单里
      const needTitles = Object.values(SCENE_TAG).map((t) => '积温·' + t);
      const missing = needTitles.filter((t) => !titles.has(t));
      check('桥的所有场景块头都在 Serein 白名单内（' + needTitles.join(' / ') + '）',
        missing.length === 0, missing);

      // ③ 反向：白名单里的积温标题必须**恰好等于**桥的产出集合（不多不少）。
      //    ⚠️ 2026-10-07 起桥只产 `积温·此刻`，白名单也只留它一条。
      //       历史块头 `积温·找她` / `积温·独处` **已删且不得补回**：
      //       旧块的尾句是无【】的裸行，进跳过态后永远出不来 →
      //       补进白名单会让跳过态吃到结尾，把**她紧随的原话整段吞掉**（归档成 ''）。
      //       不进白名单只是不剥离（旧块留在归档里），不毁正文。两害相权取其轻。
      const extra = [...titles].filter((t) => t.startsWith('积温·') && !needTitles.includes(t));
      check('Serein 白名单里的积温标题恰好等于桥的产出集合（多一条就得评估是否吞正文）',
        extra.length === 0, { 白名单多出: extra, 桥产出: needTitles });
    }

    // ④ Serein 的实现细节仍在：END_MARKERS 分支必须在 `if title:` 之后、进跳过态之前
    const body = src.slice(src.indexOf('def _strip_external_context_blocks'));
    const iMarker = body.indexOf('title in EXTERNAL_CONTEXT_BLOCK_END_MARKERS');
    const iEnter = body.indexOf('skipping = title in EXTERNAL_CONTEXT_BLOCK_TITLES');
    check('Serein 的 END_MARKERS 分支仍在进跳过态之前', iMarker > -1 && iEnter > -1 && iMarker < iEnter,
      { iMarker, iEnter });
  }
}

console.log(`\n${pass}/${total} passed${skipped ? '（1 段跳过）' : ''}`);
process.exit(pass === total ? 0 : 1);
