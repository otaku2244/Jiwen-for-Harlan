'use strict';
// 时段排期独立验证：反复采样，统计落在窗外的比例
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = path.join(os.tmpdir(), 'jiwen_sched_verify');
try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (_) {}
fs.mkdirSync(DIR, { recursive: true });

const { createClock } = require('../lib/clock.js');
const { createSharePool } = require('../lib/share-pool.js');
const { createSurf } = require('../lib/surf.js');

const clock = createClock(8);
console.log('now UTC   = ' + new Date().toISOString());
console.log('本地小时 = ' + clock.localHour());
console.log('');

const WINDOWS = [[3, 5], [9, 23], [0, 24], [22, 6], [8, 10], [1, 2]];
const N = 200;
let grandBad = 0;

for (const [a, b] of WINDOWS) {
  const pool = createSharePool(path.join(DIR, 'p.json'), { hn: false });
  const s = createSurf({
    pool, clock, log: () => {},
    config: {
      stateFile: path.join(DIR, `s_${a}_${b}.json`),
      dayStartHour: a, dayEndHour: b,
      hn: false, met: false,
      minIntervalHours: 1, maxIntervalHours: 2,
    },
  });
  let bad = 0;
  const hours = {};
  for (let i = 0; i < N; i++) {
    const t = s.pickInWindow(Date.now());
    if (!s.inDayWindow(t)) bad++;
    const h = clock.localHour(t);
    hours[h] = (hours[h] || 0) + 1;
  }
  grandBad += bad;
  const dist = Object.keys(hours).map(Number).sort((x, y) => x - y).join(',');
  console.log(`窗口 ${String(a).padStart(2)}-${String(b).padEnd(2)}  窗外 ${String(bad).padStart(3)}/${N}  分布小时=[${dist}]`);
}

console.log('');
console.log(grandBad === 0 ? '== 全部落在窗口内 ==' : `== 共 ${grandBad} 次落在窗外 ==`);

try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (_) {}
process.exit(grandBad === 0 ? 0 : 1);