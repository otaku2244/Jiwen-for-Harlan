'use strict';
// ════════════════════════════════════════════════════
// `lib/repeat-guard.js` 契约测试 + `bridge.js` 接线静态断言
//
// 跑法：node _test/repeat_guard_check.js
// ════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const { createSceneCooldown, createDialogDedup } = require('../lib/repeat-guard.js');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; }
  else { fail++; failures.push(name + (detail ? '  →  ' + detail : '')); }
}
function eq(name, actual, expected) {
  ok(name, actual === expected, `期望 ${JSON.stringify(expected)}，实得 ${JSON.stringify(actual)}`);
}

// ── 可注入时钟 ──
function makeClock(t0) {
  let t = t0;
  return {
    now: () => t,
    advanceMin: (m) => { t += m * 60000; },
    advanceSec: (s) => { t += s * 1000; },
  };
}

// ════════════════════════════════════════════════════
// A. createSceneCooldown
// ════════════════════════════════════════════════════
console.log('【A】createSceneCooldown');

{
  const c = makeClock(1_000_000_000_000);
  const cd = createSceneCooldown({ minutes: 180, now: c.now });

  ok('A1 未 mark → 放行', cd.ok('contact') === true);
  cd.mark('contact');
  ok('A2 mark 后立刻 → 挡住', cd.ok('contact') === false);

  c.advanceMin(179);
  ok('A3 差 1 分钟 → 仍挡住', cd.ok('contact') === false);
  ok('A4 remainingMinutes ≈ 1', Math.abs(cd.remainingMinutes('contact') - 1) < 0.001,
    String(cd.remainingMinutes('contact')));

  c.advanceMin(1);
  ok('A5 正好到点 → 放行（边界含等号）', cd.ok('contact') === true);
  eq('A6 到点后 remaining = 0', cd.remainingMinutes('contact'), 0);

  // 场景互不影响
  const c2 = makeClock(1_000_000_000_000);
  const cd2 = createSceneCooldown({ minutes: 180, now: c2.now });
  cd2.mark('find_activity');
  ok('A7 别的场景不受影响', cd2.ok('contact') === true);
  ok('A8 本场景仍挡住', cd2.ok('find_activity') === false);

  // resources
  cd2.reset('contact');
  ok('A9 reset 单个场景（未标记过的也安全）', cd2.ok('contact') === true);
  cd2.reset();
  ok('A10 reset 全部 → 立刻放行', cd2.ok('find_activity') === true);

  // 重新 mark 会刷新计时
  const c3 = makeClock(1_000_000_000_000);
  const cd3 = createSceneCooldown({ minutes: 60, now: c3.now });
  cd3.mark('contact');
  c3.advanceMin(50);
  cd3.mark('contact');
  c3.advanceMin(50);
  ok('A11 重新 mark 会重置窗口', cd3.ok('contact') === false);

  // 关闭态
  const cdOff = createSceneCooldown({ minutes: 0, now: c3.now });
  cdOff.mark('contact');
  ok('A12 minutes=0 → 关闭，恒放行', cdOff.ok('contact') === true);
  eq('A13 minutes=0 时 remaining = 0', cdOff.remainingMinutes('contact'), 0);

  // 未传参
  const cdNoopts = createSceneCooldown();
  cdNoopts.mark('x');
  ok('A14 无 opts → 安全降级为关闭', cdNoopts.ok('x') === true);

  // snapshot 不泄漏内部对象
  const snap = cd3.snapshot();
  ok('A15 snapshot 返回副本', typeof snap === 'object' && snap.connection === undefined);
}

// ════════════════════════════════════════════════════
// B. createDialogDedup
// ════════════════════════════════════════════════════
console.log('【B】createDialogDedup');

{
  const c = makeClock(1_000_000_000_000);
  const d = createDialogDedup({ windowSeconds: 900, now: c.now });

  ok('B1 首次 accept → 放进', d.accept('她：在吗') === true);
  ok('B2 同 key 立刻再来 → 挡住（工具轮）', d.accept('她：在吗') === false);
  ok('B3 再挡一次仍然挡住', d.accept('她：在吗') === false);
  ok('B4 换 key → 放进（新的一轮）', d.accept('她：今天好累') === true);
  // 只记「最后一轮」，不做 key 集合 —— 工具轮永远是同一段对话重复 N 次，不会交替。
  // 代价：极短窗口内 A→B→A 会让第二次 A 放行，属可接受（真实对话不会这样）。
  ok('B5 回到旧 key → 放行（只记最后一轮，非集合）', d.accept('她：在吗') === true);

  c.advanceSec(899);
  ok('B6 差 1 秒 → 仍挡住', d.accept('她：在吗') === false);
  c.advanceSec(1);
  ok('B7 超窗口后同 key → 放进（TTL 兜底）', d.accept('她：在吗') === true);

  // 空 key
  const d2 = createDialogDedup({ windowSeconds: 900, now: c.now });
  ok('B8 空 key → 挡住（不喂判定器）', d2.accept('') === false);
  ok('B9 undefined key → 挡住', d2.accept(undefined) === false);
  ok('B10 null key → 挡住', d2.accept(null) === false);
  ok('B11 空 key 不影响后续有效 key', d2.accept('正常一句话') === true);

  // 关闭态
  const dOff = createDialogDedup({ windowSeconds: 0, now: c.now });
  ok('B12 window=0 → 关闭，恒放行', dOff.accept('同一句') === true);
  ok('B13 window=0 再放行', dOff.accept('同一句') === true);

  // reset
  const d3 = createDialogDedup({ windowSeconds: 900, now: c.now });
  d3.accept('甲');
  ok('B14 reset 前同 key 挡住', d3.accept('甲') === false);
  d3.reset();
  ok('B15 reset 后同 key 放行', d3.accept('甲') === true);

  // 无 opts
  const dNoopts = createDialogDedup();
  dNoopts.accept('x');
  ok('B16 无 opts → 安全降级为关闭', dNoopts.accept('x') === true);
}

