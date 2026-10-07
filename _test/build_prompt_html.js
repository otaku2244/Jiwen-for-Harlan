'use strict';
// 由 all-prompts.txt 生成可折叠的 HTML 验收清单
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'all-prompts.txt'), 'utf8');
const lines = src.split('\n');

const CLUSTER_CN = {
  excited: '兴奋（v高 a高）', content: '满足慵懒（v高 a低）', pleased: '暗自愉悦（v高 a中）',
  agitated: '烦躁带刺（v低 a高）', depressed: '低落空荡（v低 a低）', sullen: '阴郁生闷气（v低 a中）',
  restless: '躁动不安（v中 a高）', calm: '平静淡然（v中 a低）', neutral: '中性（v中 a中）',
};

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// 解析
const clusters = [];
let cur = null, curCase = null;
let mode = null;

for (const raw of lines) {
  const line = raw;
  const mClu = line.match(/^## 情绪簇：(\w+)\s+\(valence=([\d.-]+), arousal=([\d.-]+)\)/);
  if (mClu) {
    cur = { key: mClu[1], v: mClu[2], a: mClu[3], cases: [] };
    clusters.push(cur);
    continue;
  }
  if (!cur) continue;
  // ⚠️ 2026-10-08 起行格式里去掉了「× urgency (c=…)」—— connection 不再进 45 格。
  const mCase = line.match(/^── pride 档 (\d) \(p=([\d.-]+)\)(.*)──/);
  if (mCase) {
    curCase = { tier: mCase[1], p: mCase[2], reactive: [], proactive: [] };
    cur.cases.push(curCase);
    mode = null;
    continue;
  }
  if (!curCase) continue;
  if (/^\s*\[reactive\]/.test(line)) { mode = 'reactive'; continue; }
  if (/^\s*\[proactive\]/.test(line)) { mode = 'proactive'; continue; }
  if (mode && /^\s{4}\S/.test(line)) {
    curCase[mode].push(line.trim());
    continue;
  }
}

let body = '';
for (const c of clusters) {
  body += `<section class="cluster">`;
  body += `<h2>${esc(CLUSTER_CN[c.key] || c.key)} <span class="mono">v=${c.v} a=${c.a}</span></h2>`;
  for (const cs of c.cases) {
    body += `<details class="case">`;
    body += `<summary><b>pride ${cs.tier}</b> <span class="mono">p=${cs.p}</span></summary>`;
    body += `<div class="pair">`;
    body += `<div class="col"><div class="tag">reactive · 此刻块</div>${cs.reactive.map((t) => `<p>${esc(t)}</p>`).join('') || '<p class="empty">（空）</p>'}</div>`;
    body += `<div class="col"><div class="tag">proactive · 主动唤醒</div>${cs.proactive.map((t) => `<p>${esc(t)}</p>`).join('') || '<p class="empty">（空）</p>'}</div>`;
    body += `</div></details>`;
  }
  body += `</section>`;
}

const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>积温桥 · 提示词全量验收清单</title>
<style>
:root{--bg:#fff;--fg:#1a1a1a;--mut:#6b7280;--line:#e5e7eb;--acc:#b91c1c;--soft:#f9fafb;}
*{box-sizing:border-box}
body{margin:0;padding:28px 20px;background:var(--bg);color:var(--fg);
 font:14px/1.7 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;max-width:1180px;margin:0 auto}
h1{font-size:20px;margin:0 0 4px}
.sub{color:var(--mut);font-size:13px;margin-bottom:20px}
.legend{background:var(--soft);border:1px solid var(--line);border-radius:8px;padding:12px 16px;margin-bottom:22px;font-size:13px}
.legend b{color:var(--acc)}
.legend li{margin:3px 0}
.cluster{margin-bottom:26px}
.cluster h2{font-size:15px;margin:0 0 8px;padding:7px 12px;background:#111;color:#fff;border-radius:6px}
.mono{font-family:ui-monospace,Consolas,monospace;font-size:12px;color:var(--mut);font-weight:400}
.cluster h2 .mono{color:#bbb}
.case{border:1px solid var(--line);border-radius:6px;margin-bottom:6px;background:var(--bg)}
summary{cursor:pointer;padding:7px 12px;font-size:13px;list-style:none;user-select:none}
summary::-webkit-details-marker{display:none}
summary::before{content:"▸";display:inline-block;width:14px;color:var(--mut)}
details[open] > summary::before{content:"▾"}
summary:hover{background:rgba(0,0,0,.02)}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:0;border-top:1px solid var(--line)}
.col{padding:10px 14px}
.col + .col{border-left:1px solid var(--line)}
.tag{font-size:11px;letter-spacing:.5px;text-transform:uppercase;color:var(--mut);margin-bottom:6px}
.col p{margin:0 0 6px;font-size:13px}
.col p:last-child{margin-bottom:0}
.empty{color:#c0c0c0;font-style:italic}
@media(max-width:760px){.pair{grid-template-columns:1fr}.col + .col{border-left:0;border-top:1px solid var(--line)}}
</style></head><body>
<h1>积温桥 · 提示词全量验收清单</h1>
<div class="sub">9 情绪簇 × 5 pride 档 = 45 格，每格含 reactive / proactive 两条 = 90 条。点击任意行展开。</div>
<div class="legend">
  <ul style="margin:0;padding-left:18px">
    <li><b>reactive</b> — 用户开口时，注入到最后一条消息前面的「此刻块」风格指令</li>
    <li><b>proactive</b> — 阈值触发主动唤醒时，通知正文里的行为指令</li>
    <li>每格 = 一条 45 格正文。<b>2026-10-08 起 connection 不再进 45 格</b> —— 它的 4 档只作用在描述层第 1 段</li>
    <li>已退役：<b>urgency 尾注</b>（与描述层第 1 段同轴同义）、<b>开口动机覆盖</b>（会把整条 45 格顶掉）</li>
  </ul>
</div>
${body}
</body></html>`;

const out = path.join(__dirname, '..', '提示词全量清单.html');
fs.writeFileSync(out, html, 'utf8');
console.log('已写出: ' + out);
console.log('簇数: ' + clusters.length + '，格数: ' + clusters.reduce((n, c) => n + c.cases.length, 0));
