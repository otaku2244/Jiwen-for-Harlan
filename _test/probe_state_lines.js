'use strict';
// 档位行两问：
//   ①「姿态：X。」「心跳：X。」到底什么条件下冒出来？档位词能不能全部够到？
//   ② 若按讨论改（删档位行 + 去英文簇名 + 补中文状态句），此刻块变成什么样？
// 用法：node _test/probe_state_lines.js   → 写 _test/state_lines_probe.txt

const fs = require('fs');
const path = require('path');
const { createToneGrid } = require('../vendor/tone-grid.js');
const { createToneWrapper } = require('../lib/tone-wrap.js');
const { buildInjectionBlock, meaningfulLines, BOUNDARY_LINE } = require('../lib/inject-text.js');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/tone-harlan.json'), 'utf8'));

const out = [];
const w = (s = '') => out.push(s);
const hr = (c = '=') => w(c.repeat(72));

// ────────────────────────────────────────────────────────────────
// 一、可达性扫描
// ────────────────────────────────────────────────────────────────
hr();
w('一、档位行的触发条件与档位词可达性');
hr();
w();
w('代码：lib/inject-text.js:115-135  meaningfulLines()');
w();
w('| 行 | 代码条件 | 说明 |');
w('|---|---|---|');
w('| 心情：X。 | 无条件 push | 每次都有，基线 |');
w('| 姿态：X。 | `p > 0.3` 或 `p < -0.1` | 非中性才提 |');
w('| 心跳：X。 | `a > 0.3` 或 `a < -0.3` | 只在极端时提 |');
w('| 想念：X。 | `c >= 0.20` | 此刻块 c≡0 → 永不 |');
w();

// labelPride / labelValence / labelArousal 的分档（源码 lib/inject-text.js:94-112）
const PRIDE_BANDS = [
  ['>0.8', '完全收着'], ['>0.5', '收着'], ['>0.3', '留着一点余地'],
  ['>0.1', '略收'], ['>-0.1', '平常'], ['>-0.3', '松了'], ['else', '完全不设防'],
];
const AROUSAL_BANDS = [['>0.3', '起波'], ['<-0.3', '慵懒'], ['else', '平静']];

function scan(axis, bands) {
  const seen = new Map();   // 档位词 -> 首次出现的值
  const span = new Map();   // 档位词 -> [最小值, 最大值]
  for (let x = -1; x <= 1.0001; x += 0.005) {
    const st = { valence: 0, arousal: 0, pride: 0, connection: 0, immersion: 0.3 };
    st[axis] = Math.round(x * 1000) / 1000;
    const lines = meaningfulLines(st);
    const key = axis === 'pride' ? '姿态：' : '心跳：';
    const hit = lines.find((l) => l.startsWith(key));
    if (!hit) continue;
    const word = hit.replace(key, '').replace('。', '');
    if (!seen.has(word)) seen.set(word, st[axis]);
    const r = span.get(word) || [Infinity, -Infinity];
    r[0] = Math.min(r[0], st[axis]); r[1] = Math.max(r[1], st[axis]);
    span.set(word, r);
  }
  return { seen, span, bands };
}

for (const [axis, bands, name] of [['pride', PRIDE_BANDS, '姿态'], ['arousal', AROUSAL_BANDS, '心跳']]) {
  const { seen, span } = scan(axis, bands);
  w(`### ${name}（label${axis === 'pride' ? 'Pride' : 'Arousal'} 定义了 ${bands.length} 个档位词）`);
  w();
  w('| 分档边界 | 档位词 | 实际可达 | 出现的取值区间 |');
  w('|---|---|---|---|');
  for (const [edge, word] of bands) {
    const r = span.get(word);
    w(`| ${edge} | ${word} | ${r ? '✅' : '❌ 永不出现'} | ${r ? `[${r[0].toFixed(3)}, ${r[1].toFixed(3)}]` : '—'} |`);
  }
  w();
}

w('> **「略收」（p ∈ (0.1, 0.3]）与「平常」（p ∈ (-0.1, 0.1]）是死档。**');
w('> 触发条件是 `p > 0.3` 或 `p < -0.1`，中间这一段两边都不占 → 这两档永远进不了文本。');
w('> 与「悠闲」同源：**标签表定义得比触发条件宽，宽出来的部分没人输出。**');
w('>');
w('> 「平静」（a ∈ [-0.3, 0.3]）也是死档，但这个是有意的 —— 注释写着「只在极端时提」。');
w();
w('⚠️ 顺带：`labelPride` 的档边界（0.8/0.5/0.3/0.1/-0.1/-0.3）与 45 格的 pride 档边界');
w('   （0.8/0.5/0.3/0.1）**并不对齐** —— 同一个 pride，档位行说「松了」，45 格取的可能还是第 1 档。');
w();

// ────────────────────────────────────────────────────────────────
// 二、用户给的那一例，逐条验算
// ────────────────────────────────────────────────────────────────
hr('-');
w('二、逐条验算一例：v=-0.60 a=-0.60 p=0.65 c=0.00');
hr('-');
w();
const ST = { valence: -0.60, arousal: -0.60, pride: 0.65, connection: 0.00, immersion: 0.30 };
w('| 行 | 条件代入 | 结果 |');
w('|---|---|---|');
w(`| 心情： | labelValence(${ST.valence}) → v<-0.3 | 沉 ✅ |`);
w(`| 姿态： | p=${ST.pride} → \`p > 0.3\` 成立 | labelPride → \`>0.5\` → 收着 ✅ |`);
w(`| 心跳： | a=${ST.arousal} → \`a < -0.3\` 成立 | labelArousal → \`<-0.3\` → 慵懒 ✅ |`);
w(`| 想念： | c=${ST.connection} → \`c >= 0.20\` 不成立 | 不输出 ❌ |`);
w();
w('所以那一例三行全冒出来，不是巧合，是三个条件**恰好同时满足**（v 沉、p 越过 0.3、a 跌破 -0.3）。');
w(`  实际拼接：` + JSON.stringify(meaningfulLines(ST).join('')));
w();

