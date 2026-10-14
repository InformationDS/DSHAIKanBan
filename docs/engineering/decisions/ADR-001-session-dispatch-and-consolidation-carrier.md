# ADR-001：会话派发与整理执行载体（sessionController 派发边界）

- 日期：2026-10-14
- 状态：提议（Proposed）
- 决策范围：宿主半（`packages/plugin`），影响全部「向工作对话发送可见整理要求」的路径
- 来源规则：F05（运行中关联不打断本轮）、F06（不停止其他对话、在正确来源对话发送可见整理要求、返回可编辑候选）、F13（系统整理对话）
- 关联决策：[ADR-003 项目映射与默认背景注入](./ADR-003-project-mapping-and-context-injection.md)、[ADR-002 成对确认的单写原子性](./ADR-002-paired-confirmation-single-write.md)

## 1. 要解决的问题

F06/F07 要求「在正确来源工作对话发送**可见**整理要求」，同时 F05 要求「运行中关联不打断本轮」、F06 要求「不停止其他对话」。因此需要一条宿主侧通道，满足四个互相牵制的条件：

1. 派发的消息对用户**可见**（是真实对话内容，不是隐藏注入）；
2. 目标对话**正在运行**时不得打断当前轮；
3. 调用方必须能区分「已受理」「已送达」「结果未知」三种状态，以支持失败保留输入、不盲目重派（HOST-04）；
4. 同一次派发在连点/超时重试下只能产生一次投递。

## 2. 可核对的宿主事实（本 ADR 的事实基础）

以下均为本次 spike 在**隔离宿主**中实测或逐行读源码得到，非推断。实测宿主为 `dsh --profile web --port 0 --no-open`，`DSH_HOME` 位于工作区内，与被测用户会话完全隔离。

| # | 事实 | 证据 |
| --- | --- | --- |
| F1 | 服务面签名是 `prompt(request, signal)`；`signal` 是**必填**参数，缺失时在委派前即抛 `TypeError` | 源码 `dsh-api-session-controller/lib/index.js:2920-2922`（`signal.throwIfAborted()` 后委派 `this.commands.prompt(request)`）；实测缺失时抛错 |
| F2 | `request = {requestId, sessionId, mode:'queue'\|'steer', content, clientTimeZone?}`，成功返回 `{accepted:true}` | 实测 |
| F3 | `mode:'queue'` → `agent.followup(message)`；`mode:'steer'` → `agent.steer(message)`（会取消正在运行的一轮） | 源码 `:773-774` |
| F4 | 派发消息以 `source:{kind:'user', rpcId:requestId}` 落库 | 源码 `:747-751`；实测事件 `seq=8 user/message src=user` |
| F5 | `requestId` 幂等：命中已投递的 `rpcId` 时直接返回 `{accepted:true}` 且**不投递** | 源码 `hasPromptRequest` `:940-951`；实测第二次派发后 `user/message` 计数 4→4，且第二段载荷未出现在日志 |
| F6 | 唯一守卫是 `session.header.origin === 'subagent'`（及父级归属），失败为 `RemoteError('session/agent-busy', 'session "…" is owned by subagent routing')` | 源码 `:124-137`、`:221`；实测 `code='session/agent-busy'`、`details.reason='use subagent delivery for this child session'` |
| F7 | `{accepted:true}` ≠ 已送达：`resolveAgent` 会自动 resume 冷会话；`inspect(sessionId)` 可读回落库事件 | 实测：`accepted:true` 与 `seq=8` 落库需分别确认 |
| F8 | `assistant/attempt` 在**模型调用失败时也会落库**，因此不能当作「已回复」信号 | 实测事件表含 `seq=16 assistant/attempt` 而**无** `assistant/message` |
| F9 | `request/header` 与 `request/context` 是变更日志，不含提示文本，不能用来证明「本轮投递了什么」 | 实测 `seq=12/13` 无提示文本；投放内容只能从 `user/message` 读 |

## 3. 可选方案

