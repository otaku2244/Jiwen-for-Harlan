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
const { buildProactiveNotice } = require('../lib/inject-text.js');

const cfg = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'config', 'tone-harlan.json'), 'utf8'));
const toneGrid = createToneGrid({ profiles: cfg.profiles, urgencyBoost: cfg.urgencyBoost });
const desc = createDescriber(cfg.describe);

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (detail ? '  — ' + detail : ''));
}

const SURF = { type: 'search', label: '网页检索' };
// 与 bridge.js CFG 的默认值同步（改一边记得改另一边）
const SURF_TYPE_DEFAULT = 'search';
const SURF_LABEL_DEFAULT = '网页检索';

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

  const noType = await recordActivity(fakeJiwen, { label: '网页检索' }, () => {});
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
  check(`immersion > ${IMMERSION_BUSY} 且有活动 → 「刚才在网页检索。」`,
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

  // ══════════ C2. 有产物时段4 停用（2026-10-08 用户指出重复）══════════
  console.log('\nC2. 有产物时段4 停用\n');

  const FINDING = {
    title: 'Attention Is All You Need',
    url: 'https://arxiv.org/abs/1706.03762',
    note: '把注意力机制从循环结构里拆出来单独用，序列建模不再依赖逐步递归。',
  };
  const withF = buildProactiveNotice(stBusy, toneGrid,
    { scene: 'find_activity', reason: 'surf', finding: FINDING },
    cfg.sceneOverride, cfg.proactiveOutlet, desc);
  const failBlock = buildProactiveNotice(stBusy, toneGrid,
    { scene: 'find_activity', reason: 'surf', failure: '刚才想去翻点东西，没翻成（超时）。' },
    cfg.sceneOverride, cfg.proactiveOutlet, desc);
  const noFBlock = buildProactiveNotice(stBusy, toneGrid,
    { scene: 'find_activity', reason: 'pride_block' },
    cfg.sceneOverride, cfg.proactiveOutlet, desc);

  const DOING_LINE = DOING;   // 复用 B 段的 doing 句（同一次 replace）
  check('有产物的块：段4「刚才在网页检索。」不再出现（产物头已交代同一次冲浪）',
    !withF.includes(DOING_LINE), withF.split('\n').slice(1, 5).join(' / '));
  check('有产物的块：产物头仍在（段4 去、产物留 —— 留的那份带结果）',
    withF.includes('之前独处冲浪时发现的东西：') && withF.includes(FINDING.title));
  check('有产物的块：段1~3 仍在（处境与产物不重叠，不该一起被砍）',
    desc(stBusy, { withConnection: true }).length ===
    desc(stBusy, { withConnection: true, withImmersion: false }).length + 1 &&
    withF.includes(desc(stBusy, { withConnection: true })[0]));
  check('冲浪失败分支同样关段4（否则「没翻成」与「刚才在检索」自相矛盾）',
    !failBlock.includes(DOING_LINE), failBlock.split('\n').slice(1, 4).join(' / '));
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

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n${pass}/${results.length} 通过`);
  process.exit(pass === results.length ? 0 : 1);
})().catch((e) => { console.error('TEST CRASH', e); process.exit(2); });
