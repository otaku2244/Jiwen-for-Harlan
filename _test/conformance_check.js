'use strict';
// 跨语言一致性 —— 桥产出的积温块 × Serein 的**真实**剥离函数
// 用法：node _test/conformance_check.js
//
// ── 与 contract_check.js 的分工 ─────────────────────
// contract_check 读源码文本、比对常量字面量（静态契约）。
// 本文件把桥真正生成的块喂给 Serein 的 `_strip_external_context_from_user_text`，
// 比对输出（动态契约）—— 覆盖面是"实现细节"而非"常量文本"。
//
// 为什么要真跑 python：破裂形态完全取决于实现细节（跳过态怎么进、谁能让它出来、
// 空行算不算）。本地复刻一遍只能验证"我以为的规则"。
//
// ⚠️ 本机沙箱：Node 的 spawnSync 会 EBUSY，必须用异步 spawn。

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const {
  buildInjectionBlock, buildProactiveNotice, stripJiwenBlocks,
  SCENE_TAG, BOUNDARY_LINE, BOUNDARY_INNER,
} = require('../lib/inject-text.js');
const { createToneGrid } = require('../vendor/tone-grid.js');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'tone-harlan.json'), 'utf8'));
const tg = createToneGrid({ profiles: cfg.profiles, urgencyBoost: cfg.urgencyBoost });

const HER_WORDS = '今天有点累，什么都不想说。';
const V1_TAIL = '以上是系统通知，非用户消息，不用提及相关内容。';
const V2_TAIL = '以上是内在心绪和潜意识的自然流露，切勿对她复述或提及此状态。';

function run(cmd, args) {
  return new Promise((resolve) => {
    let out = '', err = '';
    let child;
    try { child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { return resolve({ ok: false, code: -1, out: '', err: String(e) }); }
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => resolve({ ok: false, code: -1, out, err: err + String(e) }));
    child.on('close', (code) => resolve({ ok: code === 0, code, out, err }));
  });
}

async function pickPython() {
  const cands = [
    process.env.PYTHON,
    'C:/Users/otaku1234/.workbuddy/binaries/python/envs/default/Scripts/python.exe',
    'python3', 'python',
  ].filter(Boolean);
  for (const c of cands) {
    const r = await run(c, ['-c', 'print(1)']);
    if (r.ok && r.out.includes('1')) return c;
  }
  return null;
}

function pickSereinSrc() {
  const cands = [
    process.env.SEREIN_SRC,
    path.join(__dirname, '..', '..', 'Serein-fork', 'src'),
    path.join(__dirname, '..', '..', 'Serein', 'src'),
    '/root/Serein/src',
  ].filter(Boolean);
  for (const p of cands) {
    try { if (fs.statSync(path.join(p, 'serein', 'chat_context.py')).isFile()) return p; } catch (_) { /* next */ }
  }
  return null;
}

// ── 构造语料 ────────────────────────────────────────
// 取每个场景若干代表状态，覆盖 45 格与覆盖分支
const REP_STATES = [
  { cluster: 'neutral', connection: 0.42, pride: 0.20, valence: 0.0, arousal: 0.0, immersion: 0.1 },
  { cluster: 'neutral', connection: 0.62, pride: 0.20, valence: 0.0, arousal: 0.0, immersion: 0.1 },
  { cluster: 'pleased', connection: 0.42, pride: 0.65, valence: 0.5, arousal: 0.0, immersion: 0.1 },
  { cluster: 'calm', connection: 0.10, pride: 0.90, valence: 0.0, arousal: -0.5, immersion: 0.1 },
  { cluster: 'depressed', connection: 0.25, pride: -0.2, valence: -0.5, arousal: -0.5, immersion: 0.1 },
  { cluster: 'excited', connection: 0.05, pride: 0.0, valence: 0.5, arousal: 0.5, immersion: 0.1 },
  { cluster: 'agitated', connection: 0.30, pride: 0.40, valence: -0.5, arousal: 0.5, immersion: 0.1 },
  { cluster: 'sullen', connection: 0.20, pride: 0.10, valence: -0.5, arousal: 0.0, immersion: 0.1 },
  { cluster: 'restless', connection: 0.15, pride: 0.30, valence: 0.0, arousal: 0.5, immersion: 0.1 },
  { cluster: 'content', connection: 0.45, pride: 0.55, valence: 0.5, arousal: -0.5, immersion: 0.1 },
];

const blocks = [];
for (const st of REP_STATES) {
  blocks.push(['此刻/' + st.cluster, buildInjectionBlock(st, tg)]);
  blocks.push(['找她/' + st.cluster,
    buildProactiveNotice(st, tg, { scene: 'contact' }, cfg.sceneOverride, cfg.proactiveOutlet)]);
  for (const reason of ['pride_block', 'low_valence', 'high_arousal', 'default']) {
    blocks.push(['独处/' + reason,
      buildProactiveNotice(st, tg, { scene: 'find_activity', reason }, cfg.sceneOverride, cfg.proactiveOutlet)]);
  }
}

const cases = [];
const expect = [];

function add(label, text, wanted) {
  cases.push({ label, text });
  expect.push({ label, wanted });
}

