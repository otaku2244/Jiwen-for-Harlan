'use strict';
// surf 全链路实测：跑一轮 → 收候选 → 入池 → 取一条交付
// 用法：
//   真连源：  SURF_PROXY=http://127.0.0.1:7897 node _test/surf_check.js
//   离线快跑（不联网）：node _test/surf_check.js --offline

const fs = require('fs');
const os = require('os');
const path = require('path');

const OFFLINE = process.argv.includes('--offline');

const TMP_DIR = path.join(os.tmpdir(), 'jiwen_surf_test');
const POOL_FILE = path.join(TMP_DIR, 'share_pool.json');
const STATE_FILE = path.join(TMP_DIR, 'surf_state.json');

// 清干净
try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {}
fs.mkdirSync(TMP_DIR, { recursive: true });

const { createSharePool } = require('../lib/share-pool.js');
const { createClock } = require('../lib/clock.js');
const { createSurf } = require('../lib/surf.js');

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}

const logLines = [];
const log = (l, m) => { logLines.push('[' + l + '] ' + m); console.log('       [' + l + '] ' + m); };

(async () => {
  console.log('mode = ' + (OFFLINE ? 'offline (不联网)' : 'live (经代理连真源)'));
  console.log('');

  const pool = createSharePool(POOL_FILE, { log, maxItems: 8, ttlHours: 168 });
  const clock = createClock(8); // 业务时区 UTC+8
  const surf = createSurf({
    pool, clock, log,
    config: {
      stateFile: STATE_FILE,
      dayStartHour: 0, dayEndHour: 24,   // 测试放宽时段
      minIntervalHours: 6, maxIntervalHours: 12,
      maxPerRun: 3,
      hn: !OFFLINE, met: !OFFLINE,       // offline 时源关掉
    },
  });

  // ── 1. 排期 ──
  console.log('[1] 排期');
  const s1 = surf.summary();
  check('首次启动已排出下次时间', !!s1.next_run_at, JSON.stringify(s1));
  const gapH = (Date.parse(s1.next_run_at) - Date.now()) / 3600000;
  check('间隔在 6~12 小时之间', gapH >= 5.9 && gapH <= 12.1, gapH.toFixed(2) + 'h');
  check('列出了启用的源', Array.isArray(s1.sources), JSON.stringify(s1.sources));
  console.log('       next_run = ' + s1.next_run_at + '  (北京时间 ' +
    clock.localHour(Date.parse(s1.next_run_at)) + ' 时)');

  // ── 2. 状态文件落盘 ──
  console.log('');
  console.log('[2] 状态持久化');
  check('surf_state.json 已写', fs.existsSync(STATE_FILE));
  const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  check('nextRunAt 已持久化', typeof saved.nextRunAt === 'number' && saved.nextRunAt > 0,
    JSON.stringify(saved));

  // ── 3. 跑一轮 ──
  console.log('');
  console.log('[3] 跑一轮 (' + (OFFLINE ? '无源' : '真源') + ')');
  const n = await surf.runOnce({ force: true });
  console.log('       入池 ' + n + ' 条');
  if (OFFLINE) {
    check('offline 时入池 0 条', n === 0, String(n));
  } else {
    check('跑一轮有入池', n > 0, String(n));
    check('不超过 maxPerRun', n <= 3, String(n));
  }

  // ── 4. ⚠️ 不许动状态 ──
  console.log('');
  console.log('[4]⚠️ 不改引擎状态');
  const stateLog = logLines.filter((l) => /surf run/.test(l)).join('\n');
  check('日志明说不改状态', /\[no state change\]/.test(stateLog), stateLog.slice(-90));
  // 断言surf.js 源码里没有任何"改引擎状态"的调用。
  // ⚠️ 只匹配 applyDelta / vendor require，别匹配 'no state change' 这类注释文本。
  const surfSrc = require('fs').readFileSync(path.join(__dirname, '..', 'lib', 'surf.js'), 'utf8');
  const codeOnly = surfSrc.split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
  check('surf 代码里无 applyDelta 调用', !/applyDelta\s*\(/.test(codeOnly),
    (codeOnly.match(/applyDelta[^(]*/) || [])[0]);
  check('surf 代码里没 require vendor 引擎', !/require\(['"][^'"]*vendor/.test(codeOnly));

  // ── 5. 交付 ──
  console.log('');
  console.log('[5] 交付（take 一条）');
  const it = pool.take();
  if (OFFLINE) {
    check('offline 无内容可交付', it === null, JSON.stringify(it));
  } else {
    check('取到一条', !!it, JSON.stringify(it));
    if (it) {
      console.log('       [' + it.source + '] ' + it.title);
      console.log('              ' + it.url);
      if (it.imageUrl) console.log('              图: ' + it.imageUrl);
      check('交付物有 url 与 title', !!(it.url && it.title));
      check('交付物已标已用', !!it.usedAt);
      check('标题不过长（通知正文要装得下）', it.title.length <= 80, String(it.title.length));
    }
  }

  // ── 6. 池满即停 ──
  console.log('');
  console.log('[6] 池满则不再收');
  const n2 = await surf.runOnce({ force: true });
  const after = pool.summary();
  check('重复跑不突破上限', after.total <= 8, JSON.stringify(after));
  console.log('       池: ' + JSON.stringify(after));

  // ── 7. 时段外不跑 ──
  console.log('');
  console.log('[7] 时段限制');
  const nightSurf = createSurf({
    pool, clock, log: () => {},
    config: {
      stateFile: path.join(TMP_DIR, 'night_state.json'),
      dayStartHour: 3, dayEndHour: 5,     // 只允许凌晨 3-5 点
      hn: false, met: false,
    },
  });
  nightSurf.state.nextRunAt = 0;           // 让它认为到期
  const r = await nightSurf.runOnce();
  check('时段外不跑', r === 0, String(r));
  check('时段外排期被推到下一个允许时段', (() => {
    const t = nightSurf.state.nextRunAt;
    if (!nightSurf.inDayWindow(t)) return false;
    const h = clock.localHour(t);
    // 窗口 3-5 是个很窄的白天段；现在若已过窗口，必须排到**明天**，
    // 不能是今天已过的那几个小时。所以同时校验小时与「是否明天」。
    const isTomorrow = clock.localDateStr(t) !== clock.localDateStr();
    return (h === 3 || h === 4) && (isTomorrow || (clock.localHour(Date.now()) < 3));
  })(), 'next hour = ' + clock.localHour(nightSurf.state.nextRunAt)
    + ' localdate = ' + clock.localDateStr(nightSurf.state.nextRunAt));

  // ── 8. 失败退避 ──
  console.log('');
  console.log('[8] 失败不撞墙');
  const badSurf = createSurf({
    pool, clock, log: () => {},
    config: {
      stateFile: path.join(TMP_DIR, 'bad_state.json'),
      backoffMinutes: 60,
      hn: false, met: false,
      dayStartHour: 0, dayEndHour: 24,
    },
  });
  badSurf.state.nextRunAt = Date.now() - 1;
  await badSurf.runOnce();  // 无源但 enabled，不应崩
  check('无源时不崩且仍排了下次', badSurf.state.nextRunAt > Date.now());

  // ── 9. summary 可用 ──
  console.log('');
  console.log('[9] summary');
  const sm = surf.summary();
  console.log('       ' + JSON.stringify(sm));
  check('summary 含关键字段', ['enabled', 'sources', 'next_run_at', 'pool'].every((k) => k in sm),
    Object.keys(sm).join(','));

  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {}
  console.log('');
  console.log(pass + ' pass / ' + fail + ' fail');
  process.exit(fail ? 1 : 0);
})();