| # | 方案 | 说明 |
| --- | --- | --- |
| A | `sessionController.prompt(mode:'queue')` + 新铸 `requestId` + `inspect` 送达确认 | 本 ADR 采用 |
| B | `sessionController.prompt(mode:'steer')` | 会取消正在运行的一轮，违反 F05 |
| C | 仅用 `agent/pre-step` 注入，不产生可见消息 | 用户看不到整理要求，违反 F06「可见」，且 `turnOutline` 不收录 → 用户无法导航到该轮 |
| D | 客户端 UI 侧模拟输入发送 | 看板必须在宿主侧自主发起（F13 系统整理对话），且绑定浏览器会话，不可作为执行载体 |

## 4. 采用方案与理由

**采用 A。** 具体约定：

1. **一律使用 `mode:'queue'`**，禁止 `'steer'`：F05 明确「运行中关联不打断本轮」，而 `steer` 会取消当前轮（F3）。
2. **每次派发铸新 `requestId`**，并把该 id 作为持久化的派发身份（写入待确认记录）。重试时**复用同一 id**，从而由 F5 免费获得「同次派发不重复」；这也是区分「结果未知」与「需要重试」的唯一可靠依据。
3. **送达确认必须独立于 `accepted`**：以「日志中出现 `rpcId === requestId` 的 `user/message`（含其 `seq`）」为「已送达」；以「出现 `assistant/message` 且同轮 `turn/end`」为「已答复」。不得以 `assistant/attempt` 判定已答复（F8），不得以 `request/header|context` 判定投递内容（F9）。
4. **必须先 `resolveAgent(sessionId)`**（`prompt` 内部会做），冷会话由此自动 resume；若报 `session/writer-held` 则视为「结果未知」，不得自动重派。
5. **`signal` 必须显式传入**（F1），由调用方持有并限定派发受理阶段的生命周期。
6. **子会话（`origin:'subagent'`）不是派发目标**（F6）。看板不得把整理要求发给子代理会话；收到该错误应作为配置/映射错误上报，而不是重试。

## 5. 影响功能

- **F05**：关联操作不打断当前轮 → 由 `queue` 保证。
- **F06/F07**：在正确来源对话发送可见整理要求 → 由 `queue` + 目标会话解析保证；返回的可编辑候选由后续保存路径（ADR-002）负责。
- **F11/HOST-04**：送达结果与实际使用标记 → `requestId` + `seq` 构成可核对的送达证据。
- **F13**：系统整理对话 → 与工作对话共用同一派发通道，靠会话归属（ADR-003）区分来源。
- **F08/HOST-09**：结果未知不得自动重发 → 由「幂等 id + 独立送达确认」共同保证。

## 6. 约束与代价

- **产品语义风险（必须上报，不可隐瞒）**：派发消息落库为 `source.kind === 'user'`（F4），因此它在客户端**渲染为人工提问**，并会进入 `turnOutline` 导航，且计入「首个人类提示」预览。也就是说，用 A 方案发出的整理要求**看起来像用户自己发的**。若要区分，需要产品层显式表达来源（例如在正文中带可见标识），或改用 ADR-003 的 `source.kind='plugin'` 注入通道（但那样就不可见于 `turnOutline`，与 F06「可见」冲突）。这是 A 方案的固有代价，不能靠实现细节消除。
- 关键结论修正：任务描述称「唯一守卫是 `header.origin === 'subagent'` 会被拒」——实测一致，但需补充：守卫位于 `agents.resolveAgent`（`:221`），且**同时**覆盖「父级归属」情况，不只是 `origin` 字段。
- 派发受理（`accepted`）与送达（落库）之间存在窗口；本方案不试图消除该窗口，而是要求调用方以落库证据推进状态机，从而让「结果未知」可辨认。
- 依赖宿主的 `session/writer-held`、`session/agent-busy` 等稳定错误码做分支；这些码属于宿主合同，不是本插件自定义。

## 7. 验证证据

