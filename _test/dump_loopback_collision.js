'use strict';
// dump_loopback_collision.js —— 把「回环那一轮模型实际看到的东西」原样打印出来。
//
// ⚠️ 现状（2026-10-06 起，方案 A 已落地）：桥在识别到回环时**不再注入此刻块**，
//    所以下面那段拼接是**反例样本**，只作回归参照 —— 用来证明"让位"这个决定不是拍脑袋。
//    已实现的断言在 `_test/loopback_check.js` 的 [5]/[6] 两段。
//
// 为什么需要这个脚本：
//   回环（桥发通知 → Operit 当 user 消息注入 → 请求打回桥）这一轮，
//   消息里会同时出现两份积温材料：
//     ① Operit 投递的通知全文（场景标签 + 档位行 + proactive 正文 + 出口说明 + 尾句）
//     ② 桥照常注入的此刻块（场景标签 + 档位行 + reactive 正文 + 尾句）
//   只有把它们拼起来看，才能判断是"重复"还是"打架"。
//
// 用法：node _test/dump_loopback_collision.js

const fs = require('fs');
const path = require('path');
const { createToneGrid } = require('../vendor/tone-grid.js');
const { createToneWrapper } = require('../lib/tone-wrap.js');
const { buildInjectionBlock, buildProactiveNotice } = require('../lib/inject-text.js');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'tone-harlan.json'), 'utf8'));
const grid = createToneWrapper(
  createToneGrid({ profiles: cfg.profiles, urgencyBoost: cfg.urgencyBoost }),
  cfg.contactOverride
);

// 桥在 fireProactive 里：先用 st 渲染通知，投递后立刻 applyDelta({connection:-0.35})。
// 所以「通知的档位行」是**衰减前**，「此刻块的档位行」是**衰减后**。
const DECAY = -0.35;

function show(title, statePre) {
  const statePost = { ...statePre, connection: statePre.connection + DECAY };
  const notice = buildProactiveNotice(statePre, grid, { scene: 'contact' }, cfg.sceneOverride, cfg.proactiveOutlet);
  const block = buildInjectionBlock(statePost, grid);

  console.log('\n' + '='.repeat(72));
  console.log(title);
  console.log(`  tick 时刻 c=${statePre.connection.toFixed(2)} → 通知；投递后衰减 ${DECAY} → 请求时刻 c=${statePost.connection.toFixed(2)}`);
  console.log('='.repeat(72));
  console.log('\n--- ① 桥注入的【积温·此刻】(reactive 语域) ---');
  console.log(block);
  console.log('\n--- ② Operit 投递的通知 (proactive 语域) ---');
  console.log(notice);
  console.log('\n--- 模型实际看到的最后一条 user 消息（两块同处一条）---');
  console.log(block + '\n\n' + notice.replace(/\r?\n+/g, ' ').trim());
}

show('场景 1：强烈想念，越强制开口线（c=0.62）', { connection: 0.62, pride: 0.15, valence: 0.05, arousal: 0.05 });
show('场景 2：刚过考虑线（c=0.38）', { connection: 0.38, pride: 0.15, valence: 0.05, arousal: 0.05 });

// 场景 3：独处通知。这条不走 contact（c 越低越容易触发 find_activity），
// 场景正文来自 sceneOverride，与此刻块的 reactive 正文不同源，看看是否也冲突。
(function () {
  const state = { connection: 0.10, pride: 0.20, valence: -0.45, arousal: 0.05 };
  const notice = buildProactiveNotice(state, grid, { scene: 'find_activity', reason: 'low_valence' }, cfg.sceneOverride, cfg.proactiveOutlet);
  const block = buildInjectionBlock(state, grid);
  console.log('\n' + '='.repeat(72));
  console.log('场景 3：独处通知（low_valence），state 无衰减');
  console.log('='.repeat(72));
  console.log('\n--- ① 桥注入的【积温·此刻】(reactive 语域) ---');
  console.log(block);
  console.log('\n--- ② Operit 投递的通知 (sceneOverride 语域) ---');
  console.log(notice);
})();
