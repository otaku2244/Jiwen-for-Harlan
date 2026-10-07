'use strict';
// 对照：档位行（心情/姿态/心跳/想念）在「此刻块」与「唤醒通知」两条路径上的实际形态
// 用法：node _test/compare_state_lines.js   → 写 _test/compare_state_lines.txt
//
// 要回答三个问题：
//   ① 此刻块（reactive，每次聊天都注入）里档位行长什么样
//   ② 唤醒通知（proactive）里档位行长什么样 —— 重字到底出在哪条路径
//   ③ 删掉档位行之后，两条路径分别变成什么

const fs = require('fs');
const path = require('path');
const { createToneGrid } = require('../vendor/tone-grid.js');
const { createToneWrapper } = require('../lib/tone-wrap.js');
const {
  buildInjectionBlock, buildProactiveNotice, meaningfulLines, BOUNDARY_LINE,
} = require('../lib/inject-text.js');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/tone-harlan.json'), 'utf8'));
const tg = createToneWrapper(
  createToneGrid({ profiles: cfg.profiles, urgencyBoost: cfg.urgencyBoost }),
  cfg.contactOverride
);

const out = [];
const w = (s = '') => out.push(s);
const hr = (c = '=') => w(c.repeat(72));

const CLUSTER = (v, a) => {
  if (v > 0.3 && a > 0.3) return 'excited';
  if (v > 0.3 && a < -0.3) return 'content';
  if (v > 0.3) return 'pleased';
  if (v < -0.3 && a > 0.3) return 'agitated';
  if (v < -0.3 && a < -0.3) return 'depressed';
  if (v < -0.3) return 'sullen';
  if (a > 0.3) return 'restless';
  if (a < -0.3) return 'calm';
  return 'neutral';
};
const TIER = (p) => (p > 0.8 ? 5 : p > 0.5 ? 4 : p > 0.3 ? 3 : p > 0.1 ? 2 : 1);
const URG = (c) => (c >= 0.50 ? 'desperate' : c >= 0.35 ? 'urgent' : c >= 0.20 ? 'aware' : 'none');

// 现状块里，档位行恒以「心情：」开头（meaningfulLines 把四条 join('') 成一行）。
// 过滤掉它 = 模拟「删掉档位行之后」的产物。
const stripStateLines = (block) =>
  block.split('\n').filter((l) => !/^心情：/.test(l)).join('\n');

// ────────────────────────────────────────────────────────────────
hr();
w('档位行对照 · 此刻块 vs 唤醒通知');
w('生成：node _test/compare_state_lines.js');
hr();
w();
w('块内顺序：① 块头 ② 档位行 ③ 正文（45 格 / 处境句） ④ 边界句');
w('「删后」= 只把 ② 整行去掉，其余一字不动。');
w();

// ── 一、此刻块（reactive）──────────────────────────────────────
hr('-');
w('一、此刻块【积温·此刻】 —— 真人每轮开口都注入');
w('⚠️ bridge.js:430-435：非回环轮先 resetConnection()（connection→0），第 442 行才建块。');
w('   所以此刻块的 connection 恒为 0 —— 下面四例的 c 都是 0，这不是我挑的。');
hr('-');
w();

const reactiveCases = [
  ['最简：v=0.45 a=0.00 p=0.10 c=0.00', { valence: 0.45, arousal: 0.00, pride: 0.10, connection: 0.00, immersion: 0.30 }],
  ['带姿态：v=-0.50 a=-0.50 p=0.65 c=0.00', { valence: -0.50, arousal: -0.50, pride: 0.65, connection: 0.00, immersion: 0.30 }],
  ['带心跳：v=0.00 a=0.50 p=0.20 c=0.00', { valence: 0.00, arousal: 0.50, pride: 0.20, connection: 0.00, immersion: 0.30 }],
  ['心情为沉：v=-0.50 a=0.00 p=0.20 c=0.00', { valence: -0.50, arousal: 0.00, pride: 0.20, connection: 0.00, immersion: 0.30 }],
];

for (const [name, st] of reactiveCases) {
  const now = buildInjectionBlock(st, tg);
  const after = stripStateLines(now);
  w(`【${name}】`);
  w(`  坐标：簇=${CLUSTER(st.valence, st.arousal)}  pride档=${TIER(st.pride)}  urgency=${URG(st.connection)}`);
  w(`  档位行：${(now.match(/^心情：.*$/m) || ['（无）'])[0]}`);
  w('  ── 现状 ──────────────────────────────────');
  now.split('\n').forEach((l) => w('   ' + l));
  w('  ── 删后 ──────────────────────────────────');
  after.split('\n').forEach((l) => w('   ' + l));
  w();
}

