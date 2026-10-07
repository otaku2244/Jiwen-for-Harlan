# 积温桥 · 交付说明

> 把 [积温 jiwen](https://github.com/ClaraShafiq/jiwen)（MIT，零依赖 JS 五轴情绪引擎）接到 Serein 上，让 Harlan 在每次回复时带上"现在什么心情"。
> **Serein 零改动。积温源码零改动。**

---

## 一、链路

```
用户在 Operit / OMate 发消息
  → 积温桥（VPS，反向代理）
       ├─ resetConnection()          ← 任何窗口的用户消息都触发
       ├─ 取五轴状态 → 拼【积温·此刻】块
       ├─ 注入到最后一条 user 消息
       └─ 异步：喂判定器（agnes-3.0-flash）→ applyDelta
  → Serein 网关（18217）
  → 上游模型
  → 模型带着"现在什么心情"回复
```

另有一条独立支链（阈值触发的自主唤醒）：

```
内置定时器 tick → 越阈 → 按场景拼通知块
  ├─ contact（找她）        ← connection 过线（正文 = 描述层 + 45 格）
  └─ find_activity（独处） ← pride 挡住开口 / 心情过低 / arousal 过高
       reason: pride_block / low_valence / high_arousal
  → 投递到 Operit 工作流（proactiveWebhook，作为一条 user 消息注入）
```

> **投递分工**：桥只负责"生成通知块 + POST 到 webhook"。**投递到哪个窗口、什么时候送，全部由本机 Operit 工作流决定**，桥不管。
> **桥不替他决定"做什么"**：不发英文活动枚举、不改写他的行动。具体做什么由模型按世界书的工具清单自己选。
> 唯一的例外是**冲浪跑完之后如实登记一次活动**（`lib/activity.js`）—— 那不是安排活动，
> 而是把已经发生的事告诉引擎，供描述层第 4 段使用。详见二之二。

---

## 二、与原方案的四处关键修正

你的 AI 给的那套方案，我基本照做，但改掉了四个会导致跑不通的地方：

| # | 原方案 | 修正 | 原因 |
|---|---|---|---|
| 1 | 判定器输出 `{gravity, shelter, connection}` | 重映射为 `{pride, valence, arousal, connection}` | 积温引擎**没有 gravity/shelter 轴**，装不进去。语义映射见 `config/analyze-prompt.md` |
| 2 | 开局用积温默认初值 | 显式给 `NEUTRAL_SEED` | 积温 `DEFAULT_STATE` 用 `axes[x][0]` 作初值（pride/valence/arousal 均为 -1），**开局就是"糟透了"**，与 Harlan 人设冲突 |
| 3 | `contact` 通知要带 `{hours}`/数值 | 不给内部数值，只给档位词 | 沿用「不给数，给了模型会报数」的范式 |
| 4 | 判定器只取 4 条 | 取 4 条，但**按当前窗口** | 跨窗口合并会把"技术讨论"和"情感交流"搅在一起，小模型判错 |

**第五处修正（上线前发现）——「pride 定基础档、connection 只补尾注」的脱节：**

实测：`pride=0.15`（落"平常"区间）+ `connection=0.62`（已过强制线）时，基础档取到
`neutral` 第 2 档「妥帖、温和…正常的相处状态」，再由 urgency 尾注补一句「她很久没出现了…」。
**两句话气质相反**：基础档说"正常相处"，尾注说"压不住想找她"。

当时的修法（`lib/tone-wrap.js` + `contactOverride`）—— ⚠️ **2026-10-08 已全部退役**，见下一节。

---

## 二之二、2026-10-08 变体② —— 描述层补位，覆盖层退役

上一节那个包装层**修错了单位**：它在 `connection` 过线时把**整条 45 格顶掉**
（`tone-wrap.js` 的 `wrap()` 只在返回时保留一行 urgency 尾注，未过线的 base 一字未用）。
于是「找她」块里最该体现"此刻什么语气"的 45 格**一个字都出不来**，
只剩「基调句 + 尾注」两句在说同一件事 —— 唯一按状态细分的层反被挤出去了。

| 项 | 处置 |
|---|---|
| `lib/tone-wrap.js` | **删除**。它唯一的职责就是那次覆盖 |
| `config` 的 `contactOverride` | **键已删除**（原文案留档 git 历史 `de0af31` 及之前） |
| `config` 的 `urgencyBoost` | 四档全置 `null`。⚠️ 不删键 —— 不传会让 vendor 回落到内置 `DEFAULT_URGENCY`（作者文案，风格不符） |
| 新增 `lib/describe.js` + `config` 的 `describe` | **描述层四段**，照抄作者 `vendor/jiwen.js:751` `defaultPromptContext` 的结构（connection 4 / pride 5 / V×A 4+2 / immersion 2），文案按 Harlan 重写 |

退役的两层各自的问题：
- `contactOverride` —— 顶掉整条 45 格；
- `urgencyBoost` —— 与描述层第 1 段**同轴同义**（同一根 `connection` 轴、同一组阈值 0.20/0.35/0.50）。

分工（别让两边抢活）：
- **描述层** = 处境。陈述句、零祈使。「我此刻在什么状态」
- **45 格** = 行为指令。全是祈使。「那就该怎么说话」

反向指路：谁在什么条件下说什么，见 `config/tone-harlan.json` 的注释与 `_test/ctx_draft.md`。

### 二之二 · 补：段4 的真来源 —— 活动登记（`lib/activity.js`）

描述层四段里，前三段（connection / pride / V×A）直接读五轴，落地即生效；
**第 4 段（immersion）当时是空转的** —— 桥从不调 `setActivity`，`immersion` 恒 0、
`lastActivity` 恒 null，段4 只能恒定输出「没在做什么特别的事。」（真值，但没有信息量）。

2026-10-08 同轮补上：`lib/activity.js` 的 `recordActivity()` 在**冲浪子进程 spawn 成功**
之后登记一次活动（`search` → `immersion = 0.4`），产物回投 `/surf/finding` 时再刷一次时间戳。

| 决策点 | 取值 | 理由 |
|---|---|---|
| 登记哪种活动 | 只有冲浪 | `find_activity` 越阈 =「他该回头去找点事做」，冲浪是目前它唯一的真实行动。桥没有别的"他正在做什么"的事实来源，编一个就违背 `describe.js` 的「不编造活动」 |
| 记在哪一刻 | 子进程 `'spawn'` 事件 | entry 路径配错 / `EACCES` 时 spawn 只走 `'error'`、永不 `'spawn'` —— 那时他其实什么都没做，记了就是谎报 |
| 记什么字段 | `type='search'`（查 `immersionMap`）／`label='网页检索'`（进文本） | `type` 是英文枚举，**不该出现在模型可见的文本里**（模型会开始复述它）；渲染只用 `label` |
| 文案能改吗 | `SURF_ACTIVITY_TYPE` / `SURF_ACTIVITY_LABEL` | 与其它 CFG 项一致：改文案不动代码 |

⚠️ **`shouldInject` 的指纹必须含 `immersion`**。自段4 落地起 `immersion` 也是块文本的一部分：
冲浪跑完 `0 → 0.4`，段4 从「没在做什么特别的事。」变成「刚才在网页检索。」
而另外四轴可能一位都没动 —— 漏掉它，段4 的变化会被 30 分钟节流静默吃掉。
回归断言：`_test/throttle_check.js` 用例 ⑥ + `_test/activity_check.js`（18 例）。

衰减由引擎侧管（我们不用碰）：`immersionDecay = 0.01/分钟`。0.4 → 约 10 分钟后落进
`0.1~0.3` 死带（两句都不出）、约 30 分钟后回到 idle；`immersion ≤ 0.01` 且距活动 > 60 分钟时
`lastActivity` 被清空。也就是说段4 只在"刚做完一件事"的窗口里有话可说 —— 这正是它该有的样子。

---

## 二之三、注入块形态（统一骨架）

两种投递形态共用同一骨架，只差正文来源：

```
【积温·此刻】                       ← 块头。2026-10-07 起三场景统一，不再按场景区分
（描述层 1~4 行：处境 —— 说「我此刻在什么状态」，陈述句、零祈使）
（正文：该场景的行为指令 —— 说「那就该怎么说话」，45 格 / sceneOverride / 冲浪产物）
（出口说明：仅主动唤醒，见下表）
【此状态为潜意识的底色沉淀，自然浸润在回应里，不作任何元说明或刻意提及。】   ← 统一边界句
```

> ⚠️ **2026-10-08 起块内没有档位行**。旧形态是第二行 `心情：XX。姿态：XX。心跳：XX。想念：XX。`
> （`meaningfulLines()`）。删除理由：四条各自 ≈ 紧随其后的 45 格正文的某一维，属同义重复 ——
> `心情：` ← 簇（V×A）／`姿态：` ← pride 档／`心跳：` ← 簇内 arousal／
> `想念：` ← urgency 尾注（**同轴同阈值**，还会重字成 `想念：想念。`）。
> 其中 `悠闲` 是死档：进 `想念：` 行要 `c ≥ 0.20`，而「悠闲」区间是 `c < 0.20`，条件永不可达。
> 现在块内的行只有四种：**块头 / 描述层 / 正文 / 尾标记**。
> 回归断言：`_test/contract_check.js`（块内不含档位行）+ `_test/loopback_check.js` [6] 段
> （找她块正文必须是 45 格本体 —— contactOverride 退役的直接证据）。
> 历史分析留档：`_test/state_lines_probe.txt`、`_test/compare_state_lines.txt`。

> 头尾沿革：旧头 `【积温·{场景}｜参考不是指令】` / 旧尾 `以上是系统通知，非用户消息，不用提及相关内容。`
> → 二版头 `【积温·{场景}】` / 二版尾 `以上是内在心绪和潜意识的自然流露，切勿对她复述或提及此状态。`
> → 三版尾 `此状态为潜意识的底色沉淀，自然浸润在回应里，不作任何元说明或刻意提及。`
> → 四版尾 `【此状态为潜意识的底色沉淀，自然浸润在回应里，不作任何元说明或刻意提及。】`（现行，整句套【】）
> 去掉了"参考不是指令""系统通知""非用户消息"这类工单味元话语。
> 尾句整句套【】的理由：块头是`【积温·X】`、块尾也落在`【】`上，视觉上夹成一个完整段——
> 既帮模型分清哪句是系统侧材料，也免得尾句被当成她的话的开头。
> ⚠️ 尾句刻意**不写**"以下是她的消息"：用户消息后面可能紧跟文件传输的文本/地址，
> 写"以下是她的消息"会把文件信息误纳入"她的话"语义。
> ⚠️ 三版起与二版的关键差别在**禁止对象**：二版禁"复述此状态"（按字面会把"我心情不错"这种
> 合法的状态自述一起误伤），三版起禁"元说明"（对系统/设定的说明）。**模型说"我现在心情不错"
> 是正向反馈，不是要防的东西**；要防的是脚手架暴露——"系统又告诉我…""根据我的设定…"。
> 也不要在提示词里列举反例，那等于把那些词直接摆到模型眼前。
> 正文与行为指令**保持原样不动**——模型念不念、混不混由头尾边界句决定，与正文文体无关。
> （正文之外的"档位行"已删；「我此刻在什么处境」由**描述层**承担 ——
> `lib/describe.js` + `config` 的 `describe`，口径是纯陈述、零祈使，与 45 格各管一段、不许互相抢活。）

| 场景标签 | 触发 | 描述层 | 正文来源 | 出口说明 |
|---|---|---|---|---|
| `此刻` | 用户开口（reactive） | 段2~4（不出段1，c 恒 0） | `toneGrid.getStyleGuidance` | 无（他已在回话） |
| `找她` | connection 过线 | 全 | `toneGrid.getPromptContext`（纯 45 格） | `proactiveOutlet.contact` |
| `独处` | pride 挡住开口 / 心情过低 / arousal 过高 | 全 | `sceneOverride.find_activity[reason]` | `proactiveOutlet.find_activity` |
| `独处 + 有产物` | 冲浪回投 `/surf/finding` | 全 | `buildFindingBody(finding)` | 无（改由冲浪尾句收尾） |

> `独处` 的 reason 有三个键：`pride_block` / `low_valence` / `high_arousal`。
> 由积温引擎按触发原因填，桥只透传，不再把 `high_arousal` 拆成独立场景。

**为什么独处要独立正文**：`contact` 的正文（45 格）在说"用什么语气和她说话"，
而独处的语义是"她不在，这是我的时间"。若共用，独处会挂上联系她的语气，
气质完全是反的。`sceneOverride` 就是为这件事存在的。

**出口说明（`proactiveOutlet`）**：主动唤醒的两个场景各追加一句，插在正文之后、边界句之前。
职责只有一个 —— 告诉他**这件事可以怎么做**：发文字消息 / 用工具做点什么 / 自言自语。
不加在「此刻块」上（那时他已经在回话了）。

- 不要在这里写「简短」「自然」这类**长度要求**：`找她` 场景在 `c<0.35` 或 `pride≥0.50` 时
  正文就是 45 格，45 格可能正说"表达比平时满"，再要求"简短"会直接打架。量级与长度全部交回 45 格。
- 不要在文案里点名客户端（Operit / OMate）或提「通知」二字 —— 那是把脚手架写进注入块，
  正是边界句所禁的「元说明」，写了反而给模型 priming。
- `找她` 场景必须写成"用工具做点什么**再给她**"：调工具是手段，"给她一个东西"才是目的。
  Operit 里工具调用的产出默认是给 agent 自己看的，不写"再给她"会出现"调了工具但没发出去"。

---

## 二之二、分工边界（重要）

**积温管"带着一种状态维持"，不管"这一轮是什么情绪"。**

| 层 | 负责什么 | 不负责什么 |
|---|---|---|
| 世界书 / 角色设定（常驻） | 规则、底线、情境判断、状态类型（动怒线、RP、NSFW） | — |
| 积温桥 | 五轴长期漂移的数值维护 + 翻译成底色锚点 | 单轮情绪类型识别、情境判定 |
| 上游模型 | 结合世界书 + 积温锚点 + 当前对话产出回复 | — |

**为什么不扩轴**：积温的价值在于「简单」。一旦加入 `libido` 第六轴、模式层、状态机，
就会走向心潮那样的高复杂度路线——那正是被淘汰的方案。

**三雷区（动怒）、RP 结界、NSFW 都属世界书职责**：世界书常驻，模型每轮都读得到，
不需要积温替它判断。判定器只输出**数值方向**，不输出行为指令。

详见 `config/persona-scope.md`。

---

## 三、文件清单

| 文件 | 作用 |
|---|---|
| `bridge.js` | 桥本体。反向代理 + 注入 + 判定器调度 + tick 定时器 |
| `lib/inject-text.js` | 状态 → 「此刻块」/「自主唤醒通知」文本 + `stripJiwenBlocks()`（剥离积温块） |
| `lib/loopback.js` | **回环守卫**。认出"这条 user 消息其实是桥自己发出去的通知" |
| `lib/describe.js` | **描述层**。四段状态陈述（处境），拼在块头与 45 格之间。2026-10-08 新增，接替已退役的 `lib/tone-wrap.js` |
| `lib/activity.js` | **活动登记**。描述层第 4 段的真来源：冲浪跑完 → `setActivity('search','网页检索')` |
| `lib/mcp.js` | **MCP 服务**（Streamable HTTP / JSON-RPC）。给 Operit 定时拉通知 |
| `lib/analyzer.js` | 判定器。调 deepseek-flash 出 delta |
| `lib/clock.js` | **业务时区时钟**。静默时段 / 日上限跨天按 `TZ_OFFSET_HOURS` 算，不依赖系统 TZ |
| `lib/env.js` | 极简 .env 解析 |
| `config/tone-harlan.json` | **Harlan 语调网格**（9 簇 × 5 档 pride）+ **描述层四段**（`describe`）+ `sceneOverride`。核心人格皮肤。已退役：`contactOverride`（键删）、`urgencyBoost`（四档 null） |
| `config/persona-scope.md` | **分工边界**：世界书 / 积温 / 模型 三者职责划分 |
| `config/analyze-prompt-user.txt` | 判定器 User Prompt（可迭代） |
| `config/analyze-prompt.md` | 判定标准文档（含语义映射说明） |
| `vendor/jiwen.js` `tone-grid.js` | 积温上游源码，**未改动** |
| `deploy.sh` | VPS 部署脚本 |
| `提示词全量清单.md` | **给 AI 读的 90 条 45 格全文**（含阅读说明、五轴定义、场景区别、阈值速查、描述层四段表） |
| `提示词全量清单.html` | **给人看的可折叠验收清单**（9 簇 × 5 档 = 45 格） |
| `_test/e2e_bridge.js` | 端到端回归（22 项，含「冲浪回投 → 活动登记 → 段4 出现在注入块」跨进程实证） |
| `_test/simulate_day.js` | 整日漂移 + 多窗口验证 |
| `_test/param_scan.js` | 参数扫描（定节奏用） |
| `_test/analyze_check.js` | 判定器真实调用验证（7 用例） |
| `_test/ratelimit_probe.js` | 限流边界探测 |
| `_test/dump_all_prompts.js` | 穷举导出全部提示词（生成 .txt） |
| `_test/build_prompt_md.js` | 由配置生成 MD 全量清单 |
| `_test/build_prompt_html.js` | 由 .txt 生成 HTML 验收清单 |
| `_test/preview_notice.js` | 主动唤醒块成型版预览（6 例） |
| `_test/simulate_loop.js` | **闭环模拟**：真判定器 + 7 天语料 → CSV |
| `_test/anger_check.js` | **真生气 vs 敷衍判别专项**（5 例） |
| `_test/throttle_check.js` | **注入节流专项**：数值微变是否重注（6 例，含「只有 immersion 动」） |
| `_test/activity_check.js` | **活动登记专项**（18 例）：`recordActivity` 契约 + 段4 三档/死带/不编造 + `bridge.js` 接线点静态断言 |
| `_test/mcp_check.js` | **MCP 协议专项**（57 例）：握手/SSE/鉴权 + 队列取最新策略 |
| `_test/quiet_hours_check.js` | **业务时区专项**：静默时段 / 日上限跨天（25 例） |
| `_test/loopback_check.js` | **回环守卫专项**（66 例）：认领命中/可重复认领/TTL/剥离三版尾句/唤醒轮含工具循环/回环让位/通知内容完整性/源码顺序断言 |
| `_test/probe_supersede.js` | **通知顺序探针**：真引擎 7 天逐 tick，证伪"contact 被更晚的 find_activity 顶掉"，并量出投递滞后与静默期照扣衰减 |
| `_test/dump_loopback_collision.js` | **回环语域冲突对照**：渲染"通知 vs 此刻块"打架的反例（回归参照） |
| `_test/contract_check.js` | **跨仓库契约（静态）**：读 Serein 源码比对常量 + 穷举 1080 块形状 |
| `_test/conformance_check.js` | **跨仓库契约（动态）**：用 Serein 真实剥离函数跑桥产的块 |
| `_test/conformance_strip.py` | 上面那条的 python 侧（被调用，不单独跑） |

---

## 四、参数结论（实测）

跑 `_test/param_scan.js`（60 天，假设她每天 08:00 / 20:00 各出现一次）：

| 配置 | 日均主动次数 | 首发时刻 |
|---|---|---|
| 默认 `r=0.0007 accel=1.5` | 2.00 | 早 2 时（熬过静默必发） |
| 降速 `r=0.0004 accel=1.5` | 1.98 | 早 7 时 |
| 更缓 `r=0.00025 accel=1.5 delay=60` | 0.00 | 全天不触发（太慢） |
| 纯线性 `r=0.0004 accel=0` | 0.00 | 全天不触发 |

**结论**：

- **默认参数（当前 `.env.example`）日均 2 次**，节奏合适，不用改。
- 首发在**凌晨 2 点**是因为静默时段只拦投递、不拦累积，熬过一夜概率必然顶格。**要抑制就调 `QUIET_START`/`QUIET_END`，或在桥里加"静默期不累积"**（当前未实现，因为积温上游不支持）。
- 上表"首发时刻"按**业务时区**计（`param_scan.js` 的模拟起点是 `2026-10-05T00:00:00+08:00`）。运行时实际的静默判定见七之五。
- `r=0.00025` 这类"更缓"参数会让**一天一次都不发**——因为 8 小时只涨到 0.11，够不到 0.35 的线。这是**特性不是 bug**。

⚠️ **参数陷阱**：`CONNECTION_ACCEL` 必须 **> 1** 才叫加速；设成 0.8 反而被 `pow(1+c, 0.8)` 压慢。设 0 是纯线性。

---

## 五、部署步骤（VPS）

### 1. 上传

把整个 `jiwen-bridge/` 目录传到 VPS（例如 `/root/jiwen-bridge`）。

### 2. 填配置

```bash
cp /root/jiwen-bridge/.env.example /root/jiwen-bridge/.env
nano /root/jiwen-bridge/.env
```

必填三项：

| 变量 | 填什么 |
|---|---|
| `BRIDGE_TOKEN` | 自定义，≥24 字符。Operit 端用它做 Bearer |
| `UPSTREAM_TOKEN` | Serein 的 Gateway Key（已预填，如需更换同步） |
| `LLM_KEY` | 已预填 agnes 的 key |

### 3. 跑部署脚本

```bash
bash /root/jiwen-bridge/deploy.sh
```

脚本会：检查 Node ≥20 → 安装文件 → 生成 systemd unit → 启动 → 健康检查。

### 4. 验证

```bash
systemctl status jiwen-bridge
curl http://127.0.0.1:18220/bridge/health
tail -f /root/jiwen-bridge/data/bridge.log
```

### 5. 改 Operit / OMate 的 Base URL

| 端 | 原来 | 改成 |
|---|---|---|
| Operit | `http://154.21.200.74:18217/v1` | `http://154.21.200.74:<BRIDGE_PORT>/v1` |
| Token | Serein Gateway Key | **桥的 `BRIDGE_TOKEN`** |
| OMate | 同上 | 同上 |

> 桥会自动把 Authorization 换成 `UPSTREAM_TOKEN` 再转发，所以 Operit 填桥的 token 即可。

---

## 五之二、MCP 服务（主动唤醒的投递通道）

### 为什么需要它

积温的 proactive 是**引擎主动触发**（越阈 → 要开口）。但：

```
Operit 在手机（NAT / 移动网络）  ←→  桥在 VPS
```

**VPS 无法主动敲开手机的门。** 所以"推"这条路走不通，只能让 Operit 反过来"拉"。

MCP 服务就是这个"拉"的接口。tick 触发时通知不再直接 POST，而是**入队**；Operit 的定时工作流调用 `get_pending_notice` 取走并清空。

### 端点

```
POST http://154.21.200.74:18220/mcp     ← JSON-RPC（工具调用走这里）
GET  http://154.21.200.74:18220/mcp     ← SSE 长连接（客户端建流用）
DELETE http://154.21.200.74:18220/mcp   ← 会话终止
Authorization: Bearer <BRIDGE_TOKEN>
```

- 走 **Streamable HTTP**（JSON-RPC 2.0）。**三种方法都要支持**，见下方"为什么 GET 不能省"。
- 与聊天代理**共用同一端口**，只认 `/mcp` 这一个路径，互不干扰。
- 鉴权复用桥的 `BRIDGE_TOKEN`。

### 客户端握手序列（对齐官方 SDK）

Operit 用的是 `modelcontextprotocol/kotlin-sdk` 的 `StreamableHttpClientTransport`（**严格实现**）。它的序列是：

| 步 | 请求 | 期望响应 |
|---|---|---|
| 1 | `POST` `initialize` | `200 application/json` + **`mcp-session-id` 头** |
| 2 | `POST` `notifications/initialized` | **`202 Accepted`**（无正文） |
| 3 | **`GET`**（收到 202 后立即发起） | **`200 text/event-stream`**，保持长连接 |
| 4 | `POST` `tools/list` / `tools/call` | `200 application/json` |
| 5 | `DELETE`（断开时） | `204` |

### ⚠️ 为什么 GET 不能省

官方客户端源码（`StreamableHttpClientTransport.performSend`）：

```kotlin
if (response.status == HttpStatusCode.Accepted) {
    if (message is JSONRPCNotification && message.method == "notifications/initialized") {
        startSseSession(...)   // ← 立刻发起 GET 建 SSE
    }
    return
}
```

**第 2 步收到 202 后，客户端一定会发 GET。** 如果 GET 返回 404/405，它会按退避重试到 `maxRetries`，然后抛：

```
StreamableHttpError: Maximum reconnection attempts exceeded
```

→ `connect()` 直接失败，工具一个都列不出来。

同理，`server.requestTimeout` 是 Node 默认的 **300 秒**，会在 5 分钟后掐断 SSE。桥里已显式置零，并加 25 秒心跳保活。

### 三个工具

| 工具 | 用途 | 调用时机 |
|---|---|---|
| `get_pending_notice` | **取走**待投递的主动通知（空则 `has_notice=false`） | **定时工作流主入口** |
| `get_status` | 查五轴摘要 + 运行态（静默/日限额/开关） | 调试，或让模型感知状态 |
| `explain_silence` | "他为什么没开口"（决策轨迹 + 一句话解释） | 排查 |

**只有 `get_pending_notice` 是必需的**，后两个是诊断用。

### 返回值形态

有通知时：

```json
{
  "has_notice": true,
  "count": 1,
  "scene": "contact",
  "reason": null,
  "at": "2026-10-05T00:00:00.000Z",
  "notice": "【积温·此刻】\nneutral，表达照常，松弛平稳，带着惯常的温热与底气。\n【此状态为潜意识的底色沉淀，自然浸润在回应里，不作任何元说明或刻意提及。】",
  "state_summary": "[积温] c:0.42(想念) ...",
  "note": "请把 notice 内容作为系统侧消息注入对话，然后正常生成回复；不要提及通知本身的存在。"
}
```

无通知时：

```json
{ "has_notice": false, "count": 0, "note": "当前没有待投递的主动唤醒通知。本次无需任何动作。" }
```

> `notice` 里**已自带边界句**，模型读到就知道这是系统侧材料、不用回应它本身。

### 队列行为

| 项 | 值 |
|---|---|
| 取走即清空 | 同一条通知只返回一次（`peek: true` 可只查不取） |
| **多条时给哪条** | **给最新那条**（`list[list.length-1]`）。更早的进 `additional`（按新→旧排），仅供排查、不投递 |
| 上限 | 20 条，超出丢最旧（防 Operit 长期不来导致堆积） |
| 存储 | 进程内存（桥常驻单实例，够用） |
| 筛选 | 入队前已过**静默时段**与**日上限**闸门 |

#### 为什么是"最新"而不是"最旧"（2026-10-06 实测）

`_test/probe_supersede.js` 拿真引擎 + 桥的真实参数跑了 7 天逐 tick，两组 poll 间隔对照
（30 分钟 / 8 小时），结论：

| 问题 | 实测 |
|---|---|
| `contact` 会不会被更晚的 `find_activity` 顶掉？ | **0 次。** 两个闸门前提在时间上互斥 |
| 队列最长几条？ | **5** |
| 这 5 条是什么场景？ | **全是同一场景** |

互斥的原因（数字来自同一支脚本）：

| 闸门 | 需要 | 时间尺度 |
|---|---|---|
| `contact` | `c ≥ 0.35` | `resetConnection` 归零后爬 **399 分钟 ≈ 6.7 h** |
| 自我调节 → `find_activity` | `arousal ≥ 0.70` | 0.7 回归到 0 只要 **140 分钟 ≈ 2.3 h** |
| 开口 → `find_activity(pride_block)` | `c ≥ 0.35` **且** `p ≥ 0.50` | 本次实测时**不可达** —— 该路前提是 `prideDefendThreshold` 打开，而 vendor 默认给的是 `1.0`（哨兵值＝永不）。**2026-10-07 桥已显式打开（0.20 / 0.004），这条路已通，"两闸门互斥"的结论随之失效，已重测**（见下方 10-07 补测）。 |

铁证：**`contact` 触发那一刻的 `arousal` 恒为 `0.00`**（2016 个 tick 无一例外）。
另外 `valenceActivity` 的 vendor 默认阈值就是 `-1.0`（注释明写"=-1.0 即永不"），
而 valence 轴下限也是 -1 —— 那条路本身是死的。

所以真正成立的理由只有一条：**同场景多条时正文完全相同、只差一个更旧的状态快照**，
留最旧、丢最新 = 白扔掉更新的那份。取最新不需要任何额外机制，也不需要场景优先级。

**同一支脚本还量出两件事**（都是实测，不是推测）：

- **投递滞后均值 17.5 分钟**（最大 20 分钟 = poll 间隔）。拆开看：`contact` 7/7 都在
  她还沉默时投出（正确）；`find_activity` 7/7 都在她已经开口之后才投出 —— 这是
  "她那句话让他不好受 → 他自己去消化"的自然结果，不是缺陷。
- ⚠️ **静默时段的 `contact` 触发照样扣 `-0.35`**：`bridge.js` 里 `await fireProactive(...)`
  之后**无条件** `applyDelta({connection:-0.35})`，而 `fireProactive` 在静默/超日限时
  是 `return` 早退、通知根本没投出去。7 天里 14 次 contact 有 7 次落在静默时段。
  效果上把早晨那次唤醒从 ~03:10 推到 ~09:50 —— 结果可能是想要的，但是**顺带**达成的。
  **当前未改。**

#### 🔁 2026-10-07 补测：`find_activity` 打开后，混合场景队列出现了

打开骄傲防御后 `find_activity` 变得频繁，`_test/probe_supersede.js` 同步了新参数
（`prideDefendThreshold=0.20 / prideDefendRate=0.004`）、同场景冷却（180 min）与日上限（8）后重跑 7 天：

| 场景 | 投递策略 | contact 送达 | find_activity 送达 | 队列最大 | LIFO 丢掉更早的 contact |
|---|---|---|---|---|---|
| Operit 每 30 分钟拉一次（**实际配置**） | FIFO 取最旧 | 7 | 15 | **1** | 0 |
| 同上 | LIFO 取最新（**现行**） | 7 | 15 | 1 | **0** |
| Operit 每 8 小时才拉（手机长时间离线） | FIFO 取最旧 | 6 | 8 | 2 | 0 |
| 同上 | LIFO 取最新（**现行**） | **0** | 14 | 2 | **6** |

**结论**：实际配置（30 分钟一拉）下队列从不超过 1 条，两种策略完全等价 —— **LIFO 没有引入问题**。
只有手机离线到小时级时，队列才会同时压着 `[contact@t1, find_activity@t2]`（t2 比 t1 晚约 165 分钟，
因为 contact 触发后 connection 归零，要再爬 2.7 h 才够得着 find_activity 的线），
此时 LIFO 会投 `find_activity` 而丢掉更早的 `contact`。

⚠️ 那 6 条被丢的 contact 滞后均值 191 分钟、**全部属于"投出时她已经开过口、前提已作废"**，
所以损失有限。**当前保留 LIFO 不改**；若要更保险，可改为"队列里有 contact 就优先投最新那条 contact"。

### Operit 侧怎么接

工作流配置为**定时触发**（间隔建议 10~30 分钟），动作：调 `get_pending_notice` → 若 `has_notice=true` 则把 `notice` 注入对话并生成回复；否则直接结束。

### 与 webhook 的关系

`PROACTIVE_WEBHOOK` 保留但**默认留空**。只有当 Operit 确实存在"可被外部 POST"的入口时才需要填。正常情况下走 MCP 队列即可，不需要它。

---

## 五之三、回环守卫（重要，2026-10-06 修）

### 问题

主动唤醒的形态是：桥 tick 越阈 → 生成积温块 → MCP 队列 → Operit 工作流把 notice
原文当一条 **user 消息**注入对话 → 该请求又打回桥（桥是 Serein 前面的反向代理，
只要模型被调用就必经此处）。

于是桥看到一个"她开口了"的请求，**可实际上她什么都没说**。不识别就犯三个错：

| # | 症状 | 位置 |
|---|---|---|
| ① | 多余执行 `resetConnection()`，把 connection 硬归 0，抹掉这次唤醒本身的意义 | `bridge.js` 请求主流程 |
| ② | 把唤醒通知当"她的发言"喂给判定器打分 → 凭空产生一次错误漂移 | 同上 |
| ③ | **判定器每轮读到桥自己注入的此刻块**（最普遍，与唤醒无关） | `extractRecentDialog` 的调用顺序 |

③ 的成因：`injectIntoBody` 会直接改写最后一条 user 消息。若先注入、后取 dialog，
判定器读到的就是"这份积温块 + 她的真话"，等于拿自己的输出喂自己，
形成 `状态 → 文本 → 判定器 → 状态` 的自我锚定闭环。

### 修法

**A · 回环认领**（`lib/loopback.js`）

桥记住自己发出去的通知原文（`fireProactive` 里 `remember`），请求进来时按原文
`claim`。归一化去掉全部空白再比对，Operit 加前缀 / 后缀 / 压换行都不影响命中。
TTL 2 小时 + 上限 20 条，杜绝陈旧文本被误认。

⚠️ **同一通知在 TTL 内可被重复认领，不能做成"认领一次就失效"。**
唤醒轮的 `出口说明` 恰恰在鼓励他调工具，而 Operit 处理工具调用时会用
**同一个 messages 数组**再发一次请求 —— 此时最后一条 `role:'user'`
**仍然是那条通知**（工具结果走 `role:'tool'`，不算 user）。一次性认领会让
第二次请求起全部漏认，① ② ③ 三个 bug 原样复现，回环让位也失效。
防陈旧由 TTL + "原文必须完整出现"各自守住，一次性是多余的严格。

`claims` 计数只作排查用。日志里 `n=` 就是它 —— `n=1` 说明唤醒轮只有一次请求，
`n>1` 说明这轮调了工具（正常）。

```js
const loopback = loopbackGuard.claim(extractLastUserText(body));
if (!loopback) await jiwen.resetConnection();          // 只有真人开口才重置
...
if (!loopback && dialog.length >= 2 && CFG.llmKey) {   // 只有真人开口才喂判定器
```

命中时日志里会出现 `LOOPBACK=contact age=63s n=1`，可用于核对真实回环间隔与调用形态。

**B · 判定器只读「注入前」的对话**

1. `const dialog = extractRecentDialog(body, 4);` 提到 `injectIntoBody` **之前**；
2. `extractRecentDialog` 内先过 `stripJiwenBlocks()`，把历史里带进来的旧块剔掉
   （三版尾句都认，尾句缺失时按空行兜底）。

**C · 回环让位（2026-10-06 选定的去重方案）**

回环命中时**不再注入此刻块**。

理由不是"重复"，是**语域打架**：通知是 proactive 语域（"你想开口"），
此刻块是 reactive 语域（"她在跟你说话"）—— `tone-harlan.json` 里 reactive 列
明写「她一开口，最后那点耐性自己就用完了」「她终于回话了。隔了这么久…」，
而回环时她一个字都没说。另叠一层数值冲突：`fireProactive` 投递后**立刻**
`applyDelta({connection:-0.35})`，于是**通知是衰减前的快照、此刻块是衰减后的**，
同一条消息里两个 connection 值。

实测对照见 `_test/dump_loopback_collision.js`（三场景渲染）；三个场景的原文差异
比"文字重复"严重得多 —— 一块说「表达照常…可以顺口调侃一句」，另一块说
「压不住…别处的动静都接不上了」。

```js
if (block && !loopback && shouldInject(block, state)) {   // 回环让位
```

让位的前提是"通知自身内容完整"：`_test/loopback_check.js` 的 [6] 段逐条断言
通知自带描述层 / 45 格正文本体 / 出口说明，**且不含档位行与 urgency 尾注**，
`assertBlockShape` 零问题。（若哪天通知被瘦身，这段断言会先红。）

日志里多一个 `SKIP_INJECT=loopback` 标记，线上可核对让位是否真的生效。

**未采纳的备选**：让 Operit 只投一个「信封」（如 `【积温·此刻】`），桥按
`loopback.scene` 用请求时刻的状态重渲染完整块。文案与投递彻底解耦，但
`loopbackGuard` 是**进程内内存**，桥一重启那一轮就认领不到 → 唤醒丢失 +
`resetConnection`/判定器误开，代价比收益大。

### 已知残留

- 桥重启（`systemctl restart`）会清空进程内的回环记忆，重启后投递的那一轮通知
  会被当成"她的话"（多一次 `resetConnection` + 喂判定器）。
- 积温块是拼进 user 正文的，会被 Serein 存进 `raw_events` 并记成**她的消息**
  （实测 8435 条里 71 条含"积温"，其中 user 43 / assistant 28）。
  影响语义检索与新窗口续接材料。

**2026-10-06 更新：后一条已由 Serein 侧解决，见下节。**
原先考虑的"块改走独立 `role:'system'` 消息"方案**不做** —— 查证发现 Serein 自己的
命中记忆也是拼在 user 消息里的（只有常驻上下文走 system），模型能分清，没必要。

---

## 五之四、与 Serein 的契约（积温块剥离，2026-10-06）

### 契约形态

Serein 侧（fork 提交 `a5c1bdd`）在 `chat_context.py` 里加了三件事：

1. `EXTERNAL_CONTEXT_BLOCK_TITLES` 增加 `积温·此刻`（原为三条，2026-10-07 已删掉
   `积温·找她` / `积温·独处`，**且不要补回来**）：
   ⚠️ 桥自 2026-10-07 起**只发** `积温·此刻`，白名单也**只留它一条**。
   历史块头为什么宁可不剥离也不补 —— 剥离函数只处理**进了跳过态**的行，而
   **出跳过态只认"下一个白名单标题行 / 尾标记行"**；一/二版旧块的尾句是**裸行**
   （不带【】）→ 永远结束不了跳过态 → 补进白名单就是 skipping 吃到文本结尾、
   **把她紧随的原话整段吞掉**（归档成 `''`）。不进白名单只是"不剥离"（旧块留在归档里），
   **不毁任何正文**。两害相权取其轻。`_test/contract_check.js` 有断言守
   "白名单积温标题恰好等于桥的产出集合"。
2. 新增 `EXTERNAL_CONTEXT_BLOCK_END_MARKERS`；
3. `_strip_external_context_blocks` 在「按行剥出 `【标题】`」之后、进入跳过态之前，
   先判是不是尾标记。

于是剥离过程变成一个状态机：

```
见到【积温·X】        → 进跳过态
跳过态中的任何行      → 丢弃（**空行不算出块信号**）
见到下一个【】标题行  → 出块
见到尾标记            → 出块（该行也丢弃）
```

### ⚠️ 破裂代价不对称 —— 桥侧必须无条件满足

**块头发出、尾标记不匹配 → 跳过态一直持续到消息结尾 → 她的原话被整段吞掉。**
（Serein 侧用例 8 实测，返回 `''`）

所以桥侧做了三层防护，改这块之前先看清楚：

| 层 | 位置 | 作用 |
|---|---|---|
| 单一来源 | `lib/inject-text.js` 的 `BOUNDARY_INNER` | 只写**内文**，括号由代码拼 —— 想写错括号都写不出来 |
| 形状自断言 | `assertBlockShape(block)` | 查首行、末行、块头唯一性 |
| 运行时守卫 | `bridge.js` 注入前 + `fireProactive` 发送前 | **不合规就拒绝注入/拒绝发送**，宁可不给状态，也不能让她的话被吞 |

`composeBlock` 无条件把尾标记拼在最后，调用方不需要记得加。

### 形状差异（最容易记混的一点）

```
桥侧发出     【此状态为潜意识的底色沉淀，自然浸润在回应里，不作任何元说明或刻意提及。】
Serein 存    此状态为潜意识的底色沉淀，自然浸润在回应里，不作任何元说明或刻意提及。
```

Serein 先按行取 `【…】` 里的标题、再拿**内文**比对，所以两边字面量不同形状。
**改措辞要改 `BOUNDARY_INNER`，然后通知 Serein 侧同步那个字符串。**

### 自动化校验（两个测试，别删）

| 测试 | 性质 | 覆盖 |
|---|---|---|
| `_test/contract_check.js` | 静态 | 读 Serein 源码，比对两侧常量字面量；穷举 1080 个块的形状；负向用例 |
| `_test/conformance_check.js` | 动态 | 用 Serein 的**真实** `_strip_external_context_from_user_text` 跑桥产出的块，比对输出 |

`contract_check` 能发现"改了一侧忘了另一侧"；`conformance_check` 能发现
"规则我以为是这样、实际不是"。两个都需要 python 与 Serein 源码，
找不到时**跳过而不是失败**（VPS 上路径是 `/root/Serein/src`）。

### 历史残留（待 Serein 侧补一刀）

`raw_events` 里 `role='user'` 含块头的 31 条：**17 条一版尾、14 条二版尾、零条三/四版**。

一版/二版尾句是**裸行**（没有 `【】`），所以 Serein 取不到 title，
`EXTERNAL_CONTEXT_BLOCK_END_MARKERS` 加它们**也没用** —— 得在跳过态里额外判一次
"裸行是否等于尾标记"。风险有限（主要影响 turn 哈希与 `_current_turn_user_index`），
但一旦命中会把整条消息清空。

---

## 六、状态文件与运维

| 项 | 位置 |
|---|---|
| 五轴状态 | `/root/jiwen-bridge/data/state.json` |
| 日志 | `/root/jiwen-bridge/data/bridge.log` |
| 服务 | `systemctl {start,stop,restart,status} jiwen-bridge` |
| 实时日志 | `journalctl -u jiwen-bridge -f` |

**删掉 `state.json` = 重置情绪**（下次启动回到中性）。

---

## 七、已验证 / 未验证

**已验证（本机）**：

- 端到端 15/15：鉴权、健康检查、注入、窗口透传、Authorization 替换、判定器调用、delta 叠加、状态落盘、非 chat 路径透传
- 多窗口切换：在 omate 发言，operit 侧 connection 同步归零（**全局单实例，无人格分裂**）
- 开局状态为中性（`NEUTRAL_SEED` 生效）
- 参数扫描：日均次数与首发时刻
- **判定器真实调用验证**（`_test/analyze_check.js`，agnes-3.0-flash）：7 个用例中 6 个判定正确
  - 「臭爹咪」→ `pride:-0.1`（未判成冒犯，还识别出亲密）
  - 职场内耗 → `pride:-0.2, valence:+0.1, arousal:-0.2`（完美命中规则 1）
  - 诛心背信 → `pride:+0.3, valence:-0.3`（满格命中规则 3）
  - 「贺董好大的官威」→ `pride:0`（情趣交锋未误判）

**未验证**：

- **真机未跑过**。首次部署后请看第一轮日志的 `inject=true` 和 `delta applied`
- RP 语境的「贺董」豁免单独用例未跑（额度耗尽），逻辑已写入 prompt

---

## 七之四、注入节流（重要，2026-10-05 修）

**问题现象**：真实聊天里只有每半小时第一轮带积温块，之后全是 `inject=false`。

**根因**：节流比较的是 **block 渲染文本**，而块文本是**离散格**——45 格里相邻两个状态常落在同一格。

```
v=0.31, p=0.20 且 a=0  →  pleased，表达照常，…
v=0.60, p=0.20 且 a=0  →  pleased，表达照常，…      ← 渲染出的块逐字相同
```

状态明明在漂（`v` 从 0.31 涨到 0.60），但渲染文本一字不变 → 判为"没变" → 静默跳过。

**修法**：指纹取**数值**，不取文本。

```js
// bridge.js
const sig = [state.connection, state.pride, state.valence, state.arousal]
  .map((x) => (Number(x) || 0).toFixed(2)).join(',');
const changed = sig !== lastInjectSig;
```

模型看到的正文文本没变（`neutral，表达照常，…` 那行），但**只要数值动了就重注**。2 位小数 = 状态可感知变化阈值。

**验证**：`_test/throttle_check.js` 5/5；`_test/e2e_bridge.js` 17/17；VPS 实测连续三轮 `inject=true`（正文全程一字未变）。

**遗留观察点**：`connection` 每轮被 `resetConnection()` 清零，导致连接需求在频繁聊天时永远涨不起来（需靠 tick 的时间累积，`CONNECTION_RATE=0.0007/min` ≈ 24 小时涨满）。真实节奏下是否合适，待长时间观察。

---

## 七之五、业务时区（重要，2026-10-05 修）

**问题现象**：静默时段与北京时间差 8 小时。北京时间中午 12:00 被判定为静默，通知发不出来。

**根因**：`inQuietHours()` 用的是 `new Date().getHours()`，而 VPS 系统时区是 `Etc/UTC`，该方法返回的是 **UTC 小时**。

```
QUIET_START=0 / QUIET_END=8  的意图：凌晨 0 点到早 8 点别打扰
实际执行：UTC 0-8 点静默  ＝  北京时间 8:00-16:00 静默
```

**恰好把白天当成了夜里** —— 她在上班时段收不到通知，在她睡觉的时段（北京 0-8 点）反而活跃。

同一处的时区错误还牵连 **日上限跨天**：`checkDailyLimit()` 用 `toISOString().slice(0,10)` 取日期，等于按 **UTC 0 点 = 北京 8 点** 重置配额，与"自然日"不符。

**修法**：新增 `lib/clock.js`，所有业务时间判断走显式时区偏移。

```js
// bridge.js
const clock = createClock(CFG.tzOffsetHours);          // lib/clock.js
const today = clock.localDateStr();                     // 日上限跨天
const inQuiet = clock.inQuietHours(null, quietStart, quietEnd);  // 静默判定
```

实现全程基于 `getUTC*` + 固定偏移，**不依赖系统 TZ**，因此在任何时区的机器上结果一致。

**语义约定（重要）**：

| 用途 | 时区 | 理由 |
|---|---|---|
| 日志时间戳 | **UTC**（`toISOString()`） | ISO 8601 标准，跨机器排查无歧义 |
| 静默时段 / 日上限跨天 | **业务时区**（`TZ_OFFSET_HOURS`） | 面向"人的作息"，必须随人所在时区 |

这是「技术时间」与「业务时间」分离，不是不一致。

**配置**：`.env` 加 `TZ_OFFSET_HOURS=8`（北京）。`0` 即 UTC。仅支持整小时偏移。

**排查辅助**：`get_status` 返回 `local_hour` 与 `tz_offset_hours`；静默拦截日志会带上实际判定值：

```
proactive blocked by quiet hours (local_hour=4, quiet=0-8)
```

**验证**：`_test/quiet_hours_check.js` 25/25，含跨午夜、边界（左闭右开）、`start === end`、以及"改系统 TZ 结果不变"的断言。

---

## 七之一、提示词全量清单

两份产物，同一份数据：

| 文件 | 用途 |
|---|---|
| `提示词全量清单.md` | **给 AI 读**。含阅读说明、五轴定义、两种场景的区别、阈值速查、描述层四段表、90 条全文 |
| `提示词全量清单.html` | **给人看**。按簇分组、可折叠（9 簇 × 5 档 = 45 格） |

内容：45 格（9 簇 × 5 pride）× 2 模式（reactive / proactive）= **90 条**；描述层四段另列。

重新生成：

```bash
node _test/build_prompt_md.js       # → 提示词全量清单.md
node _test/dump_all_prompts.js      # → _test/all-prompts.txt（纯文本中间产物）
node _test/build_prompt_html.js     # → 提示词全量清单.html
```

---

## 七之二、判定器模型与限流（重要）

### 当前使用：DeepSeek（deepseek-flash）

| 变量 | 值 |
|---|---|
| `LLM_BASE` | `https://api.deepseek.com/v1` |
| `LLM_MODEL` | `deepseek-flash` |
| `LLM_DISABLE_THINKING` | `true`（**必须**，见下） |
| `LLM_MAX_TOKENS` | `300` |

**为什么必须关思考链**：`deepseek-flash` 是推理型模型，会先输出 `reasoning_content`（思考链）
再输出 `content`。实测同一个请求：

| 配置 | reasoning_content | completion_tokens | content |
|---|---|---|---|
| 默认（开思考） | 有 | 66 | 正常但有延迟 |
| `thinking:{type:"disabled"}` | **无** | **5** | 正常 |

关掉后省约 90% token 与延迟。**注意**：`chat_template_kwargs.enable_thinking=false` 实测**无效**，
必须用 `thinking: {type: "disabled"}`。桥的 `lib/analyzer.js` 已内置此参数（由 `LLM_DISABLE_THINKING` 控制）。

> 换回非推理模型（如 agnes）时把 `LLM_DISABLE_THINKING` 设为 `0`，否则会被上游忽略或报错。

### 备用：agnes-3.0-flash

免费档**总配额型限流**——实测连续调用第 3~6 次即 429 且持续，不是"每分钟 N 次"。
密集连聊时会持续熔断，**不建议用于生产**。`.env.example` 里保留作注释参考。

### 两层保护（`.env` 可调）

| 变量 | 默认 | 作用 |
|---|---|---|
| `LLM_MIN_INTERVAL_SECONDS` | 20 | 同一时段 N 秒内只分析一次（用户连发多条时只算最后一次） |
| `LLM_BREAKER_SECONDS` | 300 | 遇到 429/5xx 后，M 分钟内不再调用，避免持续撞墙 |

熔断期间的日志会打 `judge skipped (breaker open)`。**若频繁出现，说明该升额度或换模型。**

> ⚠️ 测试脚本（`analyze_check.js` / `anger_check.js` / `simulate_loop.js`）会在 require
> analyzer **之前**把这两个值设为 0，否则连续用例会被全部拦截（表现为"第 1 条成功、其余 null"）。

**换模型成本极低**：只读 `.env` 的 `LLM_BASE` / `LLM_KEY` / `LLM_MODEL` / `LLM_DISABLE_THINKING` 四项，
不需要动任何代码。

---

## 七之三、闭环模拟与规则调优（新增）

`_test/simulate_loop.js` —— **真实判定器 + 整日推进 + 7 天语料**的闭环模拟。
与 `simulate_day.js` 的区别：后者只做"给定 delta → 状态迁移"，前者把真判定器接进循环。

```bash
node _test/simulate_loop.js            # LIVE：真调模型（18 条语料）
OFFLINE=1 node _test/simulate_loop.js  # 不调 LLM，用本地替身（快速验证骨架）
DAYS=3 node _test/simulate_loop.js     # 只跑前 3 天
```

产物：`_test/.run/sim-loop.csv`（可拖进表格/绘图）、`_test/.run/sim-loop-events.json`。

### 7 天实测结论（deepseek-flash，18 条语料零跳过）

| 观察点 | 结果 | 判定 |
|---|---|---|
| pride 是否只涨不跌 | 升 4 / 降 6 / 平 8，终值 0 | ✅ 未卡死 |
| contact 触发频率 | 1.86~2.00 次/天，峰值 ≤ 0.35 | ✅ 节奏合理，从未到 0.50 强制线 |
| valence/arousal 波动 | 0.45 / 0.40 | ✅ 落在"正常"区间（0.2~0.6） |

按规则分组的 delta 均值：

| 规则 | Δp | Δv | Δa | Δc |
|---|---|---|---|---|
| rule1（示弱/耗损） | -0.175 | +0.103 | -0.155 | -0.05 |
| rule2（原则分歧） | +0.15 | -0.10 | +0.10 | +0.05 |
| rule3（诛心/自毁） | +0.22 | -0.20 | +0.11 | +0.17 |
| rule4（认错回落） | -0.11 | +0.08 | -0.08 | -0.15 |
| rule5（调情/撒娇） | 0 | +0.05 | -0.04 | 0 |
| rule6（闲聊） | 0 | +0.03 | -0.03 | 0 |
| rule8（元讨论） | 0 | 0 | 0 | 0 |

### 本次修掉的两个判定缺陷

**缺陷 1 · 真生气被漏判（pride 只涨 +0.05）**

根因：`「随便你。没意思。你忙吧」` 同时命中规则 2、规则 5、【⑤ 敷衍信号】三条，
而"真生气走规则 2"这句**只写在【① Brat 类】的一个附注里**，层级低于独立小节的【⑤】。
小模型在冲突时选了"最显眼"的【⑤】，导致 pride 被判 0。

修法：把"真假生气"从附注**提升为独立小节【①之补】**，并显式声明"优先级高于【⑤】"，
同时给【⑤】加排除条款。修后实测 `+0.18 / +0.12`，进正区间。

**缺陷 2 ·「……」被误判成示弱**

曾试图加"必须为 0"的硬约束，但**措辞强度打不过规则 1 的"必须为负"**，实测仍给 -0.18。
最终**按"不过度工程"原则接受**：`「……」` 本身歧义，语境偏示弱时给负值也合理。
改为"不得判成正值（生气）"这一条边界，并在 prompt 中说明默认取 0、语境明确指向示弱才给负。

> 教训：小模型对**层级**比对**措辞强度**更敏感。要改一个判定，优先提升为独立小节，
> 而不是在原处加"⚠️ 必须"。

---

## 八、待你补充

### 8.1 信号词映射 —— 已完成 ✅

`config/analyze-prompt-user.txt` 已填入完整的 Brat / DDLG / 职场内耗 / 诛心禁区映射表，
术语已从用户的 `gravity/shelter` **转译为积温五轴**（`pride/valence/arousal/connection`）。

**关键转换**：用户原话"gravity 不向负值跌落"= 积温里 **`pride` 不升高**（防御不启动）。
这两者方向相反，直接照抄会写反，已在 prompt 里显式说明。

**connection 的处理**：用户映射里多处写"connection 清零（-1.0）"，已改为 **`connection: 0`**。
原因：积温 connection 范围 0~1、delta 上限 -0.5，且桥每轮已自动 `resetConnection()`，
判定器再给负值是重复扣减。

### 8.2 自主唤醒的投递 —— 已定：走 MCP 队列 ✅

原方案考虑过 `PROACTIVE_WEBHOOK` 直推，但**物理上走不通**：Operit 在手机（NAT 后面），VPS 敲不开它的门。

**已改为 MCP 队列模式**（见「五之二、MCP 服务」）：tick 触发 → 通知入队 → Operit 定时调 `get_pending_notice` 取走。

`PROACTIVE_WEBHOOK` 保留但**默认留空**，仅当 Operit 确实有对外 POST 入口时才用。

**Operit 侧待办**：配置一个定时（10~30 分钟）工作流，动作是调 `get_pending_notice`；有通知就注入对话生成回复，没有就结束。

---

## 九、调参与迭代入口

| 想改什么 | 改哪 |
|---|---|
| Harlan 的语气（每档 pride 怎么说话） | `config/tone-harlan.json` 的 `profiles` |
| 描述层四段（「我此刻在什么处境」） | `config/tone-harlan.json` 的 `describe` |
| 独处场景的正文 | `config/tone-harlan.json` 的 `sceneOverride` |
| 判定标准（什么算冒犯、什么算示弱） | `config/analyze-prompt-user.txt` |
| 主动唤醒的早晚/频率 | `.env` 的 `CONNECTION_RATE` / `PROACTIVE_MAX_PER_DAY` |
| **角色"自己去干活"（`find_activity`）的活跃度** | `.env` 的 `PRIDE_DEFEND_THRESHOLD` / `PRIDE_DEFEND_RATE`（见下方"十·补"） |
| 同一场景多久内不重复报 | `.env` 的 `ACTION_COOLDOWN_MINUTES`（默认 180） |
| 判定器重复喂的抑制窗口 | `.env` 的 `ANALYZE_DEDUP_SECONDS`（默认 900） |
| 注入块里显示什么 | `lib/inject-text.js` |
| 注入节流（多久重注一次） | `bridge.js` 的 `shouldInject` / `.env` 的 `INJECT_THROTTLE_SECONDS` |
| MCP 工具的描述或返回值 | `lib/mcp.js` 的 `buildToolDefs` / `callTool` |
| 换判定器模型 | `.env` 的 `LLM_BASE` / `LLM_KEY` / `LLM_MODEL` / `LLM_DISABLE_THINKING` |
| 看判定器实际表现 | `node _test/simulate_loop.js`（闭环）或 `analyze_check.js`（单例） |
| 验 MCP 协议是否正常 | `node _test/mcp_check.js`（57 例，不起真桥） |

**校准方法**：跑两天，翻 `bridge.log`，找那些"这句语气不对"的地方，看当时 `[TICK]` 行的五轴值落在哪一档，改对应的格子。改完跑 `node _test/build_prompt_html.js` 重新生成清单对照。

---

## 十·补、`find_activity`（独处）此前为何永远不触发，以及怎么打开的

> 2026-10-07。线上跑了一整天，`contact` 触发 2 次、**`find_activity` 0 次**。
> 这不是部署问题，是**引擎里通往 `find_activity` 的每一条路，默认都用"哨兵值"关着**。

### 五条路，四条出厂即死

| 路径 | 参数 | vendor 默认 | 效果 |
|---|---|---|---|
| `pride_block`（惦记 + 嘴硬 → 转身找事做） | `prideDefendThreshold` | **1.0** | connection 上限就是 1 → **永不触发** |
| `low_valence`（心情差自我调节） | `valenceActivity` | **-1.0** | valence 下限就是 -1 → **永不触发** |
| `high_arousal`（躁动坐不住） | `arousalAgitation` | 0.7 | 开着，但日常到不了（实测 arousal 峰值 ≈ 0） |
| 辅助：想念久了心情下沉 | `valenceConnectionDriftRate` | **0** | 关闭 |
| 辅助：等待焦躁 | `arousalConnectionRiseThreshold` | **1.0** | **永不触发** |

作者用的是 opt-in 设计：把门槛设成"轴的理论边界"来当"永不"。桥原先只传 3 个 `rates`
（`valenceSetpoint` / `connectionAccel` / `accelDelay`）、0 个 `thresholds`，
所以引擎一直跑在"几乎全关"的默认态。

**关键因果链**：`prideDefendThreshold` 关着 → pride 永远不会因冷落升到 `prideBlock`(0.5)
→ `c` 涨到 0.35 时 `p` 恒为 0 → 全部走 `contact`。这就是 0 次的全部原因。

### 打开方式（全部走 `createJiwen(opts)`，**vendor 零改动**）

| `.env` | 默认 | 说明 |
|---|---|---|
| `PRIDE_DEFEND_THRESHOLD` | `0.20` | 原是 1.0。0.20 = `observation` 线，语义"一开始留意她，嘴硬就跟着升温" |
| `PRIDE_DEFEND_RATE` | `0.004` | 原是 0.003。**这个值改不得** —— 0.003 在 `c∈[0.35,0.50)` 的窗口里只能把 pride 涨 0.45，差 0.05 够不到 0.5，`find_activity` 仍不触发 |

### ⚠️ 必须配套"同场景冷却"，否则打开就是灾难

`find_activity` 的触发源是**持续状态**（惦记 + 嘴硬），能连续挂 1~2 小时，
而 tick 每 5 分钟判一次 —— **不加冷却就是 51~110 条/天**，日上限瞬间打光，
连带把 `contact` 一起挡在门外。

```bash
ACTION_COOLDOWN_MINUTES=180   # 同场景 3 小时内不重复触发；0 = 关闭
```

实测（`_test/scan_activity.js`，30 天 × 她三种出现模式）：

| 配置 | 她来2次/日 | 她来1次/日 | 整日不来 |
|---|---|---|---|
| 现状（全关） | contact 2.00 / find **0.00** | 3.00 / **0.00** | 3.60 / **0.00** |
| 只打开骄傲防御（无冷却） | 1.97 / **51.70** | 2.97 / 83.47 | 4.30 / 110.03 |
| **+ 180 分钟冷却（现行）** | **1.97 / 2.00** | **2.97 / 3.97** | **4.30 / 4.33** |

顺带把日上限从 6 提到 **8**：整日不来时 4.30 + 4.33 ≈ 8.6 会顶满，留在 6 会把
`find_activity` 挤到 2 次以下。

### 副作用（要知情）

她一走约 2 小时后，pride 会涨到 0.5 并**保持到下次出现** → 45 格长期取"端着"那一列。
符合人设，但这是新状态。

### 冷却只作用于**触发侧**

`tickOnce` 里判，`_test/scan_activity.js` 同款逻辑。**不拦投递侧** ——
surf 跑完回投的产物照常发；否则 spawn 那一刻已记账，surf 回来必然还在冷却内，产物全被吃掉。
同理 `bridge.js` 的 `fireProactive` 被静默时段/日上限挡下时**不记账**（`if (sent) mark`），
不然"夜里被静默挡掉"会白白吃掉一次冷却。

---

## 十·再补、判定器被同一轮对话重复喂（2026-10-07 实测）

工具轮里模型调完工具，Operit 会用**同一份 messages** 再发一次请求 ——
`extractRecentDialog(body, 4)` 取的最后 4 条 `user`/`assistant` **一字未变**，
于是判定器把同一段对话判 N 次、`delta` 叠加 N 次。

线上实测：`08:45:43 / 08:47:15 / 09:01:42 / 09:02:56` 四次 `delta applied` **逐字相同**
（`{"pride":-0.12,"valence":0.08,"arousal":-0.1,"connection":-0.15}`）。
后果：pride 该掉 0.12、实际掉 0.66（放大 5.5 倍），**整条轴轨迹被污染**。

原先靠 `LLM_MIN_INTERVAL_SECONDS=20` 挡，但实测工具轮间隔 33/36/33/49 秒，**全部放行**。

修法（`lib/repeat-guard.js` 的 `createDialogDedup`）：取**最后一条 user 文本**做轮次指纹，
窗口内同指纹只喂一次；`ANALYZE_DEDUP_SECONDS` 默认 900（TTL 兜底：
同一句话隔久了又出现仍应重新判）。
`_test/e2e_bridge.js` 已加两个用例：同一份 messages 重发 → 判定器不涨；
她说了新话 → 判定器必涨。

### ⚠️ 顺带修掉一个静默失效：`.env` 加载顺序

`lib/analyzer.js` 在**模块顶层**读 `process.env.LLM_MIN_INTERVAL_SECONDS` /
`LLM_BREAKER_SECONDS` 并算成常量，而 `bridge.js` 原先把 `loadEnvFile(...)` 写在
`require('./lib/analyzer.js')` **之后** → 这两项配置**从来没生效过**（永远走默认 20s/300s）。
现已把 `loadEnvFile` 提到所有 lib require 之前。
**若你此前在 `.env` 里写过这两项、却发现行为没变，就是这个原因。**

---

## 十·三补、块头统一为【积温·此刻】（2026-10-07）

原先块头按场景分三种：`【积温·此刻】`（reactive）/ `【积温·找她】`（contact）/
`【积温·独处】`（find_activity）。**现统一为 `【积温·此刻】`。**

理由：块头不是在给"哪一种通知"编号，它是在告诉模型"这是你此刻的状态"。
三个场景的块性质完全一样（系统侧材料），差别只该由**正文**承担 ——
分场景写块头等于把"通知类型"这个实现细节摆到模型眼前。

实现上 `SCENE_TAG` 的 key 全保留、只是三个值相同，将来要重新分场景改值即可。
`buildProactiveNotice` 的 fallback 也从 `'自主唤醒'` 收紧成 `'此刻'` ——
块头一旦落在 Serein 白名单之外，整块（含她紧随的原话）都会被吞进归档。

**场景区分挪到了别处，都在桥外或正文里：**

| 维度 | 靠什么区分 |
|---|---|
| 内容 | 找她走 `getPromptContext`；独处走 `sceneOverride`；有产物走 `buildFindingBody` |
| 落点 | Operit 工作流读 MCP 返回的 `SCENE=` / `TARGET=`（`jiwen_pull.js` 的 `TARGET_OF_SCENE`），**与块头无关** |

**⚠️ Serein 侧白名单只留 `积温·此刻` 一条，历史块头已删、不要补回。**
`积温·找她` / `积温·独处` 是历史块头（10-07 之前发出去的），今天仍可能躺在 `raw_events` 里；
但它们**不能进白名单**：旧块尾句是**裸行**（无【】），而剥离函数**出跳过态只认下一个
白名单标题行 / 尾标记行** → 补进去会让 skipping 一路吃到文本结尾，
**把紧随其后她的原话整段吞掉**。不补则只是"不剥离"（旧块留在归档里），不毁正文。
`_test/contract_check.js` 有一条断言守这件事（`Serein 白名单里的积温标题恰好等于桥的产出集合`）。
2026-10-07 归档实证：`积温·找她` **0** 条、`积温·独处` **0** 条（用户判断成立）；
另有旧头 `积温·此刻｜参考不是指令` 17 条，同样不补。

---

## 十·四补、冲浪有**两条**投递通道，其中一条从不回桥（2026-10-07 复核）

线上 `find_activity` 打开后，产物本该由 `POST /surf/finding` 回投桥。实测发现实际有两条：

| 通道 | 谁在跑 | 传的 env | 投递去向 | 线上跑过吗 |
|---|---|---|---|---|
| 桥 `spawnSurf()` | `bridge.js`，`find_activity` 越阈时 spawn 一次 | 强制 `DELIVERY_CHANNEL=jiwen` + `AUTO_SCHEDULE=false` + `--once` | `POST /surf/finding` → 桥拼块 → 入队 | **0 次**（`bridge.log` 里 `surf spawning` 一条都没有） |
| `web-surf.service` | systemd 常驻（`ExecStart=/usr/bin/node dist/index.js`，无 `--once`，`Restart=always`） | 由进程**启动时**读到的 `.env` 决定 | `DELIVERY_CHANNEL=console` → 只写 `data/surf.log` | 在跑（今天 13:17 还出了一条） |

关键点：

- `config.ts` 的 `loadDotEnv()` **只在 `process.env[key] === undefined` 时赋值** ——
  所以桥 spawn 时传的 `DELIVERY_CHANNEL=jiwen` 一定压得住 `.env` 里的同项。桥那条路是通的。
- 常驻服务的启动横幅写着 `-> console`（`data/surf.log` 前两行），说明它启动那刻
  读到的就是 console；`.env` 后来改成 `jiwen` 但**服务没重启**，进程内仍是 console。
  → 它每 6~12 小时自己跑一次、烧一次模型钱，产物**只落在日志里，永远到不了模型**。
- 10-06 15:17:06 那条 `surf finding received` 是一次**手动**回投（当时桥刚重启 42 秒，
  不可能是它自己 spawn 出来的），不是常驻服务投的。

**处置建议**：`systemctl disable --now web-surf.service`。
⚠️ 不要只 `restart` —— `.env` 里 `AUTO_SCHEDULE=false`，重启后进程会立刻退出，
而 unit 写着 `Restart=always` + `RestartSec=30`，会变成每 30 秒重启一次的死循环。
今后 surf 只由桥按需 spawn。
