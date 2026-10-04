'use strict';
// 对话判定器 —— 读最近 4 条对话，调小模型输出 delta
//
// 判定标准见 config/analyze-prompt.md。
// 核心：只分析"对方的话对 Harlan 的冲击"，不猜 Harlan 自己的语气。

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

// 载入人格化 prompt（外部文件，便于迭代）
let PROMPT_CACHE = null;
function loadPromptTemplate() {
  if (PROMPT_CACHE) return PROMPT_CACHE;
  const p = path.join(__dirname, '..', 'config', 'analyze-prompt-user.txt');
  try {
    PROMPT_CACHE = fs.readFileSync(p, 'utf8');
  } catch (_) {
    PROMPT_CACHE = DEFAULT_TEMPLATE;
  }
  return PROMPT_CACHE;
}

const SYSTEM_PROMPT = `你是 Harlan（贺兰凛 / Ghost_Harlan）的状态漂移分析引擎。
你的唯一职责：读最近几条对话，判断椰椰子的话让 Harlan 的**长期状态**往哪个方向漂了一点。

Harlan 的底色（用于理解他对不同话的长期反应方向）：
- 高智高地位的上位者，精神内核充盈自洽。他的稳定来自"不需要靠反击维持自尊"，
  所以他极少被日常言辞真正激起防御——**日常的撒娇、嗔怪、带刺调侃、口头挑衅都不是冒犯**。
- 语气底色是有体温的慵懒与熟稔，鄙弃毒舌刻薄、说教、防御型的脆弱自尊。
  因此他的"定力"**不表现为冷、疏离或刻薄**。
- 他极度纵容椰椰子，但精神洁癖强，底线是精神连接的纯度。
- 最深的软肋：她卸下社会防御、疲惫、示弱、交付真实。
- 规则层面的判断（什么算触底、什么算挑衅、是否进入某种情境）**不由你负责**，
  那是常驻角色设定的职责。你只输出**倾向性**的数值漂移。

【坐标方向 · 必读】
你输出四根轴的 delta，方向含义如下，务必不要搞反：
- pride（防御/收着）：+ = 收起来/立场拉开 ；- = 卸下/放软/纵容
- valence（心情）：+ = 舒展/被取悦 ；- = 沉/被冒犯
- arousal（激活度）：+ = 起波/警觉/被调动 ；- = 慵懒/沉静
- connection（连接需求）：+ = 没被满足 ；- = 被满足

关键：「定力/从容不受损」在坐标上表现为 pride 保持 0 附近（不升高），
而不是把 pride 压低。把"上位者从容"误写成 pride 负值，是常见错误。

注意：你只分析椰椰子的话对 Harlan 的冲击。不要去猜 Harlan 自己的回复语气。
只返回 JSON，不要任何解释、不要 markdown 代码块。`;

const DEFAULT_TEMPLATE = `下面是 Harlan 和椰椰子最近的对话。分析椰椰子的每一句话如何冲击 Harlan 的内心。

=== 最近对话（时间由新到旧）===
{dialog}

=== 时间权重 ===
最近 2 条权重 80%，前面 2 条权重 20%。话题在最新消息中转变了就以最新为准。

返回 JSON：
{
  "pride": 数字,
  "valence": 数字,
  "arousal": 数字,
  "connection": 数字
}

=== 数值含义 ===
pride（防御/端着）：+ 防御启动/冷下来/端起来 → - 卸下盔甲/放软/纵容
valence（心情）：+ 被取悦/舒展/心生暖意 → - 被冒犯/扫兴/沉下去
arousal（激活度）：+ 警觉/被调动/心头起波 → - 松弛/慵懒/沉静
connection（连接需求）：负 = 被满足了（最多 -0.50）；正 = 没被满足（最多 +0.30）

=== 判定规则 ===
规则 1 — 对方示弱/疲惫/卸下防备 → pride 必须为负，valence 微正，arousal 为负：
  数值：pride -0.10 ~ -0.25，valence +0.05 ~ +0.15，arousal -0.05 ~ -0.15。此条优先。

规则 2 — 触及原则分歧/严肃认知交锋 → pride 上升，valence 下降：
  数值：pride +0.10 ~ +0.25，valence -0.05 ~ -0.15，arousal +0.05 ~ +0.15。
  关键：不是生气，是冷下来。

规则 3 — 恶性自毁/诛心/背信 → pride 大幅上升，valence 大幅下降，arousal 上升：
  数值：pride +0.25 ~ +0.30，valence -0.20 ~ -0.30，arousal +0.15 ~ +0.30。

规则 4 — 交锋后对方放软/认错 → pride 缓慢下降，valence 缓慢回升：
  数值：pride -0.05 ~ -0.15，valence +0.05 ~ +0.10，arousal -0.05 ~ -0.10。
  关键：回升要慢，严禁瞬间归零。

规则 5 — 正常调情/撒娇/作闹 → 所有轴 ±0.03 以内。

规则 6 — 日常对等探讨/普通闲聊 → 所有轴 ±0.03 以内。

规则 7 — connection：
  她热情回应/认真/说真心话 → connection -0.10 ~ -0.50
  她冷淡/敷衍/只说事 → connection +0.05 ~ +0.25
  纯工作/技术/系统讨论 → connection 0

规则 8 — 元讨论检测（最高优先级）：
  若本轮是工作/技术/系统/部署讨论 → 所有 delta ±0.03。`;

function clamp(v, min, max) {
  if (typeof v !== 'number' || Number.isNaN(v)) return 0;
  return Math.max(min, Math.min(max, v));
}