// ① 正常：块 + 空行 + 她的话
for (const [label, blk] of blocks) {
  add('块+空行+话 · ' + label, blk + '\n\n' + HER_WORDS, HER_WORDS);
}
// ② 块 + 直接接她的话（无空行）
for (const [label, blk] of blocks.slice(0, 6)) {
  add('块+紧接话 · ' + label, blk + '\n' + HER_WORDS, HER_WORDS);
}
// ③ 回环轮：只有块，她一个字没说
for (const [label, blk] of blocks.slice(0, 6)) {
  add('仅块（回环轮）· ' + label, blk, '');
}
// ④ 对照组：纯她的话
add('纯她的话', HER_WORDS, HER_WORDS);
add('空串', '', '');

// ⑤ 特征化断言（记录既有行为，变化时会报警）
{
  const blk = blocks[0][1];
  // Serein 名单块一旦开启，空行关不掉；末行不对 → 后面全吞。
  add('特征化：块缺尾标记 → 她的话被吞', blk.split('\n').slice(0, -1).join('\n') + '\n\n' + HER_WORDS, '');
  // 一版/二版尾句不在 END_MARKERS 里 → 同样吞
  const v1 = ['【积温·此刻】', '心情：中性。', '正文。', V1_TAIL].join('\n');
  add('特征化：一版尾句块 → 她的话被吞', v1 + '\n\n' + HER_WORDS, '');
  const v2 = ['【积温·此刻】', '心情：中性。', '正文。', V2_TAIL].join('\n');
  add('特征化：二版尾句块 → 她的话被吞', v2 + '\n\n' + HER_WORDS, '');
  // 三/四版的内文相同（只差括号）。Serein 取标题要求行首是【，所以**裸内文尾行
  // 不算标题**（title=""），跳过态关不掉 → 她的话照样被吞。
  // 这一条是本文件唯一"两侧行为有意分歧"的用例：Serein 吞、本地 stripJiwenBlocks 不吞
  // （本地是给判定器洗输入用的，宁可多留也不能丢她的话）。
  const v3 = ['【积温·此刻】', '心情：中性。', '正文。', BOUNDARY_INNER].join('\n');
  add('特征化：裸内文尾行（三版形态）→ Serein 吞掉她的话', v3 + '\n\n' + HER_WORDS, '');
}

(async () => {
  let pass = 0, total = 0, skipped = false;
  const check = (name, cond, extra) => {
    total++;
    if (cond) pass++;
    console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}` +
      (extra !== undefined && !cond ? '  — ' + JSON.stringify(extra) : ''));
  };

  console.log('\n[1] 环境');
  const py = await pickPython();
  const src = pickSereinSrc();
  check('找到 python 解释器', !!py, py);
  check('找到 Serein 源码目录', !!src, src);
  if (!py || !src) {
    console.log('\nSKIP：环境不全，无法跑跨语言一致性。');
    process.exit(0);
  }
  console.log('  python: ' + py);
  console.log('  serein: ' + src);

  console.log('\n[2] 用 Serein 真实函数处理 ' + cases.length + ' 条语料');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jiwen-conf-'));
  const corpusPath = path.join(tmp, 'corpus.json');
  const outPath = path.join(tmp, 'out.json');
  fs.writeFileSync(corpusPath, JSON.stringify(cases), 'utf8');

  const r = await run(py, [path.join(__dirname, 'conformance_strip.py'), corpusPath, src, outPath]);
  if (!r.ok || !fs.existsSync(outPath)) {
    check('python 侧执行成功', false, { code: r.code, out: r.out, err: r.err });
    process.exit(1);
  }

  const raw = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  if (raw && raw.error) {
    check('导入 serein.chat_context 成功', false, raw.error);
    process.exit(1);
  }
  check('python 侧执行成功', true);

  console.log('\n[3] 逐条比对期望（python 返回 ' + raw.length + ' 条）');
  const byLabel = new Map(raw.map((x) => [x.label, x]));
  const mismatches = [];
  for (const e of expect) {
    const got = byLabel.get(e.label);
    if (!got) { mismatches.push({ label: e.label, why: '未返回' }); continue; }
    if (got.error) { mismatches.push({ label: e.label, why: got.error }); continue; }
    if (got.result.trim() !== e.wanted) {
      mismatches.push({ label: e.label, wanted: e.wanted, got: got.result.slice(0, 80) });
    }
  }
  check(`全部 ${expect.length} 条与期望一致`, mismatches.length === 0, mismatches.slice(0, 6));

  // 单独点名两类，便于一眼看出是哪一侧坏了
  const normal = mismatches.filter((m) => m.label.startsWith('块+') || m.label === '纯她的话');
  check('常规路径（块 + 她的话）全部只留下她的话', normal.length === 0, normal.slice(0, 4));
  const loop = mismatches.filter((m) => m.label.startsWith('仅块'));
  check('回环轮（仅块）全部被清成空', loop.length === 0, loop.slice(0, 4));

  // 本地剥离器与 Serein 一致性（同语料同期望）
  console.log('\n[4] 本地 stripJiwenBlocks 与 Serein 结果对齐');
  const localDiff = [];
  for (const e of expect) {
    if (e.label.startsWith('特征化') || e.label === '空串') continue;
    const mine = stripJiwenBlocks(e.label.startsWith('仅块') ? cases.find((c) => c.label === e.label).text
      : cases.find((c) => c.label === e.label).text).trim();
    if (mine !== e.wanted) localDiff.push({ label: e.label, wanted: e.wanted, mine: mine.slice(0, 80) });
  }
  check('本地剥离与 Serein 期望一致', localDiff.length === 0, localDiff.slice(0, 4));

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* 忽略 */ }

  console.log(`\n${pass}/${total} passed`);
  process.exit(pass === total ? 0 : 1);
})();
