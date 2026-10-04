'use strict';
// 限流规则探测 —— 直接对 agnes 端点打请求，测出：
//   ① 突发上限是多少（连续打到 429 为止）
//   ② 是"每分钟 N 次"还是"每小时 N 次"（看 429 文案 + 恢复时间）
//   ③ 429 后多久恢复
//
// 跑法：LLM_KEY=... node _test/ratelimit_probe.js [--burst 20] [--wait 70]
//
// 注意：本脚本故意撞限流，会消耗额度。只跑一次。

const https = require('https');
const http = require('http');
const path = require('path');
const { loadEnvFile } = require('../lib/env.js');

loadEnvFile(path.join(__dirname, '..', '.env'));

const cfg = {
  llmBase: process.env.LLM_BASE || 'https://apihub.agnes-ai.com/v1',
  llmKey: process.env.LLM_KEY || '',
  llmModel: process.env.LLM_MODEL || 'agnes-3.0-flash',
};

if (!cfg.llmKey) { console.error('缺少 LLM_KEY'); process.exit(2); }

// 极小的探针请求：只问 1+1，压到最低 token 消耗
function ping() {
  return new Promise((resolve) => {
    const u = new URL(cfg.llmBase + '/chat/completions');
    const lib = u.protocol === 'https:' ? https : http;
    const payload = Buffer.from(JSON.stringify({
      model: cfg.llmModel,
      temperature: 0,
      max_tokens: 4,
      messages: [{ role: 'user', content: '1+1=?只回数字' }],
    }), 'utf8');

    const t0 = Date.now();
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + cfg.llmKey,
        'content-length': Buffer.byteLength(payload),
      },
    }, (res) => {
      // 关键：抓限流相关响应头
      const hdrs = {
        retryAfter: res.headers['retry-after'] || null,
        remainingReq: res.headers['x-ratelimit-remaining-requests']
          || res.headers['x-ratelimit-remaining'] || null,
        limitReq: res.headers['x-ratelimit-limit-requests']
          || res.headers['x-ratelimit-limit'] || null,
        resetReq: res.headers['x-ratelimit-reset-requests']
          || res.headers['x-ratelimit-reset'] || null,
        remainingTok: res.headers['x-ratelimit-remaining-tokens'] || null,
        limitTok: res.headers['x-ratelimit-limit-tokens'] || null,
        allHeaders: Object.keys(res.headers).filter((k) => k.includes('rate') || k.includes('limit') || k.includes('retry')),
      };
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({
          code: res.statusCode,
          ms: Date.now() - t0,
          body: Buffer.concat(chunks).toString('utf8').slice(0, 300),
          hdrs,
        });
      });
    });
    req.on('error', (e) => resolve({ code: 0, ms: Date.now() - t0, body: 'ERR ' + e.message, hdrs: {} }));
    req.write(payload);
    req.end();
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

(async () => {
  const argBurst = process.argv.indexOf('--burst');
  const BURST = argBurst !== -1 ? parseInt(process.argv[argBurst + 1], 10) : 20;
  const argWait = process.argv.indexOf('--wait');
  const WAIT_S = argWait !== -1 ? parseInt(process.argv[argWait + 1], 10) : 0;

  console.log('限流探测 | model=' + cfg.llmModel + ' base=' + cfg.llmBase);
  console.log('突发上限探测：连续打 ' + BURST + ' 次，间隔 1.5s\n');

  let okCount = 0;
  let firstErrorAt = -1;
  const seen429Bodies = new Set();
  const headerSample = [];

  for (let i = 1; i <= BURST; i++) {
    const r = await ping();
    const tag = r.code === 200 ? 'OK ' : (r.code + ' ');
    if (r.code === 200) okCount++;
    else if (firstErrorAt === -1) firstErrorAt = i;

    if (r.code !== 200) seen429Bodies.add(r.code + '|' + r.body.slice(0, 200).replace(/\s+/g, ' '));
    if (r.hdrs.allHeaders.length && headerSample.length < 3) {
      headerSample.push({ at: i, code: r.code, rateHeaders: r.hdrs.allHeaders });
    }

    console.log(`#${String(i).padStart(2)} ${tag}${r.ms}ms` + (r.code === 200 ? '' : '  ' + r.body.slice(0, 160).replace(/\s+/g, ' ')));
  }

  console.log('\n════════ 结果 ════════');
  console.log('成功次数: ' + okCount + ' / ' + BURST);
  console.log('首次失败于第 ' + (firstErrorAt === -1 ? '（未失败）' : firstErrorAt) + ' 次');
  if (headerSample.length) {
    console.log('限流相关响应头样本:');
    for (const h of headerSample) console.log('  at #' + h.at + ' code=' + h.code + ' → ' + JSON.stringify(h.rateHeaders));
  }
  if (seen429Bodies.size) {
    console.log('\n错误响应文案（去重）:');
    for (const b of seen429Bodies) console.log('  ' + b);
  }

  if (WAIT_S > 0 && firstErrorAt !== -1) {
    console.log('\n等待 ' + WAIT_S + 's 后重测一次（判断是分钟级还是小时级窗口）...');
    await sleep(WAIT_S * 1000);
    const r = await ping();
    console.log('恢复测试: ' + r.code + ' ' + r.body.slice(0, 200).replace(/\s+/g, ' '));
  }
})().catch((e) => { console.error(e); process.exit(1); });