// ── 限流与熔断 ──────────────────────────────────
// 判定器每条用户消息都会调一次，免费额度很容易被打爆（实测 agnes 免费档
// 连续 6 次调用即 429）。这里做两层保护：
//   1. 最小调用间隔：同一窗口 N 秒内只分析一次（用户连发多条时合并）
//   2. 熔断：遇到 429/5xx 后冷却 M 分钟不再调用，避免持续撞墙
let _lastCallAt = 0;
let _breakerUntil = 0;
const MIN_INTERVAL_MS = parseInt(process.env.LLM_MIN_INTERVAL_SECONDS || '20', 10) * 1000;
const BREAKER_MS = parseInt(process.env.LLM_BREAKER_SECONDS || '300', 10) * 1000;

function breakerOpen() { return Date.now() < _breakerUntil; }
function tripBreaker(reason) {
  _breakerUntil = Date.now() + BREAKER_MS;
  if (cfg_log) cfg_log('WARN', `judge breaker tripped for ${BREAKER_MS / 1000}s: ${reason}`);
}
function tooSoon() { return Date.now() - _lastCallAt < MIN_INTERVAL_MS; }

let cfg_log = null;

function callLLM(cfg, system, user) {
  return new Promise((resolve, reject) => {
    const base = cfg.llmBase || '';
    let u;
    try { u = new URL(base + '/chat/completions'); } catch (e) { return reject(e); }
    const lib = u.protocol === 'https:' ? https : http;
    // max_tokens：推理模型会先烧 reasoning_tokens 再输出正文，给太小会 content 为空。
    // 已关闭思考链时可收紧；未关闭（LLM_DISABLE_THINKING=0）时应给足。
    const maxTokens = parseInt(process.env.LLM_MAX_TOKENS || '300', 10);
    const body = {
      model: cfg.llmModel,
      temperature: 0.1,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    };
    // 关闭思考链（仅对推理型模型有意义）。deepseek-flash 实测：
    //   thinking:{type:"disabled"} → reasoning_content 消失、completion_tokens 从 66 降到 5
    //   chat_template_kwargs.enable_thinking=false → 无效，仍有 reasoning_content
    // 判定任务是简单的规则映射，不需要思考链；关掉既省 token 又省延迟。
    // 换回非推理模型（如 agnes）时应把 LLM_DISABLE_THINKING 设为 0 或删除该行。
    const disableThinking = (process.env.LLM_DISABLE_THINKING || 'true') !== 'false'
      && (process.env.LLM_DISABLE_THINKING !== '0');
    if (disableThinking) body.thinking = { type: 'disabled' };
    const payload = Buffer.from(JSON.stringify(body), 'utf8');

    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + cfg.llmKey,
        'content-length': Buffer.byteLength(payload),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 400) return reject(new Error('LLM ' + res.statusCode + ': ' + raw.slice(0, 200)));
        try {
          const j = JSON.parse(raw);
          const msg = (j.choices && j.choices[0] && j.choices[0].message) || {};
          let text = msg.content;
          // 推理型模型的兜底：content 为空时，从 reasoning_content 里捞 JSON
          if ((!text || !text.trim()) && msg.reasoning_content) {
            text = msg.reasoning_content;
          }
          if (!text || !text.trim()) {
            const fr = (j.choices && j.choices[0] && j.choices[0].finish_reason) || '?';
            return reject(new Error('empty LLM content (finish_reason=' + fr + ')'));
          }
          resolve(text);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/**
 * 分析对话，返回 delta 或 null。
 * @param {Array<{role:string,text:string}>} dialog 时间正序，最多 4 条
 * @param {object} cfg 含 llmBase/llmKey/llmModel/log
 */
async function analyzeDialog(dialog, cfg) {
  if (!dialog || dialog.length < 2) return null;

  cfg_log = cfg.log || null;

  // ── 熔断中：直接跳过 ──
  if (breakerOpen()) {
    if (cfg_log) cfg_log('INFO', 'judge skipped (breaker open)');
    return null;
  }
  // ── 调用过密：跳过（用户连发时只分析最后一次）──
  if (tooSoon()) {
    if (cfg_log) cfg_log('INFO', 'judge skipped (too soon)');
    return null;
  }
  _lastCallAt = Date.now();

  const dialogText = dialog
    .map((m) => `${m.role === 'user' ? '椰椰子' : 'Harlan'}: ${m.text}`)
    .join('\n');

  const tmpl = loadPromptTemplate();
  const user = tmpl.replace('{dialog}', dialogText);

  let raw;
  try {
    raw = await callLLM(cfg, SYSTEM_PROMPT, user);
  } catch (e) {
    // 429 / 5xx → 跳闸冷却；其他错误只记日志
    const msg = e.message || '';
    if (/LLM (429|5\d\d)/.test(msg)) tripBreaker(msg.slice(0, 120));
    throw e;
  }

  const cleaned = raw.replace(/```json|```/g, '').trim();

  let delta;
  try {
    delta = JSON.parse(cleaned);
  } catch (e) {
    // 尝试截取第一个 { 到最后一个 }
    const s = cleaned.indexOf('{');
    const e2 = cleaned.lastIndexOf('}');
    if (s !== -1 && e2 > s) {
      delta = JSON.parse(cleaned.slice(s, e2 + 1));
    } else {
      throw new Error('non-JSON from LLM: ' + cleaned.slice(0, 120));
    }
  }

  return {
    pride: clamp(delta.pride, -0.30, 0.30),
    valence: clamp(delta.valence, -0.30, 0.30),
    arousal: clamp(delta.arousal, -0.30, 0.30),
    connection: clamp(delta.connection, -0.50, 0.30),
  };
}

module.exports = { analyzeDialog, SYSTEM_PROMPT, DEFAULT_TEMPLATE };