// ── 二、唤醒通知（proactive / contact）─────────────────────────
hr('-');
w('二、唤醒通知【积温·找她】 —— tick 越阈时才发，日均约 2 次');
w('⚠️ 唤醒轮是回环，不走 resetConnection()，所以 c 保住了漂移值（0.20~0.55）。');
w('   重字「想念：想念。」只可能出现在这里 —— 此刻块的 c 恒为 0，那一行根本不进。');
hr('-');
w();

const proactiveCases = [
  ['c=0.25 未过考虑线 → 45 格 + aware 尾注', { valence: 0.45, arousal: 0.00, pride: 0.20, connection: 0.25, immersion: 0.30 }],
  ['c=0.40 p=0.20 → normal 覆盖，45 格被顶掉', { valence: 0.45, arousal: 0.00, pride: 0.20, connection: 0.40, immersion: 0.30 }],
  ['c=0.40 p=0.60 → pride 挡住，45 格保住', { valence: 0.45, arousal: 0.00, pride: 0.60, connection: 0.40, immersion: 0.30 }],
  ['c=0.55 → forced 覆盖 + desperate 尾注', { valence: 0.00, arousal: 0.00, pride: 0.20, connection: 0.55, immersion: 0.30 }],
];

for (const [name, st] of proactiveCases) {
  const now = buildProactiveNotice(st, tg, { scene: 'contact' }, cfg.sceneOverride, cfg.proactiveOutlet);
  const after = stripStateLines(now);
  w(`【${name}】`);
  w(`  坐标：簇=${CLUSTER(st.valence, st.arousal)}  pride档=${TIER(st.pride)}  urgency=${URG(st.connection)}`);
  w(`  档位行：${(now.match(/^心情：.*$/m) || ['（无）'])[0]}`);
  w('  ── 现状 ──────────────────────────────────');
  now.split('\n').forEach((l) => w('   ' + l));
  w('  ── 删后 ──────────────────────────────────');
  after.split('\n').forEach((l) => w('   ' + l));
  w();
}

// ── 三、想念行的可达性 ────────────────────────────────────────
hr('-');
w('三、`想念：X。` 这一行的可达性 —— 「悠闲」为什么是死档');
hr('-');
w();
w('labelConnection 四档：c<0.20 悠闲 / c<0.35 留意 / c<0.50 想念 / c>=0.50 挡不住');
w('输出条件（lib/inject-text.js:131-132）：');
w('    if (c >= 0.35)      push 想念:labelConnection(c)');
w('    else if (c >= 0.20) push 想念:labelConnection(c)   ← 动作与上一支完全相同');
w('两支合起来只覆盖 c ∈ [0.20, 1]。c<0.20 无人输出 → 「悠闲」永远进不了文本。');
w();
w('| c 值 | labelConnection 返回 | 实际输出行 |');
w('|---|---|---|');

for (const c of [0.00, 0.10, 0.19, 0.20, 0.25, 0.34, 0.35, 0.45, 0.50, 0.65]) {
  const lines = meaningfulLines({ valence: 0.0, arousal: 0.0, pride: 0.0, connection: c, immersion: 0.3 });
  const lc = c < 0.20 ? '悠闲' : c < 0.35 ? '留意' : c < 0.50 ? '想念' : '挡不住';
  const hit = lines.find((l) => l.startsWith('想念：'));
  w(`| ${c.toFixed(2)} | ${lc} | ${hit || '（不输出）'} |`);
}

w();
w('⚠️ 此刻块的 c 恒为 0 —— 正好落在「悠闲」这个死档里。');
w('   两件事叠加的结果：此刻块从来没有 `想念：` 行。');

// ── 四、汇总 ─────────────────────────────────────────────────
w();
hr('-');
w('四、汇总');
hr('-');
w();
w('| 档位行 | 与谁同轴 | 此刻块(c=0) | 唤醒通知(c=0.4) | 删后 |');
w('|---|---|---|---|---|');
w('| 心情：X | 45 格的簇（V×A） | 每次都有 | 每次都有 | 由 45 格承担 |');
w('| 姿态：X | 45 格的 pride 档 | 条件出现 | 条件出现 | 由 45 格承担 |');
w('| 心跳：X | 45 格簇内 arousal | 条件出现 | 条件出现 | 由 45 格承担 |');
w('| 想念：X | urgency 尾注（同阈值） | 永不出现 | 有，且重字 | 由处境句承担 |');
w();
w('此刻块（删后）= 块头 + 45 格 + 边界句');
w('唤醒通知（删后）= 块头 + 45 格 + connection 处境句 + 边界句');

fs.writeFileSync(path.join(__dirname, 'compare_state_lines.txt'), out.join('\n') + '\n', 'utf8');
console.log('written: _test/compare_state_lines.txt  (' + out.length + ' lines)');
