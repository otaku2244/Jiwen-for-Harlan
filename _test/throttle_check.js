'use strict';
// 节流逻辑专项：确认"数值微变"能触发重注，而非只比渲染文本。
// 用法：node _test/throttle_check.js
//
// 背景：旧实现比较 block 字符串，而档位词粒度粗
//       （labelValence(-0.03) 与 labelValence(0) 都是"中性"），
//       导致 30 分钟窗口内状态漂移但注入被静默跳过。

const path = require('path');
const { createToneGrid } = require('../vendor/tone-grid.js');
const { createToneWrapper } = require('../lib/tone-wrap.js');
const { buildInjectionBlock } = require('../lib/inject-text.js');

const cfg = JSON.parse(require('fs').readFileSync(
  path.join(__dirname, '..', 'config', 'tone-harlan.json'), 'utf8'));
const toneGrid = createToneWrapper(
  createToneGrid({ profiles: cfg.profiles, urgencyBoost: cfg.urgencyBoost }),
  cfg.contactOverride
);

// ── 与 bridge.js 中 shouldInject 相同的实现（同步维护）──
const THROTTLE_MS = 1800 * 1000;
let lastInjectSig = null;
let lastInjectAt = 0;
function shouldInject(block, state) {
  const now = Date.now();
  const sig = state
    ? [state.connection, state.pride, state.valence, state.arousal]
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

const CASES = [
  {
    name: '① 首轮 → 必注',
    st: { connection: 0, pride: 0, valence: 0, arousal: 0 },
    want: true,
  },
  {
    name: '② 文本相同、valence 0 → -0.03 → 必须重注（旧逻辑会漏）',
    st: { connection: 0, pride: 0, valence: -0.03, arousal: 0 },
    want: true,
  },
  {
    name: '③ 完全没动 → 不注',
    st: { connection: 0, pride: 0, valence: -0.03, arousal: 0 },
    want: false,
  },
  {
    name: '④ arousal 0 → 0.02 → 重注',
    st: { connection: 0, pride: 0, valence: -0.03, arousal: 0.02 },
    want: true,
  },
  {
    name: '⑤ 只在小数点后第三位动 → 2 位精度下视为没变 → 不注',
    st: { connection: 0, pride: 0, valence: -0.031, arousal: 0.02 },
    want: false,
  },
];

let pass = 0;
console.log('节流逻辑专项\n');
for (const c of CASES) {
  const block = buildInjectionBlock(c.st, toneGrid);
  const got = shouldInject(block, c.st);
  const ok = got === c.want;
  if (ok) pass++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${c.name}`);
  console.log(`        期望=${c.want} 实得=${got}  块首行=${block.split('\n')[1] || '(空)'}`);
}

console.log(`\n${pass}/${CASES.length} 通过`);

// 附：渲染文本是否真的相同（证明问题根因）
const bA = buildInjectionBlock({ connection: 0, pride: 0, valence: 0, arousal: 0 }, toneGrid);
const bB = buildInjectionBlock({ connection: 0, pride: 0, valence: -0.03, arousal: 0 }, toneGrid);
console.log(`\n根因佐证：valence 0 与 -0.03 的渲染块是否逐字相同 = ${bA === bB}`);
console.log('（为 true 即说明旧逻辑必然漏注，而新逻辑靠数值签名拦住了它）');

process.exit(pass === CASES.length ? 0 : 1);
