'use strict';
// share_pool 实测：时效、容量、去重、交付顺序、隐私约束
// 用法：node _test/share_pool_check.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSharePool, urlKey } = require('../lib/share-pool.js');

const TMP = path.join(os.tmpdir(), 'jiwen_share_pool_test.json');

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}
function clean() { try { fs.unlinkSync(TMP); } catch (_) {} }

function item(url, source, title, hoursAgo) {
  const h = Number.isFinite(hoursAgo) ? hoursAgo : 0;
  return {
    url,
    source: source || 'test',
    title: title || ('条目 ' + url),
    excerpt: '摘要',
    foundAt: new Date(Date.now() - h * 3600 * 1000).toISOString(),
  };
}

console.log('file = ' + TMP);
console.log('');

// ── 1. 基本存取 ──
console.log('[1] 基本存取');
clean();
let pool = createSharePool(TMP, {});
let n = pool.add([item('https://a.example.com/1'), item('https://b.example.com/2')]);
check('一次写入 2 条', n === 2, 'got ' + n);
check('summary 报unused=2', pool.summary().unused === 2, JSON.stringify(pool.summary()));
const taken = pool.take();
check('take 返回一条', !!taken && !!taken.url);
check('take 后 usedAt 已置', !!taken.usedAt);
check('summary 报 unused=1', pool.summary().unused === 1, JSON.stringify(pool.summary()));
pool.flush();

console.log('');
console.log('[2] 持久化');
const re = createSharePool(TMP, {});
check('重载后 total=2', re.summary().total === 2, JSON.stringify(re.summary()));
check('重载后 unused=1（已交付那条没复活）', re.summary().unused === 1, JSON.stringify(re.summary()));

console.log('');
console.log('[3] 去重');
clean();
pool = createSharePool(TMP, {});
n = pool.add([
  item('https://x.example.com/p'),
  item('https://www.x.example.com/p'),      // 差 www
  item('https://x.example.com/p/'),         // 差尾斜杠
  item('https://x.example.com/p?utm_source=x'), // 差 utm
  item('https://x.example.com/other'),      // 真新的
]);
check('5 条进去只留 2 条（归一化去重生效）', n === 2, 'got ' + n);
const keys = pool.peek().map((i) => urlKey(i.url));
check('同一 url 只出现一次', new Set(keys).size === keys.length, JSON.stringify(keys));

console.log('');
console.log('[4] 交付顺序：最旧的先给');
clean();
pool = createSharePool(TMP, {});
pool.add([item('https://old.example.com/', 'test', '旧的', 10)]);
pool.add([item('https://new.example.com/', 'test', '新的', 1)]);
const t1 = pool.take();
check('先给最旧那条', t1 && /old\.example\.com/.test(t1.url), t1 && t1.url);
const t2 = pool.take();
check('第二次给剩下那条', t2 && /new\.example\.com/.test(t2.url), t2 && t2.url);
check('空池 take 返回 null', pool.take() === null);

console.log('');
console.log('[5] 时效');
clean();
pool = createSharePool(TMP, { ttlHours: 24, maxItems: 50 });
pool.add([item('https://fresh.example.com/', 'test', '新鲜的', 1)]);
pool.add([item('https://stale.example.com/', 'test', '陈旧的', 72)]);
const avail = pool.peek().filter((i) => !i.usedAt).map((i) => i.url);
check('超期条目被淘汰', avail.length === 1 && /fresh/.test(avail[0]), JSON.stringify(avail));
check('取出来的是新鲜的', /fresh/.test((pool.take() || {}).url || ''));

console.log('');
console.log('[6] 容量上限');
clean();
pool = createSharePool(TMP, { maxItems: 3, ttlHours: 999 });
for (let i = 0; i < 8; i++) pool.add([item('https://cap.example.com/' + i, 'test', 'c' + i, 8 - i)]);
check('池子不超过上限', pool.summary().total === 3, JSON.stringify(pool.summary()));
const urls = pool.peek().map((i) => i.url).sort();
check('留的是最旧三条（最新那条先进先出）', urls[0] === 'https://cap.example.com/0', JSON.stringify(urls));

console.log('');
console.log('[7] 硬校验：不合格条目不入池');
clean();
pool = createSharePool(TMP, {});
n = pool.add([
  { url: '', title: '没有url' },
  { url: 'ftp://bad.example.com', title: '非http' },
  { url: 'https://ok.example.com/', title: '' },
  { url: 'not a url', title: '不是url' },
  { url: 'https://good.example.com/', title: '合格', excerpt: 'e' },
]);
check('只收 1 条合格项', n === 1, 'got ' + n);

console.log('');
console.log('[8] 隐私：标题与摘要被截断，不留整篇');
clean();
pool = createSharePool(TMP, { maxExcerptChars: 50, maxTitleChars: 20 });
pool.add([{ url: 'https://long.example.com/', title: 'T'.repeat(200), excerpt: 'E'.repeat(500) }]);
const it = pool.peek()[0];
check('标题被截断', it.title.length <= 20, String(it.title.length));
check('摘要被截断', it.excerpt.length <= 50, String(it.excerpt.length));
check('imageUrl 非 http 归null', pool.add([{ url: 'https://i.example.com/', title: 't', imageUrl: 'javascript:alert(1)' }]) === 1
  && pool.peek().find((x) => /i\.example/.test(x.url)).imageUrl === null);

console.log('');
console.log('[9] summary 明细');
console.log('       ' + JSON.stringify(pool.summary()));

clean();
console.log('');
console.log(pass + ' pass / ' + fail + ' fail');
process.exit(fail ? 1 : 0);