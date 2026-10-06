'use strict';
// surf —— 他自己出门逛那一段。
//
// ── 定位 ──
// 原库 proactive-web-surf-agent 是「发现即推送」。这里改成第一阶段：
//   白天随机窗口跑一次 → 并行拉几个公开源 → 归一 → 写进 share_pool → 结束。
// **不投递任何东西。** 交付发生在 contact 阈值越过时，由 bridge.js 调 pool.take()。
//
// ── ⚠️ 它绝不调 applyDelta ──
// 直觉上「出门逛了一圈所以不那么想她了」说得通，但一旦无条件执行就出事：
//   · contact 分支投递后已经在扣 −0.35
//   · 静默时段那个 −0.35 未决 bug 还没修（见 MEMORY「未定/待办」）
// 再叠第三处，connection 一路下坠、阈值永不触发。
// 所以这里只记日志供排查，真要调状态得先想清楚静默时段那个问题。
//
// ── 时段与频率 ──
//  · 只在白天窗口跑（复用 clock 的业务时区，跟静默时段同一套口径）
//  · 成功后随机排下次，最短 MIN_INTERVAL_HOURS、最长 MAX_INTERVAL_HOURS
//  · 落在夜里的直接改到下一个窗口内（重新采样，不做"顺延"）
//  · 失败退避，不高频撞墙
//
// ── 存储 ──
// 调度状态存在 data/surf_state.json，与 share_pool 分开：
// 前者是"什么时候出门"，后者是"看到了什么"，两件事的生命周期不同。

const fs = require('fs');
const path = require('path');
const { createSources } = require('./sources.js');

const DEFAULTS = {
  enabled: (process.env.SURF_ENABLED || 'true') !== 'false',
  dayStartHour: parseInt(process.env.SURF_DAY_START_HOUR || '9', 10),
  dayEndHour: parseInt(process.env.SURF_DAY_END_HOUR || '23', 10),
  minIntervalHours: parseFloat(process.env.SURF_MIN_INTERVAL_HOURS || '6'),
  maxIntervalHours: parseFloat(process.env.SURF_MAX_INTERVAL_HOURS || '12'),
  backoffMinutes: parseInt(process.env.SURF_ERROR_BACKOFF_MINUTES || '60', 10),
  // 每轮最多收几条进池。池子有上限，这里也卡一道，避免一轮把一天的口粮用光。
  maxPerRun: parseInt(process.env.SURF_MAX_PER_RUN || '3', 10),
  stateFile: process.env.SURF_STATE_FILE || 'data/surf_state.json',
};

const HOUR = 3600 * 1000;

function randomBetweenHours(minH, maxH) {
  const lo = Math.max(0.1, minH), hi = Math.max(lo, maxH);
  return (lo + Math.random() * (hi - lo)) * HOUR;
}

/**
 * 创建一个 surf 引擎。
 * @param {object} opts
 *   pool   createSharePool 的返回值（必填，surf 只往里 add）
 *   clock  createClock 的返回值（必填）
 *   log    日志函数
 *   config 覆盖默认值
 */
