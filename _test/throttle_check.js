'use strict';
// 节流逻辑专项：确认"数值微变"能触发重注，而非只比渲染文本。
// 用法：node _test/throttle_check.js
//
// 背景：旧实现比较 block 字符串，而块文本是**离散格**
//       （v=0.31 与 v=0.60 落在同一簇同一 pride 档 → 正文逐字相同），
//       导致 30 分钟窗口内状态漂移但注入被静默跳过。

const path = require('path');
const { createToneGrid } = require('../vendor/tone-grid.js');
const { createDescriber } = require('../lib/describe.js');
const { buildInjectionBlock } = require('../lib/inject-text.js');

const cfg = JSON.parse(require('fs').readFileSync(
  path.join(__dirname, '..', 'config', 'tone-harlan.json'), 'utf8'));
const toneGrid = createToneGrid({ profiles: cfg.profiles, urgencyBoost: cfg.urgencyBoost });
const desc = createDescriber(cfg.describe);

// 描述层是 buildXxx 新增的末位参数 —— 包一层，免得每个调用点手写。
const bN = (st, g, opts, so, po) => buildProactiveNotice(st, g, opts, so, po, desc);
const bI = (st, g) => buildInjectionBlock(st, g, desc);

// ── 与 bridge.js 中 shouldInject 相同的实现（同步维护）──
// ⚠️ 五个轴都要在：immersion 自 2026-10-08 起也是块文本的一部分（描述层段4 读它），
//    漏掉它 = 冲浪跑完、段4 该从「没在做什么特别的事。」变成「刚才在上网冲浪。」
//    却被节流静默吃掉。用例 ⑥ 就是钉这一条。
const THROTTLE_MS = 1800 * 1000;
let lastInjectSig = null;
let lastInjectAt = 0;
function shouldInject(block, state) {
  const now = Date.now();
  const sig = state
    ? [state.connection, state.pride, state.valence, state.arousal, state.immersion]
        .map((x) => (Number(x) || 0).toFixed(2)).join(',')
    : block;
  const changed = sig !== lastInjectSig;
  const expired = (now - lastInjectAt) > THROTTLE_MS;
  if (changed || expired) {
    lastInjectSig = sig;
    lastInjectAt = now;
    return true;
  }
  return false;
}

const ACT = { type: 'search', label: '上网冲浪', at: new Date().toISOString() };

const CASES = [
  {
    name: '① 首轮 → 必注',
    st: { connection: 0, pride: 0, valence: 0, arousal: 0, immersion: 0 },
    want: true,
  },
  {
    name: '② 文本相同、valence 0 → -0.03 → 必须重注（旧逻辑会漏）',
    st: { connection: 0, pride: 0, valence: -0.03, arousal: 0, immersion: 0 },
    want: true,
  },
  {
    name: '③ 完全没动 → 不注',
    st: { connection: 0, pride: 0, valence: -0.03, arousal: 0, immersion: 0 },
    want: false,
  },
  {
    name: '④ arousal 0 → 0.02 → 重注',
    st: { connection: 0, pride: 0, valence: -0.03, arousal: 0.02, immersion: 0 },
    want: true,
  },
  {
    name: '⑤ 只在小数点后第三位动 → 2 位精度下视为没变 → 不注',
    st: { connection: 0, pride: 0, valence: -0.031, arousal: 0.02, immersion: 0 },
    want: false,
  },
  {
    name: '⑥ 只有 immersion 动（冲浪跑完 0 → 0.40）→ 必须重注（段4 变了）',
    st: { connection: 0, pride: 0, valence: -0.031, arousal: 0.02, immersion: 0.4, lastActivity: ACT },
    want: true,
  },
];

let pass = 0;
console.log('节流逻辑专项\n');
for (const c of CASES) {
  const block = bI(c.st, toneGrid);
  const got = shouldInject(block, c.st);
  const ok = got === c.want;
  if (ok) pass++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${c.name}`);
  console.log(`        期望=${c.want} 实得=${got}  块首行=${block.split('\n')[1] || '(空)'}`);
}

console.log(`\n${pass}/${CASES.length} 通过`);

// 附：渲染文本是否真的相同（证明问题根因）
const bA = bI({ connection: 0, pride: 0, valence: 0, arousal: 0, immersion: 0 }, toneGrid);
const bB = bI({ connection: 0, pride: 0, valence: -0.03, arousal: 0, immersion: 0 }, toneGrid);
console.log(`\n根因佐证：valence 0 与 -0.03 的渲染块是否逐字相同 = ${bA === bB}`);
console.log('（为 true 即说明旧逻辑必然漏注，而新逻辑靠数值签名拦住了它）');

// 附：immersion 单独变化 —— 四轴签名不动，只有块文本变，只能靠 immersion 在签名里拦住
const sMid = { connection: 0, pride: 0, valence: -0.031, arousal: 0.02, immersion: 0 };
const sBusy = { connection: 0, pride: 0, valence: -0.031, arousal: 0.02, immersion: 0.4, lastActivity: ACT };
const bC = bI(sMid, toneGrid);
const bD = bI(sBusy, toneGrid);
const line4 = (b) => b.split('\n').find((l) => /没在做什么|刚才在/.test(l)) || '(不出段4)';
console.log(`\n段4 佐证：immersion 0 → 0.4 时块文本是否变了 = ${bC !== bD}`);
console.log(`  immersion 0.00 段4 = ${line4(bC)}`);
console.log(`  immersion 0.40 段4 = ${line4(bD)}`);

process.exit(pass === CASES.length ? 0 : 1);
