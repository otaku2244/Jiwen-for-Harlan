'use strict';
// 主动唤醒块 · 成型版预览
// 用法：node _test/preview_notice.js

const fs = require('fs');
const path = require('path');
const { createToneGrid } = require('../vendor/tone-grid.js');
const { createToneWrapper } = require('../lib/tone-wrap.js');
const { buildInjectionBlock, buildProactiveNotice } = require('../lib/inject-text.js');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'tone-harlan.json'), 'utf8'));
const tg = createToneWrapper(
  createToneGrid({ profiles: cfg.profiles, urgencyBoost: cfg.urgencyBoost }),
  cfg.contactOverride
);

const CASES = [
  {
    name: '① 此刻块（reactive）· 用户刚开口',
    fn: (st) => buildInjectionBlock(st, tg),
    st: { connection: 0.42, pride: 0.4, valence: 0.1, arousal: -0.2, immersion: 0.1 },
  },
  {
    name: '② 找她（contact）· 过了考虑线',
    fn: (st) => buildProactiveNotice(st, tg, { scene: 'contact' }, cfg.sceneOverride),
    st: { connection: 0.42, pride: 0.4, valence: 0.1, arousal: -0.2, immersion: 0.1 },
  },
  {
    name: '③ 找她（contact）· 过了强制线',
    fn: (st) => buildProactiveNotice(st, tg, { scene: 'contact' }, cfg.sceneOverride),
    st: { connection: 0.62, pride: 0.2, valence: 0.3, arousal: 0.4, immersion: 0.1 },
  },
  {
    name: '④ 自留地（find_activity / pride_block）',
    fn: (st) => buildProactiveNotice(st, tg, { scene: 'find_activity', reason: 'pride_block' }, cfg.sceneOverride),
    st: { connection: 0.40, pride: 0.7, valence: -0.1, arousal: -0.3, immersion: 0.1 },
  },
  {
    name: '⑤ 自留地（find_activity / low_valence）',
    fn: (st) => buildProactiveNotice(st, tg, { scene: 'find_activity', reason: 'low_valence' }, cfg.sceneOverride),
    st: { connection: 0.10, pride: 0.2, valence: -0.8, arousal: -0.3, immersion: 0.1 },
  },
  {
    name: '⑥ 自留地（find_activity / high_arousal）',
    fn: (st) => buildProactiveNotice(st, tg, { scene: 'find_activity', reason: 'high_arousal' }, cfg.sceneOverride),
    st: { connection: 0.10, pride: 0.4, valence: -0.2, arousal: 0.8, immersion: 0.1 },
  },
];

const out = [];
for (const c of CASES) {
  out.push('═'.repeat(74));
  out.push(c.name);
  out.push(`state: ${JSON.stringify(c.st)}`);
  out.push('─'.repeat(74));
  out.push(c.fn(c.st));
  out.push('');
}
const text = out.join('\n');
console.log(text);
fs.writeFileSync(path.join(__dirname, 'notice-preview.txt'), text, 'utf8');
