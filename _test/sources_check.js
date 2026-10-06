'use strict';
// 源实测：真连 HN 与 The Met，验归一后的卡片形状
// 用法：SURF_PROXY=http://127.0.0.1:7897 node _test/sources_check.js

const { createSources, httpGetJson } = require('../lib/sources.js');

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}

const log = (l, m) => console.log('       [' + l + '] ' + m);

(async () => {
  console.log('');

  // ── 1. ALPN 归因：确认我们的 HTTP 底座能过 Cloudflare ──
  console.log('[1] HTTP 底座（含 ALPN）');
  try {
    const n = await httpGetJson('https://hacker-news.firebaseio.com/v0/maxitem.json');
    check('HN 可达', typeof n === 'number', JSON.stringify(n).slice(0, 40));
  } catch (e) {
    check('HN 可达', false, e.message);
  }

  // ── 2. 聚合 ──
  console.log('');
  console.log('[2] 收集候选');
  const src = createSources({ log });
  console.log('       启用的源: ' + src.list().join(', '));
  const t0 = Date.now();
  const items = await src.collect();
  console.log('       用时 ' + (Date.now() - t0) + 'ms，共 ' + items.length + ' 条');
  check('收集到候选', items.length > 0);

  console.log('');
  console.log('[3] 卡片形状校验');
  const bySource = {};
  for (const it of items) bySource[it.source] = (bySource[it.source] || 0) + 1;
  console.log('       按源: ' + JSON.stringify(bySource));

  const bad = items.filter((it) =>
    !it || typeof it.url !== 'string' || !/^https?:\/\//.test(it.url) ||
    typeof it.title !== 'string' || !it.title.trim()
  );
  check('每条都有 url + title', bad.length === 0, JSON.stringify(bad[0] || {}).slice(0, 120));
  check('每条都标了 untrusted', items.every((it) => it.untrusted === true));
  check('标题长度合理（<80）', items.every((it) => it.title.length <= 80),
    'max=' + Math.max(...items.map((i) => i.title.length)));
  check('摘要长度合理（<=220）', items.every((it) => (it.excerpt || '').length <= 220),
    'max=' + Math.max(...items.map((i) => (i.excerpt || '').length)));
  check('imageUrl 只有 http(s)',
    items.every((it) => it.imageUrl === null || /^https?:\/\//.test(it.imageUrl)));

  // ── 4. 抽样 ──
  console.log('');
  console.log('[4] 抽样（每源 2 条）');
  for (const name of Object.keys(bySource)) {
    const sample = items.filter((it) => it.source === name).slice(0, 2);
    for (const s of sample) {
      console.log('       [' + name + '] ' + s.title);
      console.log('              ' + String(s.url).slice(0, 88));
      if (s.excerpt) console.log('              摘要: ' + String(s.excerpt).slice(0, 88));
      if (s.imageUrl) console.log('              图:  ' + String(s.imageUrl).slice(0, 78));
    }
  }

  // ── 5. 单源失败不影响整体 ──
  console.log('');
  console.log('[5] 单源失败隔离');
  const only = createSources({ log: null, only: 'hackernews' });
  const one = await only.collect();
  check('only=hn 只跑 HN', one.every((it) => it.source === 'hackernews'), JSON.stringify(bySource));
  check('HN 单独跑也有结果', one.length > 0, String(one.length));

  console.log('');
  console.log(pass + ' pass / ' + fail + ' fail');
  process.exit(fail ? 1 : 0);
})();