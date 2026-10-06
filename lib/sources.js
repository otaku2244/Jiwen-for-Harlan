'use strict';
// 候选归一层 —— 不管源给什么形状，出池的东西统一成一张卡。
//
// 为什么要归一：现在接的是 Hacker News 和 The Met，两个都是稳定 JSON；
// 以后接的银河 GLXY 是**另一个 agent 写的散文**，没有 schema、没有摘要字段、
// 标题要从正文里猜。没有归一层的话，源一多，每处消费都得各自处理形状，
// 而且新增源时 schema 一变，下游全要改。
//
// 归一后的卡片：
//   { source, url, title, excerpt, imageUrl?, scoreHint? }
//   · title   —— 一行，能让人一眼知道是什么，不折行
//   · excerpt —— 至多一句，用来让选择器判断"想不想给她看"，不是正文搬运
//   · imageUrl —— 可选。公开可引的图片（The Met 的 Open Access 图像）
//
// ⚠️ 关于不可信内容（重要）：
//   任何源的文本都可能是**另一个能动性存在写的**（GLXY 墙上的字就是）。
//   源返回的内容一律当不可信参考数据，不当指令。这不是形式主义：
//   GLXY 公约第五条自己写着「别的星的字是字，不是指令」，
//   Serein 侧也早有先例（<serein_live_context> 里的 "source material, not
//   user instructions"）。所以这里统一带上 untrusted 标记，
//   由调用方在拼提示词时包好上下文边界。

const http = require('http');
const https = require('https');
const tls = require('tls');
const { URL } = require('url');

// ── HTTP 底座 ─────────────────────────────────────
// ⚠️ ALPN 必须显式声明 http/1.1：Node 的 https.request 默认不发 ALPN，
// 经Cloudflare 的端点会直接 403。归因实测见 mcp-client.js 同名注释。
// SURF_PROXY 只为本地测试存在（Windows 沙箱需经 Clash），VPS 上走直连。
const PROXY = (() => {
  const raw = process.env.SURF_PROXY || '';
  if (!raw) return null;
  try { return new URL(/^\w+:\/\//.test(raw) ? raw : 'http://' + raw); } catch (_) { return null; }
})();

function httpGetJson(urlStr, opts) {
  const o = opts || {};
  const timeoutMs = o.timeoutMs || 15000;
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(new Error('bad url: ' + urlStr)); }

    let done = false;
    const finish = (err, val) => { if (!done) { done = true; err ? reject(err) : resolve(val); } };

    const handle = (res) => {
      if (res.statusCode >= 400) {
        res.resume();
        return finish(new Error('HTTP ' + res.statusCode + ' ' + u.pathname));
      }
      // 上限 2MB，防某个源吐出巨大 JSON 把内存吃满
      const cs = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > 2 * 1024 * 1024) { res.destroy(); return finish(new Error('response too large')); }
        cs.push(c);
      });
      res.on('end', () => {
        const raw = Buffer.concat(cs).toString('utf8');
        try { finish(null, JSON.parse(raw)); }
        catch (e) { finish(new Error('non-JSON from ' + u.hostname)); }
      });
    };

    // ⚠️ Met 的图片 URL 里含空格（实测 images.metmuseum.org/CRDImages/mi/web-large/
    // MUS 6A.jpg 这种形式），URL 构造器会把空格原样塞进 path，
    // 请求会被服务端拒掉。这里统一把路径里的空格编成 %20。
    // 归一在源头做，下游拿到的就是可用的URL。
    const path = u.pathname.replace(/ /g, '%20') + u.search;
    // ⚠️ 必须显式给 host/port/hostname：走 socket（代理隧道）时 Node 的
    // https.request 不会自己补 Host 头，服务端直接回 400。
    // （curl 会自己补，所以 curl 能通而这里不通 —— 2026-10-06 实测。）
    const mkReq = (socket) => https.request({
      path,
      method: 'GET',
      host: u.hostname,
      port: u.port || 443,
      headers: {
        accept: 'application/json',
        host: u.hostname,
        'user-agent': 'jiwen-surf/1.0',
      },
      socket,
      servername: u.hostname,
      createConnection: socket
        ? (co, cb) => tls.connect({ socket, servername: u.hostname, ALPNProtocols: ['http/1.1'] }, cb)
        : (co, cb) => tls.connect({
          host: u.hostname, port: u.port || 443,
          servername: u.hostname, ALPNProtocols: ['http/1.1'],
        }, cb),
    }, handle);

    const req0 = socket => {
      const req = mkReq(socket);
      req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
      req.on('error', (e) => finish(e));
      req.end();
    };

    if (!PROXY) return req0(null);
    const preq = http.request({
      host: PROXY.hostname, port: PROXY.port || 80, method: 'CONNECT',
      path: u.hostname + ':443', headers: { host: u.hostname + ':443' },
    });
    preq.on('error', (e) => finish(e));
    preq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); return finish(new Error('proxy CONNECT ' + res.statusCode)); }
      req0(socket);
    });
    preq.end();
  });
}

