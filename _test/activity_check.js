'use strict';
// 活动登记专项：描述层段4（「手上在做什么」）的真来源是否接通。
// 用法：node _test/activity_check.js
//
// 背景：段4 读 `immersion` + `lastActivity`。桥此前从不调 setActivity
//       → immersion 恒 0 → 段4 恒定输出「没在做什么特别的事。」（白占一行）。
//       2026-10-08 起把冲浪接了上去：spawn 成功 / 产物回投时各登记一次。
//
// 本机沙箱里 spawn 出来的子进程不一定能起（EBUSY），所以这里分两层：
//   A 单元层 —— recordActivity 的调用契约（用假 jiwen，不需要真进程）
//   B 渲染层 —— 段4 三分支 + 死带，直接喂 state 给 describeState
//   C 接线层 —— 静态断言 bridge.js 的登记点挂对了地方（不靠跑进程）

const fs = require('fs');
const path = require('path');
const { createDescriber, IMMERSION_BUSY, IMMERSION_IDLE } = require('../lib/describe.js');
const { recordActivity } = require('../lib/activity.js');
const { createToneGrid } = require('../vendor/tone-grid.js');
const { buildProactiveNotice, FINDING_HEAD } = require('../lib/inject-text.js');

const cfg = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'config', 'tone-harlan.json'), 'utf8'));
const toneGrid = createToneGrid({ profiles: cfg.profiles, urgencyBoost: cfg.urgencyBoost });
const desc = createDescriber(cfg.describe);

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (detail ? '  — ' + detail : ''));
}

const SURF = { type: 'search', label: '上网冲浪' };
// 与 bridge.js CFG 的默认值同步（改一边记得改另一边）
const SURF_TYPE_DEFAULT = 'search';
const SURF_LABEL_DEFAULT = '上网冲浪';

