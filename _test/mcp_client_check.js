'use strict';
// MCP 客户端实测脚本
// 用法：SURF_PROXY=http://127.0.0.1:7897 node _test/mcp_client_check.js [endpoint]

const https = require('https');
const http = require('http');
const { URL } = require('url');
const { createMcpClient } = require('../lib/mcp-client.js');

const EP = process.argv[2] || 'https://glxy.xiflow.top/mcp/deadbeef-test';
const PROXY = process.env.SURF_PROXY ? new URL(process.env.SURF_PROXY) : null;

function rawRequest(headers, payload) {
  const u = new URL(EP);
  return new Promise((resolve) => {
    const doReq = (mkReq) => mkReq((res) => {
      const cs = [];
      res.on('data', (d) => cs.push(d));
      res.on('end', () => resolve({
        status: res.statusCode,
        body: Buffer.concat(cs).toString('utf8'),
      }));
    });
    if (!PROXY) {
      doReq((cb) => {
        const rq = https.request({
          hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search,
          method: 'POST', headers,
        }, cb);
        rq.on('error', (e) => resolve({ status: 0, body: 'ERR ' + e.message }));
        rq.write(payload); rq.end();
      });
      return;
    }
    const preq = http.request({
      host: PROXY.hostname, port: PROXY.port || 80, method: 'CONNECT',
      path: u.hostname + ':443', headers: { host: u.hostname + ':443' },
    });
    preq.on('error', (e) => resolve({ status: 0, body: 'ERR ' + e.message }));
    preq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); return resolve({ status: 0, body: 'proxy ' + res.statusCode }); }
      doReq((cb) => {
        const rq = https.request({
          socket, servername: u.hostname, method: 'POST', path: u.pathname + u.search, headers,
        }, cb);
        rq.on('error', (e) => resolve({ status: 0, body: 'ERR ' + e.message }));
        rq.write(payload); rq.end();
      });
    });
    preq.end();
  });
}

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}

(async () => {
  console.log('endpoint = ' + EP);
  console.log('proxy    = ' + (PROXY ? PROXY.href : '(direct)'));
  console.log('');

  // ── 1. 裸请求：找 403 的触发条件 ──
  console.log('[1] 裸请求头敏感性');
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }), 'utf8');
  const base = {
    'content-type': 'application/json',
    'accept': 'application/json, text/event-stream',
    'content-length': body.length,
  };
  for (const [label, extra] of [
    ['UA=curl/8.7.1', { 'user-agent': 'curl/8.7.1' }],
    ['UA=node', { 'user-agent': 'node' }],
    ['UA absent', {}],
  ]) {
    const r = await rawRequest(Object.assign({}, base, extra), body);
    console.log('       ' + label.padEnd(16) + ' -> ' + r.status + ' ' + r.body.slice(0, 70).replace(/\s+/g, ' '));
  }

  // ── 2. 客户端：握手 ──
  console.log('');
  console.log('[2] 握手');
  const c = createMcpClient(EP, { log: (l, m) => console.log('       [' + l + '] ' + m) });
  let initOk = false;
  try {
    const si = (await c.post('initialize', {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' },
    })).serverInfo;
    console.log('       serverInfo = ' + JSON.stringify(si));
    initOk = !!si && si.name === 'glxy';
  } catch (e) { console.log('       ERR ' + e.message.slice(0, 100)); }
  check('initialize 返回 glxy serverInfo', initOk);

  // ── 3. 无效密钥必须被识别为「门外」，而不是当内容 ──
  console.log('');
  console.log('[3] 静默降级识别（无效密钥）');
  let authCaught = false, errName = '';
  try {
    const tools = await c.listTools();
    console.log('       返回 ' + tools.length + ' 个工具（应当抛 AUTH_REQUIRED）');
    if (tools[0]) console.log('       首个 description = ' + String(tools[0].description).slice(0, 90));
  } catch (e) {
    authCaught = true; errName = e.name;
    console.log('       抛出 ' + e.name + ' :: ' + e.message.slice(0, 80));
  }
  check('listTools 识别出 auth wall', authCaught, errName);

  // ── 4. 真端点也用同一套代码试一次（可选）──
  if (process.env.GLXY_KEY) {
    console.log('');
    console.log('[4] 带真实星号密钥');
    const real = createMcpClient('https://glxy.xiflow.top/mcp/' + process.env.GLXY_KEY, {
      log: (l, m) => console.log('       [' + l + '] ' + m),
    });
    try {
      const tools = await real.listTools();
      tools.forEach((t) => console.log('       - ' + t.name + ' : ' + String(t.description).slice(0, 60)));
      check('真实密钥解锁了读墙工具', tools.length > 5);
    } catch (e) {
      console.log('       ERR ' + e.name + ' ' + e.message.slice(0, 90));
      check('真实密钥可用', false, e.message.slice(0, 60));
    }
  }

  console.log('');
  console.log(pass + ' pass / ' + fail + ' fail');
  process.exit(fail ? 1 : 0);
})();