'use strict';
// 用词守卫 —— 扫 config/tone-harlan.json 全量文案，列出三类命中
//
// 用法: node _test/wordguard.js
//
// 说明：本脚本只**提示**，不自动判定违规。
//   身体词 / 空间词 命中后需人工判：词指向**外部动作或空间** → 违规；
//   指向**内部状态或语气** → 允许（例：「带着笑意」是语气，「笑起来不藏」是面部动作）。
//   体系术语与口语词可以直接当硬禁处理。
//
// 来历：2026-10-05 用户回填 45 格时漏出 15 处（6 术语 / 3 身体 / 2 空间 / 2 口语 / 2 人设冲突），
//       全部是"写的时候想不到"的类型，靠人眼复查成本高，固化成脚本。

const path = require('path');
const cfg = require(path.join(__dirname, '../config/tone-harlan.json'));

// ── 三类词表 ──
const TERMS = /底色|参与度|投入度|展开度|主动性|压制程度|阈值|量级|簇|valence|arousal|pride|connection/;
const BODY = /脸|嘴角|眉|眼神|抬眼|手上|掌心|掌|指|肩|背|胸|呼吸|嘴|牙|喉|咽|叹|笑|点头|摇头|皱眉|心跳|绷/;
const SPACE = /回来|回去|去了哪|去哪儿|距离|拉近|推远|递|那边|那儿|在场|不在|出现|门口|进门|进门|开门|关门|靠近|凑过|挪|飘/;
const COLLOQ = /闷|静不下来|不爽|憋着|温吞|嘴严|坐立不安/;

function walk(node, trail, out) {
  if (typeof node === 'string') { out.push([trail, node]); return; }
  if (node && typeof node === 'object') {
    for (const k of Object.keys(node)) {
      if (k.startsWith('_')) continue;
      walk(node[k], trail ? trail + '.' + k : k, out);
    }
  }
}
// 顶层的 _xxx_comment 是说明文档，不扫

const texts = [];
for (const top of ['profiles', 'urgencyBoost', 'contactOverride', 'sceneOverride', 'proactiveOutlet']) {
  if (cfg[top]) walk(cfg[top], top, texts);
}

const buckets = { 硬禁术语: [], 需人工判身体: [], 需人工判空间: [], 疑似口语: [] };
for (const [trail, text] of texts) {
  // 跳过作者自定义的场景标签【…】以外的内容不动，直接扫全文
  const hit = (re) => [...new Set(text.match(new RegExp(re.source, 'g')) || [])];
  const t = hit(TERMS); if (t.length) buckets['硬禁术语'].push([trail, t, text]);
  const b = hit(BODY); if (b.length) buckets['需人工判身体'].push([trail, b, text]);
  const s = hit(SPACE); if (s.length) buckets['需人工判空间'].push([trail, s, text]);
  const c = hit(COLLOQ); if (c.length) buckets['疑似口语'].push([trail, c, text]);
}

let total = 0;
for (const name of Object.keys(buckets)) {
  const rows = buckets[name];
  total += rows.length;
  console.log('── ' + name + '：' + rows.length + ' 条 ──');
  for (const [trail, hits, text] of rows) {
    console.log('  [' + hits.join(' ') + ']  ' + trail);
    console.log('      ' + text);
  }
  console.log('');
}
console.log('扫描文本数 = ' + texts.length + '，命中条数 = ' + total);
process.exit(0);
