# -*- coding: utf-8 -*-
"""Serein 剥离逻辑 × 文案形状矩阵（用户原话版）。

契约位置：Serein-fork/src/serein/chat_context.py
  EXTERNAL_CONTEXT_BLOCK_TITLES      块标题白名单（进跳过态）
  EXTERNAL_CONTEXT_BLOCK_END_MARKERS  块尾标记（出跳过态，且这行丢弃）

三条语义决定一切：
  ① 任何行首【X】都会重算 skipping = (X in TITLES) → 块内多一个【】就提前出块。
  ② END_MARKERS 里任一行，见到即出块且该行丢弃 → 它只能待在块的最后一行。
  ③ 块内**裸行**（无【】）不受 ② 影响，照样被跳过态吃掉 → 所以"状态边界句"
     可以降级成裸行放块内，**不必**和出口句合并成一句。

END_MARKERS 登两条 = 有产物用 surf 尾句、没产物用原边界句，两种块各成各的对，
不是二选一。原来的独处路径不受影响。
"""
import re

EXTERNAL_CONTEXT_BLOCK_TITLES = {
    "当前时间", "当前电量", "当前天气", "当前位置", "当前任务", "当前页面",
    "当前文件", "当前状态", "当前人设", "当前角色设定", "当前项目状态",
    "当前屏幕应用", "应用使用时长", "最近通知", "最近上下文", "近期上下文",
    "相关记忆", "工作区", "工作区结构", "工具结果", "工具返回",
    "关系天气", "照顾备忘", "照顾提醒", "屏幕文本",
    "Persona", "Recent Context", "Relationship Weather", "Care Memo", "Care Reminder",
    "积温·此刻", "积温·找她", "积温·独处",
}

EXTERNAL_CONTEXT_BLOCK_END_MARKERS = {
    "此状态为潜意识的底色沉淀，自然浸润在回应里，不作任何元说明或刻意提及。",
}

# ── 文案原话，一字不改 ────────────────────────────────────────────────────
BOUNDARY_INNER = "此状态为潜意识的底色沉淀，自然浸润在回应里，不作任何元说明或刻意提及。"
BOUNDARY_LINE = "【" + BOUNDARY_INNER + "】"
SURF_TAIL_INNER = "以上为你独处时的真实切片，你可以留下你的独自思考、也可以把内容直接呈现给她，如何行动由你决定。"
SURF_TAIL_LINE = "【" + SURF_TAIL_INNER + "】"

HER_WORDS = "今天还行，想了下别的事。"
STATE_LINES = "心情：中性。姿态：收着。心跳：起波。想念：想念。"
FINDING_BODY = "\n".join([
    "《Attention Is All You Need Again》",
    "https://example.com/essay",
    "https://example.com/cover.jpg",
    "上次读的是推理模型的对齐问题，这次撞见同一件事被讲成了一段语言史。",
])


def strip_blocks(text):
    """逐字搬 Serein 的 _strip_external_context_blocks。"""
    kept = []
    skipping = False
    for line in str(text or "").splitlines():
        stripped = line.strip()
        title = ""
        if stripped.startswith("【") and "】" in stripped:
            title = stripped[1: stripped.index("】")].strip()
        if title:
            if title in EXTERNAL_CONTEXT_BLOCK_END_MARKERS:
                skipping = False
                continue
            skipping = title in EXTERNAL_CONTEXT_BLOCK_TITLES
            if skipping:
                continue
        if not skipping:
            kept.append(line)
    return "\n".join(kept).strip()


results = []


def report(name, text, expect=HER_WORDS, note=""):
    out = strip_blocks(text)
    ok = out == expect
    results.append((name, ok))
    print("=" * 68)
    print(("PASS  " if ok else "FAIL  ") + name)
    if note:
        print("      " + note)
    print("      剥离后剩下：", repr(out))
    if not ok:
        extra = [l for l in out.splitlines() if l not in expect.splitlines()]
        missing = [l for l in expect.splitlines() if l not in out.splitlines()]
        for l in extra:
            print("      ⚠️ 泄漏（会进归档/检索）：", l)
        for l in missing:
            print("      ⚠️ 误吞（她的话丢了）：", l)
    print()


