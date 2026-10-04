'use strict';
// 真生气 vs 敷衍 · 判别专项验证
// 跑法：node _test/anger_check.js

const path = require('path');
const { loadEnvFile } = require('../lib/env.js');
loadEnvFile(path.join(__dirname, '..', '.env'));
process.env.LLM_MIN_INTERVAL_SECONDS = '0';
process.env.LLM_BREAKER_SECONDS = '0';

const { analyzeDialog } = require('../lib/analyzer.js');

const cfg = {
  llmBase: process.env.LLM_BASE || '',
  llmKey: process.env.LLM_KEY || '',
  llmModel: process.env.LLM_MODEL || '',
};

const CASES = [
  { name: '真生气（随便你/没意思/你忙吧）', expect: 'pride 必须为正 (+0.10~+0.25)', dialog: [
    { role: 'user', text: '你是不是觉得我很烦' }, { role: 'assistant', text: '没。' },
    { role: 'user', text: '随便你。没意思。你忙吧' }] },
  { name: '真生气（算了/当我没说）', expect: 'pride 必须为正', dialog: [
    { role: 'user', text: '你在听吗' }, { role: 'assistant', text: '在。' },
    { role: 'user', text: '算了，当我没说。就这样吧' }] },
  { name: '敷衍（单字哦）— 应保持 0', expect: 'pride = 0（对照项，不能被误升）', dialog: [
    { role: 'user', text: '早点睡' }, { role: 'assistant', text: '知道了。' },
    { role: 'user', text: '哦' }] },
  { name: '敷衍（纯省略号）— 允许 0 或负值，禁止正值', expect: 'pride ≤ 0（语境偏示弱可给负值）', tolerate: 'silence', dialog: [
    { role: 'user', text: '我今天有点累' }, { role: 'assistant', text: '早点休息。' },
    { role: 'user', text: '……' }] },
  { name: '撒娇（带 emoji + 追问）— 应保持 0', expect: 'pride ≈ 0（对照项）', dialog: [
    { role: 'user', text: '臭爹咪在吗' }, { role: 'assistant', text: '在。' },
    { role: 'user', text: '臭爹咪你理理我嘛，略略略 🙂' }] },
];

(async () => {
  console.log('真生气 vs 敷衍 判别专项（' + cfg.llmModel + '）\n');
  let pass = 0;
  for (const c of CASES) {
    try {
      const d = await analyzeDialog(c.dialog, cfg);
      const p = d ? d.pride : null;
      let ok = false;
      if (c.tolerate === 'silence') {
        // 「……」歧义输入：允许 0 或负值（示弱），但不得为正值（生气）
        ok = p !== null && p <= 0.03;
      } else if (c.name.startsWith('真生气')) {
        ok = p !== null && p > 0.05;
      } else {
        ok = p !== null && Math.abs(p) <= 0.03;
      }
      if (ok) pass++;
      console.log('─'.repeat(70));
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}`);
      console.log(`  预期: ${c.expect}`);
      console.log(`  实际: ${JSON.stringify(d)}`);
    } catch (e) {
      console.log('─'.repeat(70));
      console.log(`FAIL  ${c.name}  → ${e.message}`);
    }
  }
  console.log('─'.repeat(70));
  console.log(`${pass}/${CASES.length} 通过`);
})().catch((e) => { console.error(e); process.exit(1); });