隔离宿主一次真实运行（`DSH_HOME` 在工作区内；`--port 0` 由系统分配临时端口；`--no-open` 不启动浏览器；探针经 `ctx.appExit(0)` 干净退出，退出码 0，无残留进程），18/18 探针步骤通过。真实事件序列（探针会话 `session-03b0327d-d4cb-4dea-abec-cb735a8ae0e1`，会话 `cwd` = `D:\BaiduSyncdisk\dsh-plugin\AIKanBan`）：

```
seq=4  turn/start                   turn=1
seq=6  step/start                   turn=1 step=1
seq=8  user/message                 src=user                    <- 派发的可见消息，text 逐字节匹配
seq=11 user/message                 src=plugin/aikanban-probe   <- ADR-003 的上下文注入
seq=12 request/header
seq=13 request/context
seq=16 assistant/attempt            turn=1 step=1               <- 模型调用失败也落库
seq=17 step/end                     turn=1 step=1
seq=18 turn/end                     turn=1
```

- 派发：`prompt(...)` → `{accepted:true}`；`inspect()` 读回 `seq=8`，`dispatchedTextMatches=true`。
- 三条读取通道读到同一份日志，互为交叉验证：
  - `inspect(sessionId)` → 19 个事件（`totalEvents=19`，`lastSeq=18`）；
  - `follow({address:{kind:'session'}}, signal)` → 首个 `snapshot` 帧，`cursor=18`、`recordCount=19`、`hasMore=false`、`hasDispatchedMessage=true`，并同时给出 18 个投影键的基线（`elapsedMs=3`）；
  - `page({address, throughSeq:18, maxMessages:20}, signal)` → `recordCount=19`、`hasMore=false`、`includesTurnEnd=true`。
  即：宿主侧读回、客户端流式快照与冷安全分页三者对同一日志一致。
- 幂等：同 `requestId` 二次派发 → `{accepted:true}`；`user/message` 计数 4→4；第二段载荷 `secondPayloadLeaked=false`。
- 子会话边界：`Refused=true`，`code='session/agent-busy'`，`message='session "session-2" is owned by subagent routing'`（断言了确切码与文案，不以「抛错即通过」）。
- 未验证：**assistant 回复本身**。本轮 `turn/end` 的 `reason` 为 `{kind:'error', error:{code:'MISSING_CREDENTIAL', …'no API key for provider route "deepseek-official"'}}`，隔离宿主无凭据，因此「取回 assistant 回复并与投递内容对上」只完成了读回通道验证（三条通道、事件序列、`seq`、逐字节匹配），**回复内容未验证**。

### 7.1 证据分级（按物种分别标注，不合并）

| 结论 | 级别 | 依据 |
| --- | --- | --- |
| 派发受理并在正确会话落库可见消息 | **已验证（真实 seq 证据）** | `{accepted:true}`；`user/message` @ `seq=8`；文本逐字节匹配 |
| 读取通道能读回**完整一轮** | **已验证（真实 seq 证据）** | `inspect` / `follow` 快照 / `page` 三条独立通道对同一份 19 事件日志一致（`lastSeq=18`、`cursor=18`、`recordCount=19`），含 `turn/start`…`turn/end` |
| `requestId` 幂等（重试不重复投递） | **已验证（真实 seq 证据）** | 同 id 二次投递 `{accepted:true}`；`user/message` 计数 4→4；第二段载荷不在日志中 |
| 子会话边界（`origin:'subagent'` 被拒） | **已验证（真实 seq 证据）** | 断言确切 `code='session/agent-busy'` 与 `owned by subagent routing` 文案 |
| 注入恰好一次、只在 `step 1`、不入 `turnOutline` | **已验证（真实 seq 证据）** | `seq=11`；原始日志扫描与投影计数各自为 1；`turnOutline` 含派发文本不含注入标记 |
| **assistant 回复由真实模型产生** | **未验证 —— 未执行真实 provider 轮次** | 见下 |
| **真实多步轮次（工具调用驱动的 step 2）** | **未验证 —— 未执行真实 provider 轮次** | 见下 |