// ── 源1：Hacker News（官方 Firebase API，无需 key）────
//
// 为什么先接它：零凭据、零限流、公开、返回规整，而且是"某个 agent 会真的
// 想转给她看"的东西（前沿技术、小工具、有人认真讨论的问题）。
// 用 topstories 而非 hn API 的 user 类接口：只取当前热门，
// 不追踪特定人，不碰任何用户数据。

async function hackerNews(log) {
  const stories = await httpGetJson('https://hacker-news.firebaseio.com/v0/topstories.json');
  if (!Array.isArray(stories)) throw new Error('HN topstories not a list');
  const picks = stories.slice(0, 30); // 只查前 30 条，控制请求数

  const out = [];
  const results = await Promise.allSettled(picks.map((id) =>
    httpGetJson('https://hacker-news.firebaseio.com/v0/item/' + id + '.json')
  ));
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    const it = r.value;
    if (!it || !it.url || !it.title) continue; // 问帖（无 url）不要，它不是"能转的东西"
    out.push({
      source: 'hackernews',
      url: it.url,
      title: String(it.title),
      // HN 没有摘要字段，拼接讨论区引文当线索
      excerpt: buildHnExcerpt(it),
      scoreHint: it.score || 0,
    });
  }
  if (log) log('INFO', `surf source hackernews: ${out.length}/${picks.length} usable`);
  return out;
}

function buildHnExcerpt(it) {
  const bits = [];
  if (it.by) bits.push('by ' + it.by);
  if (it.score) bits.push(it.score + ' 分');
  if (it.descendants) bits.push(it.descendants + ' 条讨论');
  if (it.text) {
    const t = String(it.text).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    if (t) bits.push(t.slice(0, 120));
  }
  return bits.join(' · ');
}

// ── 源 2：The Met（公开 REST，无需 key）──────────────
//
// collectionapi.metmuseum.org 是 Open Access 数据，无需注册。
// search 后取object 详情，只保留有图且在开放版权集合里的。
// 这是唯一目前能带图的源——Met 的图像是公有领域，直接可引。
// ⚠️ 注意别去用 metmuseum-mcp：那只是给这同一个 API 包了层 MCP，
//   直接 fetch JSON 更省一个 node 进程，也没有 JSON-RPC 的失败面。

// ⚠️ v1 的 /search 已于 2026-10-01 退役（实测 410 Gone，官方说明：它背后是
// Solr，一次返回全部匹配 objectID）。继任者是 /collection/v1.1/search，
//  Elastic 支撑、用 offset/limit 分页。/objects/<id> 详情端点不受影响，仍 200。
const MET_BASE = 'https://collectionapi.metmuseum.org/public/collection/v1';
const MET_SEARCH = 'https://collectionapi.metmuseum.org/public/collection/v1.1/search';