// ════════════════════════════════════════════════════
// C. bridge.js 接线静态断言
// ════════════════════════════════════════════════════
console.log('【C】bridge.js 接线');

const src = fs.readFileSync(path.join(__dirname, '..', 'bridge.js'), 'utf8');
const at = (needle) => src.indexOf(needle);

ok('C1 引入了 repeat-guard', src.includes("require('./lib/repeat-guard.js')"));
ok('C2 建了 actionCooldown', /createSceneCooldown\(\{[^}]*minutes:\s*CFG\.actionCooldownMinutes/.test(src));
ok('C3 建了 dialogDedup', /createDialogDedup\(\{[^}]*windowSeconds:\s*CFG\.analyzeDedupSeconds/.test(src));

// 冷却在 contact 分支
ok('C4 contact 分支有冷却判断', src.includes("if (!actionCooldown.ok('contact'))"));
// 冷却在 find_activity 分支
ok('C5 find_activity 分支有冷却判断', src.includes("if (!actionCooldown.ok('find_activity'))"));

// ⚠️ 顺序硬约束：冷却判断必须在 spawnSurf 之前（先跑再判 = 白烧模型钱）
{
  const iCooldown = at("if (!actionCooldown.ok('find_activity'))");
  const iSpawn = at('spawnSurf(t.reason);');
  ok('C6 冷却判断早于 spawnSurf', iCooldown > 0 && iSpawn > 0 && iCooldown < iSpawn,
    `cooldown@${iCooldown} spawn@${iSpawn}`);
}

// spawn 后立刻 mark（surf 崩了也不重复 spawn）
{
  const iSpawn = at('spawnSurf(t.reason);');
  const iMark = src.indexOf("actionCooldown.mark('find_activity');", iSpawn);
  ok('C7 spawn 之后立刻 mark', iMark > iSpawn && (iMark - iSpawn) < 200);
}

// 判定器：accept 必须在 analyzeDialog 之前
{
  const iAccept = at('dialogDedup.accept(dialogKey)');
  const iAnalyze = at('analyzeDialog(dialog, { ...CFG, log })');
  ok('C8 去重判断早于 analyzeDialog', iAccept > 0 && iAnalyze > 0 && iAccept < iAnalyze,
    `accept@${iAccept} analyze@${iAnalyze}`);
}

// dialogKeyOf 定义在 extractRecentDialog 之后，且在请求处理里被调用
ok('C9 dialogKeyOf 已定义', /function dialogKeyOf\(dialog\)/.test(src));
{
  const iExtract = at('function extractRecentDialog(body, n)');
  const iKey = at('function dialogKeyOf(dialog)');
  ok('C10 dialogKeyOf 紧跟 extractRecentDialog', iKey > iExtract && (iKey - iExtract) < 2000,
    `extract@${iExtract} key@${iKey}`);
}

// fireProactive 返回布尔
ok('C11 fireProactive 有 return false', /async function fireProactive[\s\S]{0,900}return false;/.test(src));
ok('C12 fireProactive 有 return true', /async function fireProactive[\s\S]{0,4000}return true;\s*\n\}/.test(src));
// 且调用方按返回值记账
ok('C13 调用方按 sent 记账 (contact)', src.includes("if (sent) actionCooldown.mark('contact');"));
ok('C14 调用方按 sent 记账 (find_activity)', src.includes("if (sent) actionCooldown.mark('find_activity');"));

// 引擎参数：骄傲防御必须传进 rates（vendor 默认是"永不"的哨兵值）
ok('C15 rates 传了 prideDefendThreshold', /prideDefendThreshold:\s*CFG\.prideDefendThreshold/.test(src));
ok('C16 rates 传了 prideDefendRate', /prideDefendRate:\s*CFG\.prideDefendRate/.test(src));
ok('C17 默认 threshold = 0.20', /PRIDE_DEFEND_THRESHOLD \|\| '0\.20'/.test(src));
ok('C18 默认 rate = 0.004', /PRIDE_DEFEND_RATE \|\| '0\.004'/.test(src));
ok('C19 默认日上限 = 8', /PROACTIVE_MAX_PER_DAY \|\| '8'/.test(src));
ok('C20 默认冷却 = 180 分钟', /ACTION_COOLDOWN_MINUTES \|\| '180'/.test(src));
ok('C21 默认去重窗 = 900 秒', /ANALYZE_DEDUP_SECONDS \|\| '900'/.test(src));

// 日志节流：冷却跳过不能每 tick 刷屏
ok('C22 冷却跳过日志有节流', /function logCooldownSkip[\s\S]{0,400}_cdLogAt\[scene\]/.test(src));

// MCP runtime 暴露冷却剩余
ok('C23 MCP runtime 暴露 cooldown_left_minutes', src.includes('cooldown_left_minutes'));

// ⚠️ 回归守护：vendor 一行不动
{
  const fs2 = require('fs');
  const v = fs2.readFileSync(path.join(__dirname, '..', 'vendor', 'jiwen.js'), 'utf8');
  ok('C24 vendor 仍以哨兵值作默认（说明我们没改 vendor）',
    v.includes('prideDefendThreshold: 1.0,') && v.includes('valenceActivity:   -1.0,'));
}

// ════════════════════════════════════════════════════
console.log('');
console.log(`结果：${pass} 通过 / ${fail} 失败  （共 ${pass + fail}）`);
if (failures.length) {
  console.log('\n失败项：');
  failures.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
}
