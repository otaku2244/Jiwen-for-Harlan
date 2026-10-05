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
  ├─ contact（找她）        ← connection 过线，挂 urgencyBoost 尾注
  └─ find_activity（独处） ← pride 挡住开口 / 心情过低 / arousal 过高
       reason: pride_block / low_valence / high_arousal
  → 投递到 Operit 工作流（proactiveWebhook，作为一条 user 消息注入）
```

> **投递分工**：桥只负责"生成通知块 + POST 到 webhook"。**投递到哪个窗口、什么时候送，全部由本机 Operit 工作流决定**，桥不管。
> **桥不碰"活动"**：不发英文活动枚举、不调 `setActivity`。具体做什么由模型按世界书的工具清单自己选。

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

修法（轻修，**不碰 vendor**）：新增 `lib/tone-wrap.js` 包装层。当 `connection` 越过
`considerContact(0.35)` 线且开口动机成立时，用 `contactOverride` 文案**顶掉**基础档：

| 条件 | 处理 |
|---|---|
| `c ≥ 0.50`（强制线） | 覆盖为 `forced` 档 |
| `0.35 ≤ c < 0.50` 且 `pride < 0.50`（过了 pride 闸门） | 覆盖为 `normal` 档 |
| `0.35 ≤ c < 0.50` 且 `pride ≥ 0.50`（pride 挡住开口） | **不覆盖**——此时"收着"的基础档是正确的 |

覆盖文案写在 `config/tone-harlan.json` 的 `contactOverride` 段，与 `urgencyBoost` **职责分离**
（前者管"开口动机"，后者管"回应姿态"，不重叠，避免出现重复句）。共影响 180 格中的 72 格。

---

## 二之三、注入块形态（统一骨架）

两种投递形态共用同一骨架，只差场景标签与正文来源：

```
【积温·{场景}】
心情：XX。姿态：XX。心跳：XX。想念：XX。       ← 五轴档位词（只挑值得说的行）
（正文：该场景的行为指令）
以上是内在心绪和潜意识的自然流露，切勿对她复述或提及此状态。   ← 统一边界句
```

> 头尾沿革：旧头 `【积温·{场景}｜参考不是指令】` / 旧尾 `以上是系统通知，非用户消息，不用提及相关内容。`
> → 二版头 `【积温·{场景}】` / 二版尾 `以上是内在心绪和潜意识的自然流露，切勿对她复述或提及此状态。`
> → 三版尾 `此状态为潜意识的底色沉淀，自然浸润在回应里，不作任何元说明或刻意提及。`（现行）
> 去掉了"参考不是指令""系统通知""非用户消息"这类工单味元话语。
> ⚠️ 尾句刻意**不写**"以下是她的消息"：用户消息后面可能紧跟文件传输的文本/地址，
> 写"以下是她的消息"会把文件信息误纳入"她的话"语义。
> ⚠️ 三版与二版的关键差别在**禁止对象**：二版禁"复述此状态"（按字面会把"我心情不错"这种
> 合法的状态自述一起误伤），三版禁"元说明"（对系统/设定的说明）。**模型说"我现在心情不错"
> 是正向反馈，不是要防的东西**；要防的是脚手架暴露——"系统又告诉我…""根据我的设定…"。
> 也不要在提示词里列举反例，那等于把那些词直接摆到模型眼前。
> 中间的档位行与行为指令**保持原样不动**——模型念不念、混不混由头尾边界句决定，与档位行文体无关。

| 场景标签 | 触发 | 正文来源 | 出口说明 |
|---|---|---|---|
| `此刻` | 用户开口（reactive） | `toneGrid.getStyleGuidance` | 无（他已在回话） |
| `找她` | connection 过线 | `toneGrid.getPromptContext`（含 urgencyBoost 尾注） | `proactiveOutlet.contact` |
| `独处` | pride 挡住开口 / 心情过低 / arousal 过高 | `sceneOverride.find_activity[reason]` | `proactiveOutlet.find_activity` |

> `独处` 的 reason 有三个键：`pride_block` / `low_valence` / `high_arousal`。
> 由积温引擎按触发原因填，桥只透传，不再把 `high_arousal` 拆成独立场景。

**为什么独处要独立尾注**：`urgencyBoost` 的 proactive 列语义是"想她了要发点什么"
（"她安静得有点久了…"），而独处的语义是"她不在，这是我的时间"。若共用，独处会挂上联系她的尾注，
气质完全是反的。

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
| `lib/inject-text.js` | 状态 → 「此刻块」/「自主唤醒通知」文本 |
| `lib/tone-wrap.js` | **语调网格包装层**。修 pride/connection 脱节 |
| `lib/mcp.js` | **MCP 服务**（Streamable HTTP / JSON-RPC）。给 Operit 定时拉通知 |
| `lib/analyzer.js` | 判定器。调 deepseek-flash 出 delta |
| `lib/clock.js` | **业务时区时钟**。静默时段 / 日上限跨天按 `TZ_OFFSET_HOURS` 算，不依赖系统 TZ |
| `lib/env.js` | 极简 .env 解析 |
| `config/tone-harlan.json` | **Harlan 语调网格**（9 簇 × 5 档 pride + contactOverride + sceneOverride）。核心人格皮肤 |
| `config/persona-scope.md` | **分工边界**：世界书 / 积温 / 模型 三者职责划分 |
| `config/analyze-prompt-user.txt` | 判定器 User Prompt（可迭代） |
| `config/analyze-prompt.md` | 判定标准文档（含语义映射说明） |
| `vendor/jiwen.js` `tone-grid.js` | 积温上游源码，**未改动** |
| `deploy.sh` | VPS 部署脚本 |
| `提示词全量清单.md` | **给 AI 读的 360 条提示词全文**（含阅读说明、五轴定义、场景区别、阈值速查） |
| `提示词全量清单.html` | **给人看的可折叠验收清单**（覆盖格标红） |
| `_test/e2e_bridge.js` | 端到端回归（15 项） |
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
| `_test/throttle_check.js` | **注入节流专项**：数值微变是否重注（5 例） |
| `_test/mcp_check.js` | **MCP 协议专项**（31 例） |
| `_test/quiet_hours_check.js` | **业务时区专项**：静默时段 / 日上限跨天（25 例） |

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
  "notice": "【积温·找她】\n心情：中性。\n以上是内在心绪和潜意识的自然流露，切勿对她复述或提及此状态。",
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
| 上限 | 20 条，超出丢最旧（防 Operit 长期不来导致堆积） |
| 存储 | 进程内存（桥常驻单实例，够用） |
| 筛选 | 入队前已过**静默时段**与**日上限**闸门 |

### Operit 侧怎么接

工作流配置为**定时触发**（间隔建议 10~30 分钟），动作：调 `get_pending_notice` → 若 `has_notice=true` 则把 `notice` 注入对话并生成回复；否则直接结束。

### 与 webhook 的关系

`PROACTIVE_WEBHOOK` 保留但**默认留空**。只有当 Operit 确实存在"可被外部 POST"的入口时才需要填。正常情况下走 MCP 队列即可，不需要它。

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

**根因**：节流比较的是 **block 渲染文本**，而档位词粒度远粗于数值。

```
labelValence(-0.03) === '中性'
labelValence(0)     === '中性'     →  渲染出的块逐字相同
```

状态明明在漂（`0 → -0.03 → -0.01`），但渲染文本一字不变 → 判为"没变" → 静默跳过。

**修法**：指纹取**数值**，不取文本。

```js
// bridge.js
const sig = [state.connection, state.pride, state.valence, state.arousal]
  .map((x) => (Number(x) || 0).toFixed(2)).join(',');
