'use strict';
// 业务时区时钟。
//
// 为什么需要它：服务器系统时区是 UTC，而「静默时段」「日上限跨天」这类判断
// 必须按用户所在时区（北京，UTC+8）算。直接用 new Date().getHours() 拿到的是
// UTC 小时，会让 QUIET_START=0 / QUIET_END=8 实际变成「UTC 0-8 点静默」，
// 即北京时间 8:00-16:00 —— 恰好把白天当成了夜里。
//
// 约定（重要）：
//   · 日志时间戳一律走 toISOString()（UTC，ISO 8601 标准，排查无歧义）
//   · 只有业务判断（静默 / 日上限跨天）走本模块的本地时区换算
//
// 实现说明：全程基于 getUTC* + 固定偏移计算，不依赖系统 TZ，
//   因此无论部署在哪个时区都得到一致结果。中国无夏令时，固定 +8 是安全的。
//   仅支持整小时偏移（中国、UTC 等均满足）。

const MS_PER_HOUR = 3600 * 1000;

/**
 * 创建绑定到某个时区偏移的时钟。
 * @param {number} offsetHours 相对 UTC 的小时偏移，如北京为 8
 */
function createClock(offsetHours) {
  const off = Number.isFinite(offsetHours) ? offsetHours : 0;

  function at(ts) {
    return (ts === undefined || ts === null) ? Date.now() : ts;
  }

  /** 业务时区的小时（0-23） */
  function localHour(ts) {
    return (((new Date(at(ts)).getUTCHours() + off) % 24) + 24) % 24;
  }

  /** 业务时区的日期字符串 YYYY-MM-DD */
  function localDateStr(ts) {
    return new Date(at(ts) + off * MS_PER_HOUR).toISOString().slice(0, 10);
  }

  /**
   * 是否处于静默时段。
   * 左闭右开 [startHour, endHour)；start === end 视为不静默。
   * 支持跨午夜（如 22 → 6）。
   */
  function inQuietHours(ts, startHour, endHour) {
    const h = localHour(ts);
    if (startHour === endHour) return false;
    if (startHour < endHour) return h >= startHour && h < endHour;
    return h >= startHour || h < endHour;
  }

  return { offsetHours: off, localHour, localDateStr, inQuietHours };
}

module.exports = { createClock };
