'use strict';
// 静默时段 / 日上限跨天 的时区正确性回归测试
//
// 背景 bug（2026-10-05）：bridge.js 用 new Date().getHours() 判静默，
// 而 VPS 系统时区是 UTC，导致 QUIET_START=0 / QUIET_END=8 实际变成
// 「UTC 0-8 点静默」＝北京时间 8:00-16:00 静默 —— 白天被当成夜里。
//
// 本测试全部用「显式时间戳 + 显式偏移」，不依赖运行机器的时区，
// 因此在本机（CST）与 VPS（UTC）跑出的结果必须完全一致。

const { createClock } = require('../lib/clock.js');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  PASS  ' + name); pass++; }
  else { console.log('  FAIL  ' + name + (extra !== undefined ? '  → ' + extra : '')); fail++; }
}
const T = (s) => Date.parse(s);   // ISO 8601 带 Z，绝对时刻

const CLK = createClock(8);       // 北京
const UTC = createClock(0);

console.log('=== ① localHour：UTC 时刻 → 北京小时 ===');
check('UTC 04:00 → 北京 12', CLK.localHour(T('2026-10-05T04:00:00Z')) === 12,
  CLK.localHour(T('2026-10-05T04:00:00Z')));
check('UTC 12:00 → 北京 20', CLK.localHour(T('2026-10-05T12:00:00Z')) === 20);
check('UTC 16:00 → 北京 00（跨日）', CLK.localHour(T('2026-10-05T16:00:00Z')) === 0);
check('UTC 23:59 → 北京 07', CLK.localHour(T('2026-10-05T23:59:00Z')) === 7);
check('UTC 15:59 → 北京 23', CLK.localHour(T('2026-10-05T15:59:00Z')) === 23);
check('offset=0 时等同 UTC', UTC.localHour(T('2026-10-05T04:00:00Z')) === 4);

console.log('');
console.log('=== ② inQuietHours：quiet = 0-8（北京）===');
// 这是 bug 的核心场景：北京 12:00（上班时间）绝不该静默
const bugCase = CLK.inQuietHours(T('2026-10-05T04:00:00Z'), 0, 8);
check('北京 12:00 不在静默 ← bug 场景（旧实现会误判为静默）', bugCase === false, bugCase);
check('北京 20:00 不在静默', CLK.inQuietHours(T('2026-10-05T12:00:00Z'), 0, 8) === false);
check('北京 00:00 在静默', CLK.inQuietHours(T('2026-10-05T16:00:00Z'), 0, 8) === true);
check('北京 07:59 在静默', CLK.inQuietHours(T('2026-10-05T23:59:00Z'), 0, 8) === true);
check('北京 08:00 不在静默（右开区间）', CLK.inQuietHours(T('2026-10-06T00:00:00Z'), 0, 8) === false);
check('北京 23:59 不在静默', CLK.inQuietHours(T('2026-10-05T15:59:00Z'), 0, 8) === false);

console.log('');
console.log('=== ③ inQuietHours：跨午夜 quiet = 22-6（北京）===');
check('北京 23:00 在静默', CLK.inQuietHours(T('2026-10-05T15:00:00Z'), 22, 6) === true);
check('北京 06:00 不在静默（右开）', CLK.inQuietHours(T('2026-10-05T22:00:00Z'), 22, 6) === false);
check('北京 05:00 在静默', CLK.inQuietHours(T('2026-10-05T21:00:00Z'), 22, 6) === true);
check('北京 12:00 不在静默', CLK.inQuietHours(T('2026-10-05T04:00:00Z'), 22, 6) === false);

console.log('');
console.log('=== ④ start === end 视为永不静默 ===');
check('quiet 0-0 不静默（北京 03:00）', CLK.inQuietHours(T('2026-10-05T19:00:00Z'), 0, 0) === false);
check('quiet 8-8 不静默（北京 12:00）', CLK.inQuietHours(T('2026-10-05T04:00:00Z'), 8, 8) === false);

console.log('');
console.log('=== ⑤ localDateStr：日上限跨天按北京算 ===');
check('UTC 15:59 → 北京仍当天 10-05', CLK.localDateStr(T('2026-10-05T15:59:00Z')) === '2026-10-05',
  CLK.localDateStr(T('2026-10-05T15:59:00Z')));
check('UTC 16:00 → 北京已次日 10-06 ← 日上限重置点',
  CLK.localDateStr(T('2026-10-05T16:00:00Z')) === '2026-10-06',
  CLK.localDateStr(T('2026-10-05T16:00:00Z')));
check('offset=0 时按 UTC 日期', UTC.localDateStr(T('2026-10-05T16:00:00Z')) === '2026-10-05');

console.log('');
console.log('=== ⑥ 不依赖运行机器的系统时区 ===');
// 本机是 CST(+8)，VPS 是 UTC；同一绝对时刻必须得到同一业务小时
const ts = T('2026-10-05T04:00:00Z');
const before = CLK.localHour(ts);
const savedTZ = process.env.TZ;
try {
  process.env.TZ = 'UTC';
  check('改 TZ=UTC 后 localHour 不变', CLK.localHour(ts) === before);
  process.env.TZ = 'America/New_York';
  check('改 TZ=America/New_York 后 localHour 不变', CLK.localHour(ts) === before);
} finally {
  if (savedTZ === undefined) delete process.env.TZ; else process.env.TZ = savedTZ;
}

console.log('');
console.log('=== ⑦ 反证：旧实现为何出错 ===');
// 旧实现 = new Date().getHours()，在 TZ=UTC 的机器上返回 UTC 小时。
// 本机是 CST，无法直接复现 VPS 行为，这里用 UTC 时钟做等价演示：
const oldStyleOnUtcBox = new Date(T('2026-10-05T04:00:00Z')).getUTCHours();  // ≈ getHours() 在 UTC 机器上
const oldVerdict = oldStyleOnUtcBox >= 0 && oldStyleOnUtcBox < 8;
check('（反证）旧实现在 UTC 机器上把北京 12:00 判成静默', oldVerdict === true,
  'UTC 小时=' + oldStyleOnUtcBox);
check('（反证）新实现同一时刻判不静默', CLK.inQuietHours(T('2026-10-05T04:00:00Z'), 0, 8) === false);

console.log('');
console.log(pass + '/' + (pass + fail) + ' 通过');
process.exit(fail ? 1 : 0);