const changed = sig !== lastInjectSig;
```

模型看到的文本还是「心情：中性」，但**只要数值动了就重注**。2 位小数 = 状态可感知变化阈值。

**验证**：`_test/throttle_check.js` 5/5；`_test/e2e_bridge.js` 15/15；VPS 实测连续三轮 `inject=true`（档位词全程未变）。

**遗留观察点**：`connection` 每轮被 `resetConnection()` 清零，导致「想念」轴在频繁聊天时永远涨不起来（需靠 tick 的时间累积，`CONNECTION_RATE=0.0007/min` ≈ 24 小时涨满）。真实节奏下是否合适，待长时间观察。

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
| `提示词全量清单.md` | **给 AI 读**。含阅读说明、五轴定义、两种场景的区别、阈值速查、360 条全文、附录 |
| `提示词全量清单.html` | **给人看**。按簇分组、可折叠、覆盖格标红 |

内容：180 格（9 簇 × 5 pride × 4 connection）× 2 场景 = **360 条**全部提示词。

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
| 越线时的开口动机文案 | `config/tone-harlan.json` 的 `contactOverride` |
| 独处场景的正文 | `config/tone-harlan.json` 的 `sceneOverride` |
| 判定标准（什么算冒犯、什么算示弱） | `config/analyze-prompt-user.txt` |
| 主动唤醒的早晚/频率 | `.env` 的 `CONNECTION_RATE` / `PROACTIVE_MAX_PER_DAY` |
| 注入块里显示什么 | `lib/inject-text.js` |
| 注入节流（多久重注一次） | `bridge.js` 的 `shouldInject` / `.env` 的 `INJECT_THROTTLE_SECONDS` |
| MCP 工具的描述或返回值 | `lib/mcp.js` 的 `buildToolDefs` / `callTool` |
| 换判定器模型 | `.env` 的 `LLM_BASE` / `LLM_KEY` / `LLM_MODEL` / `LLM_DISABLE_THINKING` |
| 看判定器实际表现 | `node _test/simulate_loop.js`（闭环）或 `analyze_check.js`（单例） |
| 验 MCP 协议是否正常 | `node _test/mcp_check.js`（31 例，不起真桥） |

**校准方法**：跑两天，翻 `bridge.log`，找那些"这句语气不对"的地方，看当时 `[TICK]` 行的五轴值落在哪一档，改对应的格子。改完跑 `node _test/build_prompt_html.js` 重新生成清单对照。
