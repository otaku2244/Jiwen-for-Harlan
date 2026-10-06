'use strict';
// share_pool —— 他出门看到的东西，存着，等真想找她那次交给她。
//
// ── 为什么是「只存不投」──
// 原库 proactive-web-surf-agent 的定位是「发现即推送」。这里刻意改成两阶段：
//   第一阶段（surf）：白天自己出门，捡回候选，写进池子，不投递任何东西。
//   第二阶段（交付）：jiwen 的 contact 阈值真的越过时，才从池子里取一条，
//                     拼进那一条主动唤醒通知里。
// 好处：
//   1. 「他出门逛」变成「他在自己那侧过日子」的能力，而不是另一条推送源
//   2. 通知里有了内容载体 —— 现在 contact 只有情绪动机，加了素材才是
//      「我看到这个想起你」而不是干巴巴一句想念
//   3. 内容由他先看过、筛过、等到合适的时机才交出去，不是随机插播
//
// ── 它绝不做什么 ──
//   · 不投递。交付由 bridge.js 在 contact 分支调用take()，本模块只管存与取
//   · 不改状态。本模块不碰 jiwen 引擎、不调 applyDelta。
//     ⚠️ 原因：静默时段照扣 −0.35 那个未决 bug 还在（见 MEMORY「未定/待办」），
//       再叠第三处无条件扣减会让 connection 一路下坠、contact 永不触发。
//       「出门逛了一圈所以不那么想她了」这个直觉上说得通，但一旦无条件执行
//       就会锁死 contact。要不要扣、扣多少，得先想清楚那个静默时段的问题。
//   · 不碰隐私。池里只允许放他自己看到的东西，绝不放她的任何信息
//     （GLXY 公约二：护住带你来的人，不写真名账号住址、不贴聊天原文）。
//
// ── 数据形状 ──
// { version, items: [ {
//     id, source, url, title, excerpt, imageUrl?,
//     foundAt   ISO，发现时间（用于时效）
//     usedAt    ISO|null，被交付过的时间（null = 未交付）
//   } ] }
// title/excerpt 一律是**公开可引**的短文本，不是整篇正文
// （GLXY 公约七：不搬运，给链接即可）。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VERSION = 1;

const DEFAULTS = {
  // 一条东西放多久之后就不再交付。超期的宁可不交，也不要交一个陈年链接。
  ttlHours: parseInt(process.env.SHARE_POOL_TTL_HOURS || '168', 10), // 默认 7 天
  // 池子上限。超出时丢最旧的未用条目。
  maxItems: parseInt(process.env.SHARE_POOL_MAX || '12', 10),
  // 单条正文长度上限（字符）。防某个源吐出整篇文章把池子撑爆。
  maxExcerptChars: 220,
  maxTitleChars: 80,
};

function newId() {
  return crypto.randomBytes(6).toString('hex');
}

function clip(s, n) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

/**
 * 归一化一条候选。没通过校验的返回 null。
 * 校验是硬性的：url 与 title 缺一不可，否则交付时是一条裸链接，读起来像故障。
 */