(async () => {
  // ══════════ A. recordActivity 的调用契约 ══════════
  console.log('A. recordActivity 调用契约\n');

  const calls = [];
  const fakeJiwen = {
    setActivity: async (type, label) => { calls.push({ type, label }); },
  };

  const okCall = await recordActivity(fakeJiwen, SURF, () => {});
  check('正常调用 → true，且 type/label 原样传给引擎',
    okCall === true && calls.length === 1 && calls[0].type === SURF_TYPE_DEFAULT && calls[0].label === SURF_LABEL_DEFAULT,
    JSON.stringify(calls[0]));

  calls.length = 0;
  const noLabel = await recordActivity(fakeJiwen, { type: 'search' }, () => {});
  check('缺 label → 跳过（不记空活动，免得 immersion 抬起来却什么都不说）',
    noLabel === false && calls.length === 0);

  const noType = await recordActivity(fakeJiwen, { label: '上网冲浪' }, () => {});
  check('缺 type → 跳过（引擎查不到 immersionMap，会落到兜底 0.2 死带）',
    noType === false && calls.length === 0);

  const noEngine = await recordActivity(null, SURF, () => {});
  check('引擎实例缺失 → 跳过且不抛', noEngine === false);

  const badEngine = { setActivity: async () => { throw new Error('boom'); } };
  const thrown = await recordActivity(badEngine, SURF, () => {});
  check('引擎报错 → 返回 false，不往上抛（积温是辅助材料，不该拖垮主流程）', thrown === false);

  // ══════════ B. 段4 的四个位置 ══════════
  console.log('\nB. 段4 渲染\n');

  const at = new Date().toISOString();
  const DOING = cfg.describe.immersion.doing.replace('{label}', SURF_LABEL_DEFAULT);
  const IDLE = cfg.describe.immersion.idle;
  // ⚠️ 不能取 lines 的末行当段4 —— 段4 不出时末行会落到段2（pride）。
  //    这里只认「这两句里出现过哪一句」，没出现就是空。
  const line4 = (st) => {
    const lines = desc(st, { withConnection: false });
    return lines.find((l) => l === DOING || l === IDLE) || '';
  };

  const busy = line4({ connection: 0, pride: 0, valence: 0, arousal: 0, immersion: 0.4, lastActivity: { ...SURF, at } });
  check(`immersion > ${IMMERSION_BUSY} 且有活动 → 「刚才在上网冲浪。」`,
    busy === DOING, busy);

  const mid = line4({ connection: 0, pride: 0, valence: 0, arousal: 0, immersion: 0.2, lastActivity: { ...SURF, at } });
  check('immersion 落在 0.1~0.3 死带 → 不出段4（既不说在忙、也不说空着）', mid === '', `"${mid}"`);

  const idle = line4({ connection: 0, pride: 0, valence: 0, arousal: 0, immersion: 0.05, lastActivity: null });
  check(`immersion < ${IMMERSION_IDLE} → 「没在做什么特别的事。」`,
    idle === IDLE, idle);

  const noFake = line4({ connection: 0, pride: 0, valence: 0, arousal: 0, immersion: 0.4, lastActivity: null });
  check('immersion 高但 lastActivity 为空 → 不出（不编造活动）', noFake === '', `"${noFake}"`);

  const noLabelFake = line4({ connection: 0, pride: 0, valence: 0, arousal: 0, immersion: 0.4, lastActivity: { type: 'search', at } });
  check('有 lastActivity 但没 label → 不出（label 才进文本，type 不进）', noLabelFake === '', `"${noLabelFake}"`);

  // ══════════ C. 块里真的出现 ══════════
  console.log('\nC. 整块渲染\n');

  const stBusy = { connection: 0.42, pride: 0.20, valence: 0, arousal: 0, immersion: 0.4, lastActivity: { ...SURF, at } };
  const blk = buildProactiveNotice(stBusy, toneGrid, { scene: 'contact' }, cfg.sceneOverride, cfg.proactiveOutlet, desc);
  const blkLines = blk.split('\n');
  check('找她块里出现段4 的 doing 句（不再是恒定 idle）',
    blk.includes(cfg.describe.immersion.doing.replace('{label}', SURF_LABEL_DEFAULT)),
    blkLines.slice(1, 5).join(' / '));
  check('同块里没有把英文 type 写进文本（不该出现 "search"）', !blk.includes('search'));
  check('块结构未被破坏（首行块头、末行合法尾标记）', blkLines[0] === '【积温·此刻】' && /^【.+】$/.test(blkLines[blkLines.length - 1]));

  console.log('\n' + blk.split('\n').map((l) => '  | ' + l).join('\n'));

  // ══════════ C2. 段4 与产物头各说各的（2026-10-08 定）══════════
  // 曾经的做法是"有产物时给描述层关掉段4"（withImmersion:false）——
  // 那是在公共渲染器里加场景特判，接一个新接口就得加一条判断。已撤。
  // 正解：两句说**不同维度** —— 段4 说动作（刚才在上网冲浪。），产物头说结果
  // （搜到了一条有意思的内容：）。这样永远不撞，且新接口只写自己的产物头。
  console.log('\nC2. 有产物时段4 与产物头各说各的\n');

  const FINDING = {
    title: 'Attention Is All You Need',
    url: 'https://arxiv.org/abs/1706.03762',
    note: '把注意力机制从循环结构里拆出来单独用，序列建模不再依赖逐步递归。',
  };
  const withF = buildProactiveNotice(stBusy, toneGrid,
    { scene: 'find_activity', reason: 'surf', finding: FINDING },
    cfg.sceneOverride, cfg.proactiveOutlet, desc);
  const failBlock = buildProactiveNotice(stBusy, toneGrid,
    { scene: 'find_activity', reason: 'surf', failure: '没翻出什么合适的（超时）。' },
    cfg.sceneOverride, cfg.proactiveOutlet, desc);
  const noFBlock = buildProactiveNotice(stBusy, toneGrid,
    { scene: 'find_activity', reason: 'pride_block' },
    cfg.sceneOverride, cfg.proactiveOutlet, desc);

  const DOING_LINE = DOING;   // 复用 B 段的 doing 句（同一次 replace）
  const wLines = withF.split('\n');
  check('有产物的块：段4 照常出，说的是「刚才在上网冲浪。」（动作）',
    withF.includes(DOING_LINE), wLines.slice(1, 5).join(' / '));
  check('有产物的块：产物头说结果（搜到了一条有意思的内容：）',
    withF.includes(FINDING_HEAD) && withF.includes(FINDING.title), wLines.slice(1, 8).join(' / '));
  check('两句维度错开：产物头不复述动作词，段4 不含结果词',
    !FINDING_HEAD.includes('冲浪') && !FINDING_HEAD.includes('上网') &&
    !DOING_LINE.includes('搜到'),
    `产物头=${FINDING_HEAD} / 段4=${DOING_LINE}`);
  check('顺序是「动作 → 结果」（段4 在产物头之前）',
    wLines.indexOf(DOING_LINE) > 0 && wLines.indexOf(DOING_LINE) < wLines.indexOf(FINDING_HEAD));
  check('有产物的块：段1~3 仍在（处境与产物不重叠）',
    withF.includes(desc(stBusy, { withConnection: true }).slice(0, 1)[0]));
  check('冲浪失败分支：段4 照出，失败句只说结果（不复述"刚才"、不写"想去"）',
    failBlock.includes(DOING_LINE) && failBlock.includes('没翻出什么合适的') &&
    !failBlock.includes('刚才想'),
    failBlock.split('\n').slice(1, 5).join(' / '));
  check('无产物的独处块：段4 照常出（「他手头在忙什么」这一层没被砍掉）',
    noFBlock.includes(DOING_LINE), noFBlock.split('\n').slice(1, 5).join(' / '));

  console.log('\n' + withF.split('\n').map((l) => '  | ' + l).join('\n'));

  // ══════════ D. 接线层（静态，不跑进程）══════════
  console.log('\nD. bridge.js 接线点\n');

  const src = fs.readFileSync(path.join(__dirname, '..', 'bridge.js'), 'utf8');
  check('登记挂在子进程的 spawn 事件上（进程真起来了才记）',
    /child\.on\('spawn',[\s\S]{0,200}?recordActivity\(/.test(src));
  check('spawn 失败分支（entry 不存在）之前不登记',
    /surf entry not found[\s\S]{0,200}?return;/.test(src) &&
    src.indexOf("child.on('spawn'") > src.indexOf('surf entry not found'));
  check('surf 产物回投路径也登记（刷新时间戳，段4 才说得出"刚才"）',
    /surfFindingPath[\s\S]*?await recordActivity\(/.test(src));
  check('节流指纹含 immersion（否则段4 的变化会被静默吃掉）',
    /\[state\.connection, state\.pride, state\.valence, state\.arousal, state\.immersion\]/.test(src));
  check('活动 type/label 可配（改文案不用动代码）',
    /SURF_ACTIVITY_TYPE/.test(src) && /SURF_ACTIVITY_LABEL/.test(src));
  check(`bridge.js 的 label 默认值 = 「${SURF_LABEL_DEFAULT}」（与本测试同步）`,
    new RegExp(`SURF_ACTIVITY_LABEL \\|\\| '${SURF_LABEL_DEFAULT}'`).test(src));
  // 反向守卫：描述层不许再有"哪个场景关哪一段"的开关。
  // 重复是文案层的事（两句说不同维度），不是渲染层的场景特判。
  const codeOnly = (s) => s.split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))   // 丢掉整行注释（含块注释）
    .join('\n')
    .replace(/\/\/[^\n]*/g, '');                    // 再丢掉行尾注释
  const inj = codeOnly(fs.readFileSync(path.join(__dirname, '..', 'lib', 'inject-text.js'), 'utf8'));
  const dsc = codeOnly(fs.readFileSync(path.join(__dirname, '..', 'lib', 'describe.js'), 'utf8'));
  check('描述层没有场景开关（代码行里不许再出现 withImmersion 之类）',
    !/withImmersion/.test(inj) && !/withImmersion/.test(dsc),
    'inject-text.js / describe.js 的代码行里不许再有 withImmersion');
  check('产物头不复述动作（不与段4 撞车）',
    !FINDING_HEAD.includes('冲浪') && !FINDING_HEAD.includes('上网'), FINDING_HEAD);

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n${pass}/${results.length} 通过`);
  process.exit(pass === results.length ? 0 : 1);
})().catch((e) => { console.error('TEST CRASH', e); process.exit(2); });
