'use strict';
// diag_prompt.js —— 当前提示词实现相对原作者设计的偏离清单（穷举 + 可复跑）
//
// 用法（jiwen-bridge 目录下）: node _test/diag_prompt.js
//
// 三个对照对象：
//   作者默认  vendor/jiwen.js:743-905   defaultPromptContext() / defaultStyleGuidance()
//   作者 demo docs/index.html:236-267   ctx() / sty()
//   我们      config/tone-harlan.json + lib/describe.js + lib/inject-text.js
//
// 只报事实（计数 + 样例），不下结论。结论在 README/对话里。
//
// ⚠️ 2026-10-08 变体② 之后对照基准变了：
//   · `contactOverride`（开口动机覆盖）与 `urgencyBoost`（urgency 尾注）已退役 →
//     [2][3] 由「顶掉范围」改为「退役回归」。
//   · 描述层（作者 defaultPromptContext 的四段）已补回 → [6] 由「缺哪层」改为「四层到位」。

const fs = require('fs');
const path = require('path');
const { createToneGrid } = require('../vendor/tone-grid.js');
const { createDescriber } = require('../lib/describe.js');
const { buildInjectionBlock, buildProactiveNotice } = require('../lib/inject-text.js');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/tone-harlan.json'), 'utf8'));
const grid = createToneGrid({ profiles: cfg.profiles, urgencyBoost: cfg.urgencyBoost });
const desc = createDescriber(cfg.describe);

const CLUSTERS = ['excited', 'content', 'pleased', 'agitated', 'depressed', 'sullen', 'restless', 'calm', 'neutral'];
const VS = [-1, -0.5, -0.2, 0, 0.2, 0.5, 1];
const AS = [-1, -0.5, -0.2, 0, 0.2, 0.5, 1];
const PS = [-1, -0.5, -0.1, 0, 0.05, 0.2, 0.4, 0.65, 0.9];
const CS = [0, 0.1, 0.25, 0.36, 0.5, 0.7];

const st = (v, a, p, c, imm, act) => ({
  valence: v, arousal: a, pride: p, connection: c,
  immersion: imm == null ? 0 : imm,
  lastActivity: act || null,
});

function hr(t) { console.log('\n' + '─'.repeat(66) + '\n' + t); }

// ════════════════════════════════════════════════════════════════
hr('[1] 正文是否以英文簇名开头（模型的说话风格指引）');
// ════════════════════════════════════════════════════════════════
{
  let total = 0, leaked = 0;
  const samples = [];
  for (const c of CLUSTERS) {
    for (const tier of [1, 2, 3, 4, 5]) {
      const line = (cfg.profiles[c] || {})[tier];
      if (!line) continue;
      for (const s of line) {
        total++;
        const hit = CLUSTERS.find((x) => s.startsWith(x));
        if (hit) { leaked++; if (samples.length < 4) samples.push(`    ${s.slice(0, 52)}…`); }
      }
    }
  }
  console.log(`  格内文案 ${total} 条，以英文簇名开头 ${leaked} 条（${(leaked / total * 100).toFixed(0)}%）`);
  console.log('  样例：');
  samples.forEach((s) => console.log(s));
  console.log('  → 簇名是坐标，现在**始终**出现在模型可见文本里（45 格是块里唯一按状态细分的层，');
  console.log('    不再被任何覆盖层顶掉，所以没有"只在这一档才露出来"的说法了）。');
}

