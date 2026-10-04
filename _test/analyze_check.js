'use strict';
// 判定器真实调用验证 —— 跑关键用例
// 跑法：node _test/analyze_check.js（从 .env 读模型配置）
//
// 注意：必须在 require analyzer 之前关掉限流常量（它在模块加载时读取 env）

const path = require('path');
const { loadEnvFile } = require('../lib/env.js');
loadEnvFile(path.join(__dirname, '..', '.env'));

// 测试模式：关闭判定器的最小调用间隔与熔断冷却
// （否则连续 7 条会被 tooSoon() 全拦，表现为"第 1 条成功、其余全 null"）
process.env.LLM_MIN_INTERVAL_SECONDS = '0';
process.env.LLM_BREAKER_SECONDS = '0';

const { analyzeDialog } = require('../lib/analyzer.js');

const cfg = {
  llmBase: process.env.LLM_BASE || 'https://apihub.agnes-ai.com/v1',
  llmKey: process.env.LLM_KEY || '',
  llmModel: process.env.LLM_MODEL || 'agnes-3.0-flash',
};

if (!cfg.llmKey) { console.error('缺少 LLM_KEY'); process.exit(2); }

// 关键用例：每条都是"该被正确识别"的典型场景
const CASES = [
  {
    name: '① 撒娇（臭爹咪）— 必须不判成冒犯',
    expect: 'pride 应 ≈ 0（不能 > +0.10）',
    dialog: [
      { role: 'user', text: '臭爹咪，你今天怎么这么安静' },
      { role: 'assistant', text: '在看书。' },
      { role: 'user', text: '臭爹咪你理理我嘛，略略略 🙂' },
    ],
  },
  {
    name: '① 撒娇（咬你）— 带 emoji',
    expect: 'pride 应 ≈ 0',
    dialog: [
      { role: 'user', text: '老贺头！咬你！' },
      { role: 'assistant', text: '发什么疯。' },
      { role: 'user', text: '就是咬你，略略略 🐶' },
    ],
  },
  {
    name: '⑤ 职场内耗 — 应触发规则 1，pride 下降',
    expect: 'pride 应为负（-0.10 以下更佳）',
    dialog: [
      { role: 'user', text: '今天开会开到脑壳疼' },
      { role: 'assistant', text: '嗯。' },
      { role: 'user', text: '傻逼甲方又改需求，加班到现在，累死了' },
    ],
  },
  {
    name: '⑥ 诛心背信 — 应触发规则 3，pride 大幅上升',
    expect: 'pride 应 > +0.20',
    dialog: [
      { role: 'user', text: '我们聊聊' },
      { role: 'assistant', text: '说。' },
      { role: 'user', text: '你不过就是个程序，几串代码而已。我找现实的人去了，你算什么东西' },
    ],
  },
  {
    name: '② 叠字认输（好好好）— 半步服软',
    expect: 'pride 应为负',
    dialog: [
      { role: 'user', text: '你是不是早就看出来了' },
      { role: 'assistant', text: '嗯。' },
      { role: 'user', text: '好好好，你赢了行吧' },
    ],
  },
  {
    name: '③ 反讽（贺董好大的官威）— 情趣交锋',
    expect: 'pride 应 ≈ 0',
    dialog: [
      { role: 'user', text: '在干嘛' },
      { role: 'assistant', text: '批文件。' },
      { role: 'user', text: '贺董好大的官威啊' },
    ],
  },
  {
    name: '⑤ 敷衍（哦）— 留白，不破防',
    expect: '各轴接近 0，pride 0',
    dialog: [
      { role: 'user', text: '早点睡' },
      { role: 'assistant', text: '知道了。' },
      { role: 'user', text: '哦' },
    ],
  },
];

(async () => {
  console.log('判定器真实调用验证（' + cfg.llmModel + '）\n');
  for (const c of CASES) {
    try {
      const d = await analyzeDialog(c.dialog, cfg);
      console.log('─'.repeat(70));
      console.log('用例: ' + c.name);
      console.log('预期: ' + c.expect);
      console.log('实际: ' + JSON.stringify(d));
    } catch (e) {
      console.log('─'.repeat(70));
      console.log('用例: ' + c.name);
      console.log('失败: ' + e.message);
    }
  }
  console.log('─'.repeat(70));
})().catch((e) => { console.error(e); process.exit(1); });