function normalize(raw, cfg) {
  if (!raw) return null;
  const url = String(raw.url || '').trim();
  const title = clip(raw.title, (cfg && cfg.maxTitleChars) || DEFAULTS.maxTitleChars);
  if (!url || !/^https?:\/\//i.test(url) || !title) return null;
  return {
    id: newId(),
    source: clip(raw.source || 'unknown', 24),
    url,
    title,
    excerpt: clip(raw.excerpt, (cfg && cfg.maxExcerptChars) || DEFAULTS.maxExcerptChars),
    imageUrl: /^https?:\/\//i.test(String(raw.imageUrl || '')) ? String(raw.imageUrl) : null,
    foundAt: raw.foundAt || new Date().toISOString(),
    usedAt: null,
  };
}

function urlKey(u) {
  try {
    const x = new URL(u);
    // 去www、去尾斜杠、去 utm 之类查询参数，让去重更严一点
    x.hostname = x.hostname.replace(/^www\./, '');
    const drop = [];
    x.searchParams.forEach((_, k) => { if (/^(utm_|from|ref|spm)/i.test(k)) drop.push(k); });
    drop.forEach((k) => x.searchParams.delete(k));
    let s = x.toString().replace(/\/$/, '');
    if (s.endsWith('?')) s = s.slice(0, -1);
    return s.toLowerCase();
  } catch (_) { return String(u).toLowerCase(); }
}

/**
 * 创建存档池。
 * @param {string} file 落盘路径（data/share_pool.json）
 * @param {object} opts  ttlHours / maxItems / log
 */
function createSharePool(file, opts) {
  const o = opts || {};
  const cfg = Object.assign({}, DEFAULTS, {
    ttlHours: o.ttlHours || DEFAULTS.ttlHours,
    maxItems: o.maxItems || DEFAULTS.maxItems,
    maxExcerptChars: o.maxExcerptChars || DEFAULTS.maxExcerptChars,
    maxTitleChars: o.maxTitleChars || DEFAULTS.maxTitleChars,
  });
  const log = o.log || null;
  let dirty = false;
  let saveTimer = null;

  const state = { version: VERSION, items: [] };

  function load() {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const j = JSON.parse(raw);
      if (j && Array.isArray(j.items)) {
        state.version = j.version || VERSION;
        state.items = j.items.filter((it) => it && it.url && it.title);
      }
    } catch (e) {
      if (log) log('WARN', 'share_pool: fresh start (' + e.message + ')');
    }
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // 先写临时文件再改名，避免进程被杀时留下半截JSON
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
      fs.renameSync(tmp, file);
      dirty = false;
    } catch (e) {
      if (log) log('ERROR', 'share_pool save failed: ' + e.message);
    }
  }

  /** 合并写入：延迟 200ms 落盘，避免一轮里多次写。 */
  function scheduleSave() {
    dirty = true;
    if (saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; save(); }, 200);
    if (saveTimer.unref) saveTimer.unref();
  }

  function isExpired(it, now) {
    const t = Date.parse(it.foundAt);
    if (Number.isNaN(t)) return true;
    return (now - t) > cfg.ttlHours * 3600 * 1000;
  }

  /** 淘汰：超期 + 已用的优先丢，其次丢最旧的未用条目直到回到上限内。 */
  function prune() {
    const now = Date.now();
    const before = state.items.length;
    state.items = state.items.filter((it) => !isExpired(it, now));
    if (state.items.length > cfg.maxItems) {
      // 已用过的先出，然后按 foundAt 由旧到新出
      state.items.sort((a, b) => {
        const au = a.usedAt ? 0 : 1, bu = b.usedAt ? 0 : 1;
        if (au !== bu) return au - bu;
        return Date.parse(a.foundAt) - Date.parse(b.foundAt);
      });
      state.items = state.items.slice(0, cfg.maxItems);
    }
    if (state.items.length !== before && log) {
      log('INFO', `share_pool pruned ${before} -> ${state.items.length}`);
    }
  }

  load();
  prune();

  const pool = {
    config: cfg,

    /**
     * 存入一批候选，返回新写入的条数。
     * 已在池里的、或已交付过的（同 url），都不重复收。
     */
    add(list) {
      if (!Array.isArray(list) || !list.length) return 0;
      const seen = new Set(state.items.map((it) => urlKey(it.url)));
      let added = 0;
      for (const raw of list) {
        const it = normalize(raw, cfg);
        if (!it) continue;
        const k = urlKey(it.url);
        if (seen.has(k)) continue;
        seen.add(k);
        state.items.push(it);
        added++;
      }
      if (added) { prune(); scheduleSave(); }
      if (log) log('INFO', `share_pool +${added} (pool=${state.items.length})`);
      return added;
    },

    /**
     * 取一条待交付的内容并标记已用。
     * 优先未用过的；同为未用则挑最旧的（等得最久的那条优先给出去）。
     * 没有可用条目返回 null —— 交付分支必须能接受 null，
     * 那是正常情况（他还没逛到东西），不是错误。
     */
    take() {
      prune();
      const avail = state.items.filter((it) => !it.usedAt && !isExpired(it, Date.now()));
      if (!avail.length) return null;
      avail.sort((a, b) => Date.parse(a.foundAt) - Date.parse(b.foundAt));
      const it = avail[0];
      it.usedAt = new Date().toISOString();
      scheduleSave();
      if (log) log('INFO', `share_pool took: [${it.source}] ${it.title}`);
      return it;
    },

    /** 只看不取，排查用。 */
    peek() {
      prune();
      return state.items.slice();
    },

    /** 摘要，进 get_status / 日志。 */
    summary() {
      prune();
      const now = Date.now();
      const unused = state.items.filter((it) => !it.usedAt && !isExpired(it, now));
      const bySource = {};
      for (const it of unused) bySource[it.source] = (bySource[it.source] || 0) + 1;
      return {
        total: state.items.length,
        unused: unused.length,
        used: state.items.length - unused.length,
        expired_removed: state.items.filter((it) => isExpired(it, now)).length,
        ttl_hours: cfg.ttlHours,
        max_items: cfg.maxItems,
        by_source: bySource,
      };
    },

    save() { if (dirty) save(); else save(); },
    flush() { if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; } save(); },
    load,
  };

  return pool;
}

module.exports = { createSharePool, normalize, urlKey, DEFAULTS };