// ════════════════════════════════════════════════════════════════
hr('[2] 45 格是否完整到达模型（覆盖层退役后的回归）');
// ════════════════════════════════════════════════════════════════
{
  let n = 0, clusterHead = 0, distinct = new Set();
  for (const v of VS) for (const a of AS) for (const p of PS) for (const c of CS) {
    n++;
    const body = grid.getStyleGuidance(st(v, a, p, c)) || '';
    distinct.add(body);
    if (/^[a-z]+，/.test(body.split('\n')[0])) clusterHead++;
  }
  const a1 = grid.getStyleGuidance(st(0.45, 0, 0.2, 0.1));
  const a2 = grid.getStyleGuidance(st(0.45, 0, 0.2, 0.7));
  console.log(`  穷举 ${n} 组（V×A×pride×c）：`);
  console.log(`    · 不同的正文只有 ${distinct.size} 种（理论值 9 簇 × 5 档 = 45，受枚举粒度限制）`);
  console.log(`    · 以簇名开头的 ${clusterHead}/${n} 组（${(clusterHead / n * 100).toFixed(0)}%）`);
  console.log(`    · 正文是否随 connection 变化：${a1 === a2 ? '否（connection 已不进 45 格）' : '是'}`);
  console.log('  → contactOverride 退役后 45 格不再被顶掉；urgencyBoost 退役后也不再多一行尾注。');
}

// ════════════════════════════════════════════════════════════════
hr('[3] 已退役的两层：退役是否真的生效');
// ════════════════════════════════════════════════════════════════
{
  console.log(`  contactOverride 键是否还在 config：${'contactOverride' in cfg ? '❌ 仍在' : '✅ 已删除'}`);
  const ub = cfg.urgencyBoost || {};
  const allNull = ['desperate', 'urgent', 'aware', 'none']
    .every((k) => ub[k] && ub[k].proactive === null && ub[k].reactive === null);
  console.log(`  urgencyBoost 四档是否全 null：${allNull ? '✅ 是' : '❌ 否'}`);

  const s = st(0.45, 0, 0.2, 0.4);
  const notice = buildProactiveNotice(s, grid, { scene: 'contact' }, cfg.sceneOverride, cfg.proactiveOutlet, desc);
  const hasUrgency = /她安静得有点久了|她很久没消息了|她好像没什么动静/.test(notice);
  console.log(`  越线 contact 块里是否还有 urgency 句：${hasUrgency ? '❌ 有' : '✅ 无'}`);
  console.log(`  越线 contact 块里是否有 45 格正文：${notice.includes(grid.getPromptContext(s)) ? '✅ 有' : '❌ 无'}`);
  console.log('  → 这两层退役前会在同一个块里叠成三句同义反复（现在改由描述层承担）。');
}

// ════════════════════════════════════════════════════════════════
hr('[4] 档位行 —— 已于 2026-10-08 整条删除（本项不再统计）');
// ════════════════════════════════════════════════════════════════
{
  // 删除依据（原分析留档，已在 `_test/state_lines_probe.txt` / `compare_state_lines.txt`）：
  //   · 「想念」与字段名同字 → 渲染成 `想念：想念。`（重字）
  //   · 四条各自 ≈ 45 格的某一维，属同义重复：心情←簇 / 姿态←pride 档 / 心跳←簇内 arousal
  //   · 「悠闲」死档：进 `想念：` 行要 `c ≥ 0.20`，而「悠闲」区间是 `c < 0.20`，永不可达
  //   · 此刻块 c 恒 0 → `想念：` 行此刻块里根本不出现（通知里才有）
  // 现在块内只剩「块头 / 描述层 / 正文 / 尾标记」。
  console.log('  已删除。历史分析见 _test/state_lines_probe.txt 与 _test/compare_state_lines.txt。');
}

// ════════════════════════════════════════════════════════════════
hr('[5] 实际渲染：此刻块 / 唤醒块（含描述层）');
// ════════════════════════════════════════════════════════════════
{
  const cases = [
    ['此刻块 · 刚聊完（c=0，段1 不出）', st(0.45, 0, 0.2, 0)],
    ['此刻块 · 越线状态（注意：此刻块 c 恒 0，这里仅作对照）', st(0.45, 0, 0.2, 0.4)],
  ];
  for (const [name, state] of cases) {
    console.log(`  【${name}】`);
    buildInjectionBlock(state, grid, desc).split('\n').forEach((l) => console.log('    ' + l));
    console.log('');
  }
  console.log('  【唤醒块 · contact（c=0.42，pride=0.15）】');
  buildProactiveNotice(st(0.30, 0, 0.15, 0.42), grid, { scene: 'contact' }, cfg.sceneOverride, cfg.proactiveOutlet, desc)
    .split('\n').forEach((l) => console.log('    ' + l));
  console.log('');
  console.log('  【唤醒块 · find_activity（pride_block）】');
  buildProactiveNotice(st(-0.10, -0.20, 0.70, 0.20), grid, { scene: 'find_activity', reason: 'pride_block' }, cfg.sceneOverride, cfg.proactiveOutlet, desc)
    .split('\n').forEach((l) => console.log('    ' + l));
}