function createSurf(opts) {
  const o = opts || {};
  const pool = o.pool;
  const clock = o.clock;
  const log = o.log || (() => {});
  if (!pool) throw new Error('surf requires a share pool');
  if (!clock) throw new Error('surf requires a clock');

  const cfg = Object.assign({}, DEFAULTS, o.config || {});
  // 源开关透传：cfg 里的 hn / met 为 false 时不采那个源。
  // GLXY 那类需要身份的源将来也在 registry 登记（见 sources.js 说明），
  // 开关走同一套通道。
  const sources = createSources({
    log,
    hn: cfg.hn,
    met: cfg.met,
    only: cfg.onlySource || null,
  });

  const state = {
    nextRunAt: 0,
    lastRunAt: null,
    lastRunCount: 0,
    lastError: null,
    lastErrorAt: null,
    runCountToday: 0,
    runDay: '',
  };

  const stateFile = path.isAbsolute(cfg.stateFile)
    ? cfg.stateFile
    : path.join(__dirname, '..', cfg.stateFile);

  // ── 时段判定 ───────────────────────────────────
  function inDayWindow(ts) {
    const h = clock.localHour(ts);
    const a = cfg.dayStartHour, b = cfg.dayEndHour;
    if (a === b) return true;
    if (a < b) return h >= a && h < b;   // 同日窗口
    return h >= a || h < b;              // 跨午夜
  }

  /** 业务时区里，从 ts 起第 dayOffset 天的 00:00 对应的绝对时间戳。 */
  function startOfBusinessDay(ts, dayOffset) {
    const d = clock.localDateStr(ts);        // 例 '2026-10-06'
    const y = +d.slice(0, 4), m = +d.slice(5, 7), dd = +d.slice(8, 10);
    const utcMidnight = Date.UTC(y, m - 1, dd, 0, 0, 0);
    return utcMidnight - clock.offsetHours * HOUR + (dayOffset || 0) * 24 * HOUR;
  }

  /**
   * 在允许窗口内随机取一个时刻（绝对时间戳）。
   *
   * 做法：在窗口跨度内取随机偏移，以「窗口开启时刻」为原点展开。
   * 窗口 [a, b) 左闭右开；跨午夜（b <= a）时跨度跨到次日，天然处理。
   * 这样取出的值**不可能落在窗外** —— 比"先随机、落窗外就顺延"可靠得多
   *（后者实测 166/300 次落在窗外：右开区间上窗口终点被判为窗外，于是反复重排）。
   */
  function pickInWindow(fromTs) {
    const a = cfg.dayStartHour, b = cfg.dayEndHour;
    const spanMs = (a === b ? 24 : (b > a ? b - a : 24 - a + b)) * HOUR;

    for (let dayOffset = 0; dayOffset <= 2; dayOffset++) {
      const winStart = startOfBusinessDay(fromTs, dayOffset) + a * HOUR;
      const availFrom = Math.max(winStart, fromTs);
      const availTo = winStart + spanMs;
      if (availTo <= availFrom) continue;   // 当天窗口已过（或还没到）
      const t = availFrom + Math.random() * (availTo - availFrom);
      if (inDayWindow(t)) return t;
    }
    // 三天都取不到（窗口与 from 矛盾的极端情况）：给一个近未来的合法点
    const fallback = startOfBusinessDay(fromTs, 1) + a * HOUR;
    return inDayWindow(fallback) ? fallback : fromTs + cfg.maxIntervalHours * HOUR;
  }

  /**
   * 排下一次：先保证最小间隔，落点必须在窗口内。
   */
  function scheduleNext(ts) {
    const from = ts || Date.now();
    const earliest = from + cfg.minIntervalHours * HOUR;
    let next = from + randomBetweenHours(cfg.minIntervalHours, cfg.maxIntervalHours);

    if (!inDayWindow(next) || next < earliest) {
      // 重新在窗口内采样，且必须不早于 from
      const picked = pickInWindow(Math.max(earliest, next));
      next = inDayWindow(picked) && picked >= from ? picked : pickInWindow(from);
    }
    state.nextRunAt = next;
    saveState();
    return next;
  }

  function loadState() {
    try {
      const j = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (j && typeof j === 'object') Object.assign(state, j);
    } catch (e) {
      // 首次启动没有文件是正常的
    }
    // 时钟漂移 / 时区变更后旧排期可能落在窗外，重排一次
    if (!state.nextRunAt || !inDayWindow(state.nextRunAt)) scheduleNext();
  }

  function saveState() {
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      const tmp = stateFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
      fs.renameSync(tmp, stateFile);
    } catch (e) {
      log('ERROR', 'surf state save failed: ' + e.message);
    }
  }

  async function runOnce(opts2) {
    const oo = opts2 || {};
    if (!cfg.enabled) { log('INFO', 'surf disabled'); return 0; }
    if (!oo.force && !inDayWindow(Date.now())) {
      log('INFO', 'surf outside day window, skip');
      //⚠️ 跳过时也要重排，否则 state.nextRunAt 会一直停在窗外的那一刻，
      // runIfDue 每分钟都会撞上这个"已到期但时段不对"的点，
      // 变成每秒一次的空转（tick 分钟级，尚不致命但很难排查）。
      if (!inDayWindow(state.nextRunAt)) scheduleNext();
      return 0;
    }

    const day = clock.localDateStr();
    if (state.runDay !== day) { state.runDay = day; state.runCountToday = 0; }

    // 池子够深就不再收 —— 留着现有的，等旧的被交付掉
    const before = pool.summary();
    const room = Math.max(0, (pool.config.maxItems || 12) - before.unused);
    if (room === 0) {
      log('INFO', `surf pool full (unused=${before.unused}), nothing collected`);
      state.lastRunAt = new Date().toISOString();
      state.lastRunCount = 0;
      scheduleNext();
      saveState();
      return 0;
    }

    let candidates = [];
    try {
      candidates = await sources.collect();
    } catch (e) {
      state.lastError = e.message;
      state.lastErrorAt = new Date().toISOString();
      scheduleNext();
      saveState();
      log('ERROR', 'surf collect failed: ' + e.message);
      return 0;
    }

    const added = pool.add(candidates.slice(0, Math.min(room, cfg.maxPerRun)));

    state.lastRunAt = new Date().toISOString();
    state.lastRunCount = added;
    state.lastError = null;
    state.runCountToday++;
    scheduleNext();
    saveState();

    // ⚠️ 这里**没有** applyDelta —— 理由见文件头。
    log('INFO', `surf run: +${added} (candidates=${candidates.length} ` +
      `sources=${sources.list().join('+') || 'none'} ` +
      `pool=${pool.summary().unused}/${before.unused}) [no state change]`);
    return added;
  }

  loadState();

  return {
    config: cfg,
    state,
    sources,

    /** tick 入口：到点了就跑，没到点什么都不做。 */
    async runIfDue() {
      if (!cfg.enabled) return null;
      if (Date.now() < state.nextRunAt) return null;
      return runOnce();
    },

    runOnce,
    scheduleNext,
    saveState,
    inDayWindow,
    pickInWindow,

    summary() {
      return {
        enabled: cfg.enabled,
        sources: sources.list(),
        day_window: `${cfg.dayStartHour}-${cfg.dayEndHour}`,
        interval_hours: `${cfg.minIntervalHours}-${cfg.maxIntervalHours}`,
        next_run_at: state.nextRunAt ? new Date(state.nextRunAt).toISOString() : null,
        next_run_local_hour: state.nextRunAt ? clock.localHour(state.nextRunAt) : null,
        last_run_at: state.lastRunAt,
        last_run_count: state.lastRunCount,
        run_count_today: state.runCountToday,
        last_error: state.lastError,
        pool: pool.summary(),
      };
    },
  };
}

module.exports = { createSurf, DEFAULTS };