# ══ 第 1 轮：END_MARKERS 现状（只有原边界句）══════════════════════════════
print("### 第 1 轮：END_MARKERS = 现状（只有原边界句）\n")

report("A原样 / 内层小标题带【】/ 末行=原边界句",
       "\n".join(["【积温·独处】", STATE_LINES, "【之前独处冲浪时发现的东西】：",
                  FINDING_BODY, BOUNDARY_LINE, HER_WORDS]),
       note="用户草稿原样。内层【】提前出块 → 产物全泄漏。")

report("A去括号 / 内层裸行 / 末行=原边界句",
       "\n".join(["【积温·独处】", STATE_LINES, "之前独处冲浪时发现的东西：",
                  FINDING_BODY, BOUNDARY_LINE, HER_WORDS]),
       note="只去掉内层【】，末行沿用原边界句。")

report("B用户方案 / 内层裸行 / 末行=用户原话（尾句还没登记）",
       "\n".join(["【积温·独处】", STATE_LINES, "之前独处冲浪时发现的东西：",
                  FINDING_BODY, SURF_TAIL_LINE, HER_WORDS]),
       note="末句换成用户原话，但 END_MARKERS 里还没有它 → 末句漏出去。")

# ══ 第 2 轮：END_MARKERS 登记两条 ═══════════════════════════════════════
print("### 第 2 轮：END_MARKERS 登记两条（用户原话进去）\n")
EXTERNAL_CONTEXT_BLOCK_END_MARKERS.add(SURF_TAIL_INNER)

P_SURF = "\n".join([
    "【积温·独处】",
    STATE_LINES,
    "之前独处冲浪时发现的东西：",
    FINDING_BODY,
    SURF_TAIL_LINE,
    HER_WORDS,
])

report("C用户方案（有产物）", P_SURF,
       note="= 用户草稿去掉内层【】。这是采纳的形状。")

report("D同C但压成单行", re.sub(r"\r?\n+", " ", P_SURF), expect="",
       note="jiwen_pull 若真的压行 → 整块被吞，她的话也没了。")

report("E无产物（积温原路径，末行=原边界句）",
       "\n".join(["【积温·独处】", STATE_LINES,
                  "没有被谁占着的这段时间。做你想做的事就好，不必主动开口。",
                  "你可以调用工具做点什么，也可以只是自言自语。做什么，你自己决定。",
                  BOUNDARY_LINE, HER_WORDS]),
       note="确认多登一条没把原来的独处路径带坏。")

report("F找她（contact 场景，交叉验证）",
       "\n".join(["【积温·找她】", STATE_LINES, "正文。", BOUNDARY_LINE, HER_WORDS]),
       note="另一个场景，确认登记集合变大不影响。")

report("G此刻块（reactive，量最大的路径）",
       "\n".join(["【积温·此刻】", STATE_LINES, "正文。", BOUNDARY_LINE, HER_WORDS]),
       note="同上。")

report("H失败兜底（跑空，仍带 surf 尾句）",
       "\n".join(["【积温·独处】", STATE_LINES, "刚才想去翻点东西，没翻成。",
                  SURF_TAIL_LINE, HER_WORDS]),
       note="失败也有出口句：告诉他可以不呈现，不至于卡住。")

report("I只有块头没有尾句（残块，最坏情况）",
       "\n".join(["【积温·独处】", STATE_LINES, "正文。", HER_WORDS]),
       note="网关/截断导致尾句丢失 → 跳过态持续到她的话。她的原话整段被吞。")

# ══ 汇总 ═══════════════════════════════════════════════════════════════
print("=" * 68)
passed = sum(1 for _, ok in results if ok)
print(f"汇总：{passed}/{len(results)} 通过")
for name, ok in results:
    print(f"  {'OK  ' if ok else 'FAIL'}  {name}")