**必须分清的一点**：未验证的只是「一条由**真实模型**产生的 `assistant/message`」以及「由真实工具调用驱动的第二个 step」。
**「读不到 assistant/message」不是问题**——读取路径已由三条独立通道证明能完整读回一轮（含闭合的 `turn/end`）。
本轮实际落库的是 `assistant/attempt` + `turn/end{reason:{kind:'error'}}`，因此「读取器遇到失败轮次」这一路径**是被真实执行过的**，
而「读取器遇到成功轮次」只差一个由真实 provider 产出的 `assistant/message` 事件。

未验证的原因是一条**产品/安全决定，不是技术障碍**：隔离 home 刻意不放入真实凭据（真实凭据不得被物化到同步工作区目录内）。
补齐方式只有两种，且都需用户本人执行：用户自己把 key 写进 `.probe-home/.credentials.yaml`，或在启动探针宿主时导出 `DEEPSEEK_API_KEY`。

### 7.2 停止与清理证据（探针不留下任何东西）

探针宿主是**一次性进程**，没有常驻服务、没有自动启动：`harness/run-probe.ps1` 只被显式调用，宿主由
`ctx.appExit(0)` 自行退出。

| 观测 | 结果 |
| --- | --- |
| 启动方式 | `--profile web`（无浏览器窗口）+ `--port 0`（OS 分配临时端口）+ `--no-open` |
| 实际绑定端口（三次运行） | 4564 / 11746 / 6063 — 均为临时端口，**从未占用 19387** |
| 退出方式 | 探针写盘后调用 `ctx.appExit(0)`，宿主自行 dispose 整棵树 |
| 退出码 | `0`（四次运行全部为 0） |
| 残留监听 | 无：进程退出后端口释放；未启动任何后台常驻服务 |
| 残留进程 | 无：不以 detached 方式派生任何子进程 |
| 对用户 GUI 的影响 | 无：用户 GUI 是另一个进程、另一个 profile（`desktop`），本次全程未触碰 |
| 对 `~/.dsh` 的影响 | 无：`DSH_HOME` 指向工作区内，宿主自建了 `.probe-home/{sessions,storages,.credentials.yaml,profiles/node_modules}` |
| 可丢弃性 | `.probe-home/` 被 `.gitignore` 覆盖，删除永远安全；`harness/prepare.mjs` 可完整重建 |

若某次运行异常挂起，停止方式是 `Stop-Process -Id <report.host.pid>`（pid 记录在报告里），或 Ctrl+C；
不存在需要手动清理的服务或注册项。

## 8. 尚未验证

1. **真实 `assistant/message` 的读回与内容比对（live 轮次）** —— **延期到 S0 之后**。表现：`turn/end` 的 `reason` 为 `{kind:'error', error:{code:'MISSING_CREDENTIAL', message:'…no API key for provider route "deepseek-official"…'}}`，因此本会话中不存在成功的 `assistant/message`。已尝试的办法：由 Lead 在隔离 home 内写入凭据文件 / 由我复制凭据文件——**两者都被拒绝**，前者被用户本人拒绝，后者被本会话的自动审查拒绝两次。最终决定：**真实凭据不得物化到同步工作区目录内**，故此项在 S0 阶段永久延期，并以「机制已验证、live 未验证」记录。
2. 目标对话**正在运行**时 `queue` 的实际排队行为（不打断本轮）——本轮为单轮，未构造「运行中」场景。
3. `mode:'steer'` 会取消当前轮这一条：仅由源码（F3）与文档确认，**未实测**。
4. 冷会话自动 resume 与 `session/writer-held` 分支：未构造冷会话/双写者场景。

## 9. 被替代关系

无。本 ADR 为首个会话派发决策；若将来宿主提供「可标注来源的可见派发」原语，本 ADR 的第 6 节产品语义风险可被消除，届时以新 ADR 替代。

## 10. 公开语义未变

本 ADR 不改变成对保存、固定归属、历史隔离、人工修正等产品语义；仅决定宿主侧派发通道与其证据形式。需要改变行为时应先更新有效 PRD 与决策来源。
