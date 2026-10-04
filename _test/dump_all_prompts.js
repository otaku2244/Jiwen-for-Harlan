'use strict';
// 穷举语调网格的全部可能性，导出成可读清单
// 用法：node _test/dump_all_prompts.js > _test/all-prompts.txt

const { createToneGrid } = require('../vendor/tone-grid.js');
const { createToneWrapper } = require('../lib/tone-wrap.js');
const fs = require('fs');
const path = require('path');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'tone-harlan.json'), 'utf8'));
const raw = createToneGrid({ profiles: cfg.profiles, urgencyBoost: cfg.urgencyBoost });
const tg = createToneWrapper(raw, cfg.contactOverride);

// 构造能精确命中每个格子的代表状态
const CLUSTERS = {
  excited:   { v: 0.5,  a: 0.5  },
  content:   { v: 0.5,  a: -0.5 },
  pleased:   { v: 0.5,  a: 0.0  },
  agitated:  { v: -0.5, a: 0.5  },
  depressed: { v: -0.5, a: -0.5 },
  sullen:    { v: -0.5, a: 0.0  },
  restless:  { v: 0.0,  a: 0.5  },
  calm:      { v: 0.0,  a: -0.5 },
  neutral:   { v: 0.0,  a: 0.0  },
};
// pride → 档位（与 vendor classifyPride 一致）
const PRIDE = { 1: -0.05, 2: 0.2, 3: 0.4, 4: 0.65, 5: 0.9 };
// connection → urgency（与 vendor classifyUrgency 一致）
const CONN = { none: 0.05, aware: 0.25, urgent: 0.42, desperate: 0.62 };

const out = [];
function w(s) { out.push(s); }

w('# 积温桥 · 全部提示词穷举清单');
w('');
w('本文件由 _test/dump_all_prompts.js 自动生成，不要手改。');
w('');
w('结构：');
w('- reactive  = 用户开口时注入到消息里的「此刻块」风格指令（getStyleGuidance）');
w('- proactive = 阈值触发主动唤醒时的通知正文（getPromptContext）');
w('- 每条 = [基础档：由 V×A 簇 + pride 档决定] + [urgency 尾注：由 connection 档决定]');
w('- 带 ★ 的条目表示此格触发了「开口动机覆盖」（connection 越线且未被 pride 挡住）');
w('');

for (const [cluster, va] of Object.entries(CLUSTERS)) {
  w('');
  w('═'.repeat(74));
  w(`## 情绪簇：${cluster}  (valence=${va.v}, arousal=${va.a})`);
  w('═'.repeat(74));

  for (const tier of [1, 2, 3, 4, 5]) {
    for (const [urgName, c] of Object.entries(CONN)) {
      const st = { connection: c, pride: PRIDE[tier], valence: va.v, arousal: va.a };
      const motive = tg.contactMotive(st);
      const mark = motive ? ' ★覆盖:' + motive : '';

      const re = tg.getStyleGuidance(st);
      const pr = tg.getPromptContext(st);

      w('');
      w(`── pride 档 ${tier} (p=${PRIDE[tier]}) × urgency ${urgName} (c=${c})${mark} ──`);
      w('  [reactive]');
      for (const ln of String(re || '(空)').split('\n')) w('    ' + ln);
      w('  [proactive]');
      for (const ln of String(pr || '(空)').split('\n')) w('    ' + ln);
    }
  }
}

// 附：urgencyBoost 原始 8 条
w('');
w('');
w('═'.repeat(74));
w('## 附 · urgencyBoost 原始条目（连接档位 × 模式，共 8 条）');
w('═'.repeat(74));
const ub = cfg.urgencyBoost;
for (const lvl of ['desperate', 'urgent', 'aware', 'none']) {
  w('');
  w(`── ${lvl} ──`);
  w('  proactive: ' + (ub[lvl] && ub[lvl].proactive !== null ? ub[lvl].proactive : '(null · 不追加)'));
  w('  reactive:  ' + (ub[lvl] && ub[lvl].reactive !== null ? ub[lvl].reactive : '(null · 不追加)'));
}

w('');
w('═'.repeat(74));
w('## 附 · contactOverride 开路文案（共 4 条）');
w('═'.repeat(74));
const co = cfg.contactOverride;
for (const mode of ['reactive', 'proactive']) {
  w('');
  w(`── ${mode} ──`);
  for (const m of ['forced', 'normal']) {
    w(`  ${m}: ` + (co[mode][m] || '(空)'));
  }
}

// 统计
const lines = out.join('\n');
fs.writeFileSync(path.join(__dirname, 'all-prompts.txt'), lines, 'utf8');
console.log('已写出 _test/all-prompts.txt');
console.log('总行数: ' + out.length);
console.log('总格数: 9 簇 × 5 pride 档 × 4 urgency 档 = 180 格 × 2 模式 = 360 条');