// ────────────────────────────────────────────────────────────────
// 三、改后形态（对照）
// ────────────────────────────────────────────────────────────────
hr('-');
w('三、按方案乙改（删档位行 + 去英文簇名 + 补中文状态句）后的此刻块');
hr('-');
w();
w('⚠️ 状态句是**草稿**（9 条，按簇共用），45 格正文则是从 config 动态取的、真去掉了前缀。');
w();
w('骨架：');
w('【积温·此刻】');
w('  <中文状态句 —— 按簇，9 条共用>');
w('  <45 格正文 —— 去掉了英文簇名，只留语气>');
w('  【此状态为潜意识的底色沉淀，自然浸润在回应里，不作任何元说明或刻意提及。】');
w();

// 状态句的写法原则：**只说"我在什么情绪里"，不碰"该怎么说话"**。
// 45 格正文里已经有大量情绪词（"提不起力气""热度直接漫出来"），
// 状态句若也跟着写这些，就会撞词 —— 例如 depressed 若写成
// 「情绪是往下的，力气也提不起来。」，下一行正文又是「提不起力气」，同段重复。
// 所以这里刻意只给情绪方向，把"力气/热度/节奏"留给 45 格。
const CLUSTER_DRAFT = {
  excited: '兴致起来了。',
  content: '整个人是松的。',
  pleased: '心里是松快的。',
  agitated: '心里有点躁。',
  depressed: '情绪是往下的。',
  sullen: '有点闷。',
  restless: '静不下来。',
  calm: '人是静的。',
  neutral: '没什么起伏。',
};
const CLUSTERS = [
  ['excited', 0.60, 0.60], ['content', 0.60, -0.60], ['pleased', 0.60, 0.00],
  ['agitated', -0.60, 0.60], ['depressed', -0.60, -0.60], ['sullen', -0.60, 0.00],
  ['restless', 0.00, 0.60], ['calm', 0.00, -0.60], ['neutral', 0.00, 0.00],
];

// 与生产同构：走 buildInjectionBlock 拿正文，再去掉簇名前缀
const tg = createToneWrapper(
  createToneGrid({ profiles: cfg.profiles, urgencyBoost: cfg.urgencyBoost }),
  cfg.contactOverride
);
const CLUSTER_OF = (v, a) => {
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
const deCluster = (text) => text.replace(/^[a-zA-Z]+\s*，\s*/, '');

const pickBody = (st) => {
  const block = buildInjectionBlock(st, tg);
  const body = block.split('\n').find((l) => l && !l.startsWith('【积温') && !l.startsWith('心情：') && l !== BOUNDARY_LINE) || '';
  return deCluster(body);
};

const cases = [
  ['depressed / p=0.65（= 你贴的那一例）', -0.60, -0.60, 0.65],
  ['pleased / p=0.05', 0.60, 0.00, 0.05],
  ['neutral / p=0.20', 0.00, 0.00, 0.20],
];

for (const [name, v, a, p] of cases) {
  const st = { valence: v, arousal: a, pride: p, connection: 0, immersion: 0.3 };
  const cl = CLUSTER_OF(v, a);
  const body = pickBody(st);
  w(`【${name}】`);
  w('  ── 现在 ──');
  buildInjectionBlock(st, tg).split('\n').forEach((l) => w('  ' + l));
  w('  ── 改后 ──');
  w('  【积温·此刻】');
  w('  ' + CLUSTER_DRAFT[cl]);
  w('  ' + body);
  w('  ' + BOUNDARY_LINE);
  w();
}

// ────────────────────────────────────────────────────────────────
// 四、去掉簇名后，45 条正文长什么样
// ────────────────────────────────────────────────────────────────
hr('-');
w('四、去掉英文簇名后，45 条正文的开头会不会变得单调？');
hr('-');
w();
let total = 0, startsWithBiaoDa = 0;
const heads = new Map();
for (const cl of Object.keys(cfg.profiles)) {
  for (const tier of Object.keys(cfg.profiles[cl])) {
    const raw = (cfg.profiles[cl][tier] || [])[0] || '';
    const stripped = deCluster(raw);
    total++;
    const head = stripped.slice(0, 2);
    heads.set(head, (heads.get(head) || 0) + 1);
    if (stripped.startsWith('表达')) startsWithBiaoDa++;
  }
}
w(`45 条里，去掉簇名后以「表达」开头的：**${startsWithBiaoDa} / ${total}**`);
w();
w('| 开头两字 | 条数 |');
w('|---|---|');
for (const [h, n] of [...heads.entries()].sort((a, b) => b[1] - a[1])) w(`| ${h} | ${n} |`);
w();
w(`> 结论：**去掉簇名之后，${startsWithBiaoDa} 条以「表达」起头，其余 ${total - startsWithBiaoDa} 条以「几乎不表达」起头** ——`);
w('> 45 条全部绕着「表达」这一个词（量级槽统一用了它）。');
w('> 这正好说明「补一句中文状态句」不是可选装饰 —— 没有它，45 格的起手式高度同质，');
w('> 模型每次看到的开头几乎一样，区分全靠后半句。');
w();

fs.writeFileSync(path.join(__dirname, 'state_lines_probe.txt'), out.join('\n') + '\n', 'utf8');
console.log('written: _test/state_lines_probe.txt  (' + out.length + ' lines)');
