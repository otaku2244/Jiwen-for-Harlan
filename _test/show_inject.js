'use strict';
// 打印「模型实际看到的注入块」——按给定状态渲染。
// 用法（在 jiwen-bridge 目录下）: node _test/show_inject.js
//
// 目的：验证簇名（pleased / content / …）到底有没有进入模型可见文本。
// 构造与 bridge.js 完全一致：createToneGrid({profiles, urgencyBoost})
// ⚠️ 参数名是 urgencyBoost（不是 urgency）—— vendor createToneGrid 只认 opts.urgencyBoost，
//    写成 urgency 会静默回落成 DEFAULT_URGENCY，注入块里就会出现 vendor 的模板文案。

const fs = require('fs');
const path = require('path');
const { createToneGrid } = require('../vendor/tone-grid.js');
const { createDescriber } = require('../lib/describe.js');
const { buildInjectionBlock, buildProactiveNotice } = require('../lib/inject-text.js');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/tone-harlan.json'), 'utf8'));
const grid = createToneGrid({ profiles: cfg.profiles, urgencyBoost: cfg.urgencyBoost });
const desc = createDescriber(cfg.describe);

// 描述层是 buildXxx 新增的末位参数 —— 包一层，免得每个调用点手写。
const bN = (st, g, opts, so, po) => buildProactiveNotice(st, g, opts, so, po, desc);
const bI = (st, g) => buildInjectionBlock(st, g, desc);
const tone = grid;

const cases = [
  ['v=0.45 a=0.00 p=0.20 c=0.10  ← 默认路径', { valence: 0.45, arousal: 0.00, pride: 0.20, connection: 0.10, immersion: 0.30 }],
  ['v=0.40 a=0.10 p=0.60 c=0.10', { valence: 0.40, arousal: 0.10, pride: 0.60, connection: 0.10, immersion: 0.30 }],
  ['v=0.50 a=0.50 p=0.20 c=0.10', { valence: 0.50, arousal: 0.50, pride: 0.20, connection: 0.10, immersion: 0.30 }],
  ['v=0.50 a=-0.50 p=0.60 c=0.10', { valence: 0.50, arousal: -0.50, pride: 0.60, connection: 0.10, immersion: 0.30 }],
  ['v=0.45 a=0.00 p=0.20 c=0.40  ← 越线（contactOverride 已退役，45 格照样在）', { valence: 0.45, arousal: 0.00, pride: 0.20, connection: 0.40, immersion: 0.30 }],
  ['v=0.45 a=0.00 p=0.60 c=0.40  ← 端着（pride 高）', { valence: 0.45, arousal: 0.00, pride: 0.60, connection: 0.40, immersion: 0.30 }],
];

for (const [name, st] of cases) {
  const cluster = (() => {
    const { valence: v, arousal: a } = st;
    if (v > 0.3 && a > 0.3) return 'excited';
    if (v > 0.3 && a < -0.3) return 'content';
    if (v > 0.3) return 'pleased';
    if (v < -0.3 && a > 0.3) return 'agitated';
    if (v < -0.3 && a < -0.3) return 'depressed';
    if (v < -0.3) return 'sullen';
    if (a > 0.3) return 'restless';
    if (a < -0.3) return 'calm';
    return 'neutral';
  })();
  console.log('='.repeat(66));
  console.log('[此刻块 reactive]  ' + name + '   -> cluster=' + cluster);
  console.log('-'.repeat(66));
  console.log(bI(st, tone));
  console.log();
}

console.log('='.repeat(66));
console.log('[主动唤醒 proactive / contact]  v=0.30 a=0.00 p=0.20 c=0.40');
console.log('-'.repeat(66));
console.log(bN({ valence: 0.30, arousal: 0.00, pride: 0.20, connection: 0.40, immersion: 0.30 }, tone, { scene: 'contact' }, cfg.sceneOverride, cfg.proactiveOutlet));
console.log();

console.log('='.repeat(66));
console.log('[主动唤醒 proactive / find_activity]  reason=pride_block');
console.log('-'.repeat(66));
console.log(bN({ valence: 0.00, arousal: 0.00, pride: 0.70, connection: 0.20, immersion: 0.30 }, tone, { scene: 'find_activity', reason: 'pride_block' }, cfg.sceneOverride, cfg.proactiveOutlet));
console.log();