// ════════════════════════════════════════════════════════════════
hr('[6] 作者四段描述层 —— 逐段可达性');
// ════════════════════════════════════════════════════════════════
{
  const R = cfg.describe;
  const connAll = new Set(R.connection.map((x) => x.text));
  const prideAll = new Set(R.pride.map((x) => x.text));
  const moodAll = new Set(Object.values(R.mood));

  const seenConn = new Set(), seenPride = new Set(), seenMood = new Set();
  for (const v of VS) for (const a of AS) for (const p of PS) for (const c of CS) {
    for (const l of desc(st(v, a, p, c))) {
      if (connAll.has(l)) seenConn.add(l);
      else if (prideAll.has(l)) seenPride.add(l);
      else if (moodAll.has(l)) seenMood.add(l);
    }
  }
  const miss = (all, seen) => [...all].filter((x) => !seen.has(x)).length;
  console.log(`  ① 段1 连接（作者 defaultPromptContext 第 1 段）  可达 ${seenConn.size}/${connAll.size}，缺 ${miss(connAll, seenConn)}`);
  console.log(`  ② 段2 骄傲（作者第 2 段）                        可达 ${seenPride.size}/${prideAll.size}，缺 ${miss(prideAll, seenPride)}`);
  console.log(`  ③ 段3 心情（作者第 3 段 V×A）                    可达 ${seenMood.size}/${moodAll.size}，缺 ${miss(moodAll, seenMood)}`);

  // 段4 不吃 v/a/p/c 的穷举（它只读 immersion + lastActivity），单独测三档。
  const LABEL = '上网冲浪';
  const ACT = { type: 'search', label: LABEL, at: new Date().toISOString() };
  const DOING = String(R.immersion.doing).replace('{label}', LABEL);
  const IDLE = R.immersion.idle;
  const immLines = (s) => desc(s).filter((l) => l === DOING || l === IDLE);
  const busyOn = immLines(st(0, 0, 0, 0, 0.4, ACT)).includes(DOING);
  // 死带：immersion 在 0.1~0.3 之间时，段4 两句都不该出
  const deadOut = immLines(st(0, 0, 0, 0, 0.2, ACT)).length === 0;
  const idleOn = immLines(st(0, 0, 0, 0, 0.05, null)).includes(IDLE);
  // 不编造：immersion 高但没有 lastActivity（或没有 label）时也不该说"在做什么"
  const noFake = !immLines(st(0, 0, 0, 0, 0.4, null)).includes(DOING)
    && !immLines(st(0, 0, 0, 0, 0.4, { type: 'search', at: ACT.at })).includes(DOING);
  console.log(`  ④ 段4 沉浸（作者第 4 段 immersion）              doing=${busyOn} 死带不出=${deadOut} idle=${idleOn} 不编造=${noFake}`);
  console.log('  作者默认实现里四层全部存在（vendor/jiwen.js:751-801）。');
  console.log('  段4 的真来源：冲浪 spawn 成功后登记一次活动（lib/activity.js），immersion = 0.4；');
  console.log('  之后按 0.01/分钟自然衰减 → 10 分钟后落到死带，30 分钟后回到 idle。');
}

console.log('\n' + '═'.repeat(66));
console.log('说明：本脚本只测量，不判断。哪些该补、哪些该删，取决于设计取舍。');