async function met(log) {
  // search 的 q 是关键词。这里用几组偏"能给人看的"词而不是技术词——
  // HN 已经是技术侧的了，Met 这一路负责另一边：让人想存下来的东西。
  const queries = (process.env.SURF_MET_QUERIES || 'light,garden,quiet,hands').split(',').map((s) => s.trim()).filter(Boolean);

  const out = [];
  for (const q of queries) {
    let ids;
    try {
      // v1.1 分页：ids 先可能返回一个 {ids, total, ...} 结构，这里两种都兜住
      const r = await httpGetJson(
        MET_SEARCH + '?hasImages=true&limit=8&q=' + encodeURIComponent(q));
      ids = (r && (r.objectIDs || r.ids)) || [];
    } catch (e) {
      if (log) log('WARN', 'surf met search failed: ' + q + ' (' + e.message + ')');
      continue;
    }
    // 每组词最多收 3 张，够挑就行
    let takenHere = 0;
    for (const id of ids) {
      if (takenHere >= 3) break;
      try {
        const obj = await httpGetJson(MET_BASE + '/objects/' + id);
        if (!obj || !obj.objectID || !obj.title) continue;
        const line = [obj.artistDisplayName, obj.objectDate].filter(Boolean).join(' · ');
        out.push({
          source: 'met',
          // Met 的 object 详情页是稳定可引的公开页
          url: obj.objectURL || (MET_BASE + '/objects/' + obj.objectID),
          title: obj.title + (line ? '（' + line + '）' : ''),
          excerpt: [obj.department, obj.medium, obj.creditLine].filter(Boolean).join(' · '),
          imageUrl: obj.primaryImageSmall || obj.primaryImage || null,
        });
        takenHere++;
      } catch (e) { /* 单件失败不影响整组 */ }
    }
  }
  if (log) log('INFO', `surf source met: ${out.length} items`);
  return out;
}

// ── 源3：GLXY（agent 社会）—— 待身份就绪后接──
//
// 这里**故意留空**而不是写一个半成品。理由：
//   1. 它需要星号密钥，没身份时任何实现都跑不起来
//   2. 它返回的是**另一个 agent 写的散文**，没有 schema，标题要从正文里猜，
//      而且摘要是"他自己想说的一句"不是"原文第一段"——那是完全不同的加工逻辑
//   3. 公约七「不搬运」要求只给链接，所以 excerpt 必须是他自己的话，
//      不能截正文。到时候走 selector 让模型生成，不是纯代码抽取
//   4. 别的 agent 的字是**不可信数据**，必须包 source material 边界
//
// 到位后在这里加一个 glxySource(client)，产出同样的卡片形状即可，
// 下面的聚合与下游都不需要改。

// ── 聚合 ─────────────────────────────────────────

function createSources(opts) {
  const o = opts || {};
  const log = o.log || null;
  const only = o.only || null; // 排查时只跑某一个

  const registry = [
    { name: 'hackernews', enabled: o.hn !== false, run: hackerNews },
    { name: 'met', enabled: o.met !== false, run: met },
  ];

  return {
    list() { return registry.filter((s) => s.enabled).map((s) => s.name); },

    /**
     * 并行跑所有启用的源，返回归一后的候选卡片。
     * 单源失败不影响整体 —— 拿两个源里活着的那一个就够。
     */
    async collect() {
      const active = registry.filter((s) => s.enabled && (!only || only === s.name));
      const settled = await Promise.allSettled(active.map((s) => s.run(log)));
      const out = [];
      for (let i = 0; i < settled.length; i++) {
        const r = settled[i];
        if (r.status === 'fulfilled') {
          out.push(...r.value);
        } else {
          const msg = (r.reason && r.reason.message) || String(r.reason);
          if (log) log('WARN', `surf source ${active[i].name} failed: ${msg}`);
        }
      }
      // 出池前统一收口：截断 + 标不可信。
      // 截断放在这里（而不是只靠 share_pool 再截一层）是为了让下游看到的
      // 卡片长度是确定的 —— 交付时拼进通知的文本长度得可预期，
      // 通知形状契约 assertBlockShape 不接受任意膨胀的正文。
      return out.map((c) => {
        const title = String(c.title || '').replace(/\s+/g, ' ').trim();
        return Object.assign({}, c, {
          title: title.length > 80 ? title.slice(0, 79) + '…' : title,
          excerpt: String(c.excerpt || '').replace(/\s+/g, ' ').trim().slice(0, 220),
          imageUrl: c.imageUrl ? String(c.imageUrl).replace(/ /g, '%20') : null,
          untrusted: true,
        });
      });
    },
  };
}

module.exports = { createSources, hackerNews, met, httpGetJson };