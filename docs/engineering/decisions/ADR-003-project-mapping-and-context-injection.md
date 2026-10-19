> 复原说明：本页为 2026-10-14 S0 记录的原文复原（来源提交 bd16535）。2026-10-19 已在 DSH 44.7.0 上做部分复核，结论见 [S0 复核记录](../s0-reverification-20261019.md)；未复核部分仍是「提议」，不得当作已验证。

# ADR-003：项目映射与默认背景注入（workspace 归属 + 每轮上下文）

- 日期：2026-10-14
- 状态：提议（Proposed）
- 决策范围：宿主半（`packages/plugin`），影响项目标识、工作范围、默认背景快照
- 来源规则：OBJ 系列（项目/对象标识）、CTX 系列（背景与读取）、F01、F04、F11、HOST-01、HOST-04、HOST-06
- 关联决策：[ADR-001 会话派发与整理执行载体](./ADR-001-session-dispatch-and-consolidation-carrier.md)

## 1. 要解决的问题

HOST-01 要求「明确项目标识、项目名称及工作范围；范围失效可辨识」，HOST-04 要求「发送前准备可核对背景快照、送达结果及实际使用标记」。看板必须回答两个问题：

1. **「项目」在宿主里到底是什么？** 它的身份键是什么、名称能否作为身份、路径失效时怎么办、工作对话如何归属到项目？
2. **默认背景快照走哪条通道？** 它必须能被模型看到、能留下「实际使用」的持久证据，且**不能冒充人工提问**。

## 2. 可核对的宿主事实（本 ADR 的事实基础）

本次 spike 在隔离宿主中实测；源码以 `dsh-workspace`、`dsh-api-session-controller`、`dsh-time-context` 为准。

### 2.1 项目 = workspace 实体，身份键是**规范化绝对路径**

| # | 事实 | 证据 |
| --- | --- | --- |
| W1 | `ctx.workspaceRegistry` 提供 `create(path,title?)`、`get(id)`、`list()`、`resolveByPath(path)`、`delete(id)`、`insertBefore`、`archiveSession`/`unarchiveSession`、`pinSession`/`unpinSession` | 服务目录 |
| W2 | `create(path)` 经 `fs.realpath` **规范化**；同一规范化路径重复调用**返回既有实体且不改标题**；不同路径**可以同名** | 源码注释；实测两次 `create` 得到同一 id |
| W3 | `resolveByPath(path)` **不创建**；路径不存在时 `realpath` 直接 reject（`ENOENT`） | 实测 `ENOENT: … realpath '…does-not-exist'` |
| W4 | `Workspace.sessionIds` getter 按「会话 header 的规范化 cwd == 该 workspace 的 path」过滤，是**派生视图**而非存储字段 | 源码 `dsh-workspace/lib/types/entity.js:51-53` |
| W5 | `attachSession(id)` 在三处拒绝：header **无 cwd**、cwd **无法 realpath**、cwd 解析后**不等于** workspace path | 源码 `entity.js:57-89`；实测两条拒绝文案 |
| W6 | `status()` 在目录不可用时返回 `'missing-dir'`（任何 `stat` 失败），**记录本身不变**；`list()` 仍返回该 workspace；`resolveByPath` 对同一路径则 reject | 源码 `entity.js:114-123`；实测三者同时成立 |
| W7 | `sessionController.create({workspaceId})` 会把会话 `cwd` 设为 `workspace.path` **并**在创建后 `attachSession`；`create({cwd})` 则**不**挂载项目 | 源码 `:571-598`；实测 `headerCwd` = 项目路径且 `attachedToWorkspace=true` |
| W8 | 会话与库存储**不是按 profile 隔离**，而是按 `DSH_HOME` 全局：`$DSH_HOME/sessions/**`、`$DSH_HOME/storages/**` | 实测隔离宿主自动生成上述目录；`~/.dsh/storages/workspace.json` 为 profile 无关的唯一库 |

### 2.2 默认背景注入 = `{prepend:true}` 的 `agent/pre-step` + 一个投影单元

| # | 事实 | 证据 |
| --- | --- | --- |
| C1 | `ctx.on('agent/pre-step', handler, {prepend:true})`，`await next()` 取 `PreStepDecision`，返回 `{...decision, messages:[...decision.messages, createUserMessage({content, source})]}` | 官方参考实现 `dsh-time-context/lib/index.js:215-247` |
| C2 | 注入消息的 `source` 形如 `{kind:'plugin', plugin:<name>, form:'snapshot', sections:[{name,text}]}` | 同上 `:236-244`；实测落库 `src=plugin/aikanban-probe`、`form='snapshot'` |
| C3 | 注入落库为**持久** `user/message` 事件；`source.kind !== 'user'` 因而**不冒充人工提问**，且**不进** `turnOutline` | 实测：`seq=11` 落库；`turnOutline` 仅含派发文本、不含注入标记 |
| C4 | `agent/pre-step` **每步**触发，不是每提示触发；因此必须自行判定 | 事件签名；`dsh-time-context` 用 `refreshIntervalMs` 节流（见下） |
| C5 | `request/header`、`request/context` 是变更日志，不含提示文本 | 实测 `seq=12/13` |
| C6 | 投影单元 `ctx.sessionProjections.register({key, stateVersion, stateSchema, init, apply})` 是纯同步折叠，只看到**已提交**事件，是「恰好落库一次」的权威计数 | 源码 `dsh-session-projection/lib/types/index.d.ts`；实测原始日志扫描与投影计数**各自**得到 1 |

**对任务描述的一处更正（以源码为准）**：任务描述称「官方 `dsh-time-context` 用 `step === 1`」判定是否注入。逐行核对后并非如此：`dsh-time-context` 在 `step === 1` 时只用于选择「距上一条可见消息」的基准文案（`index.js:225`），**是否注入由 `refreshIntervalMs` 节流决定**（`:220-223`），并不存在 `step === 1` 的注入闸门。本 ADR 采用 `step === 1` 作为闸门（每个提示注入一次），这是**本项目的选择**，不是对官方行为的复刻。

## 3. 可选方案

### 3.1 项目身份键

| # | 方案 | 说明 |
| --- | --- | --- |
| A | **以 workspace 实体为「项目」，以 `workspace.id` 为持久标识、规范化路径为归属键** | 本 ADR 采用 |
| B | 以标题为身份 | W2 已否证：不同路径可以同名 |
| C | 以原始（未规范化）路径字符串为键 | 同一目录的多种拼写/大小写/软链会分裂成多个项目 |

### 3.2 默认背景通道

| # | 方案 | 说明 |
| --- | --- | --- |
| D | **`agent/pre-step` 前置注入 + 投影单元** | 本 ADR 采用 |
| E | 每次发前由 `sessionController.prompt` 派发背景 | 落库为 `source.kind='user'`，冒充人工提问，违反 CTX 语义 |
| F | 写入系统提示（`system/message`） | 系统提示在请求序列内是「变更日志」语义，且不产生「本轮实际使用」的逐轮证据 |

## 4. 采用方案与理由

### 4.1 项目映射（采用 A）

1. **项目标识 = `workspaceRegistry` 的 `workspace.id`**；**项目名称 = `workspace.title`，仅供显示，绝不作为身份**（W2）。
2. **归属键 = 会话 `SessionHeader.cwd` 的规范化路径**；「项目含哪些对话」不另建索引，直接读 `workspace.sessionIds`（W4）。这样归属只有一个真相来源（`cwd`），不会与看板自建索引漂移。
3. **创建项目对话一律用 `create({workspaceId})`**，由宿主同时设置 `cwd` 并挂载（W7）。禁止「先 `create({cwd})` 再期望自动归属」。
4. **切换项目 = 切换 `workspace.id`，读取范围 = 该 workspace 的 `sessionIds`**（W4）。跨项目读取必须显式带上另一个 `workspace.id`，不存在「按标题模糊匹配」的读取路径。
5. **范围失效必须可辨识且有两条通道**（W6）：
   - 目录消失 → `workspace.status() === 'missing-dir'`：项目**仍列出**、记录**不删**、对话列表仍可读，界面须显示「工作范围不可用」而不是把项目当空项目；
   - 按路径查找 → `resolveByPath` **reject（ENOENT）**：这是「路径不成立」的硬信号，不得吞掉后当作「未归属」。
6. **`SessionHeader.cwd` 缺失/失效时的行为**（W5）：该会话**无法**被 `attachSession` 到任何项目（分别报「carries no cwd to validate against」与「its cwd … does not resolve」）。看板必须把这类会话表达为**未归属**，且不得为了归属而猜测项目；`create({workspaceId})` 路径不会产生这种会话。
7. **`workspace.sessionIds` 是派生视图**：它按 header 索引过滤，因此一个已 detach 或 cwd 不再成立的会话会自动从项目列表中消失，而日志本身不受影响。看板不得把它当作「曾属于该项目的全部对话」的历史证据——历史隔离要求（REC 系列）需要另建显式归属记录。
8. **决定（项目键与范围失效的规范表述）**：
   - **项目键 = `workspace.id`。** 看板的一切持久引用（任务、正式记录、背景快照、整理对话归属）都以 `workspace.id` 为外键；**标题只用于显示，任何读取、匹配、去重都不得使用标题**，因为两个不同路径可以共享同一标题（实测 `distinctIds=2`）。
   - **工作范围 = `workspace.path`（规范化绝对路径）。** `create(path)` 幂等（同一路径重复调用返回同一 id）是归属稳定的前提：路径是身份的自然键，id 是其持久代理。
   - **工作范围目录缺失时（OBJ-01、F01-R07）**：`status()` 返回 `'missing-dir'`，但**记录仍在 `list()` 中、id 仍有效**（均已实测）。因此看板的规范行为是：
     1. **管理数据全部保留**：项目、任务、正式记录、版本链、草稿、待确认结论一律照常读取与编辑，**不因目录缺失而删除、清空或隐藏**；
     2. 只在**需要真实文件系统动作**时拒绝（发新的工作对话、读取/写入产物、执行命令），并以「工作范围不可用」这一**独立、可见**的状态表达，而不是把它显示成空项目或错误；
     3. **不得**据此自动重建或改写 `workspace.path`；范围恢复（目录再次出现 → `status()` 回到 `'ok'`）后，同一 `workspace.id` 直接可用；
     4. 按路径**查找**失败（`resolveByPath` reject `ENOENT`）与「已知项目范围失效」是两件不同的事：后者靠 id 命中、靠 `status()` 判定，前者只是「这个路径此刻不对应任何项目」，不得把两者混为一谈，否则范围失效会被误判为项目不存在。

### 4.2 默认背景注入（采用 D）

1. **通道**：`{prepend:true}` 的 `agent/pre-step` 监听 + 一个 `sessionProjections` 单元，完全照 `dsh-time-context` 的结构（C1、C2、C6）。
2. **闸门**：本插件在 `step === 1` 才注入，保证「每个提示恰好一次背景快照」（C4）。
3. **来源标识**：`source.kind='plugin'` + `source.plugin=<本插件名>`，用 `form:'snapshot'` 与 `sections` 表达「这是一份背景快照」（C2）。这正是「不冒充人工提问」的实现依据（C3）。
4. **实际使用证据**：以「日志中出现且仅出现一条 `source.plugin === <本插件名>` 的 `user/message`，其 `seq` 即快照的持久证据」为「本轮实际使用了哪一版背景」（C6）。**不得**用 `request/header`/`request/context` 作为投递内容证据（C5）。
5. **不做隐式注入**：注入必须显式绑定到目标会话（探针按会话 id 闸门）。这是为了满足「不得在用户正在工作的会话里悄悄注入背景」这一可观测性要求；产品化后应绑定到「本项目 + 该会话已开启背景」的显式状态。

## 5. 影响功能

- **F01/HOST-01**：项目标识、名称、工作范围、范围失效辨识 → 4.1 第 1/2/5 条。
- **F04/HOST-02**：创建/打开独立工作对话 → 4.1 第 3 条（`create({workspaceId})`）。
- **F06/F12/HOST-06**：按范围读出 → 4.1 第 4/7 条。
- **F11/HOST-04**：默认背景快照与实际使用标记 → 4.2。
- **CTX-01…**：固定归属与历史隔离 → 4.1 第 7 条的约束（需要显式归属记录，不能依赖派生视图）。

## 6. 约束与代价

- **`sessionIds` 是派生视图，不是历史**：这是最重要的代价。任何「该对话曾经属于本项目」的断言都不能由它承担；需要版本化的显式归属（与 ADR-002 的记录模型同层）。
- **会话/存储按 `DSH_HOME` 全局，不按 profile**（W8）：同一台机器上换 profile 不会换数据；看板不得假设「每个 profile 一套数据」。
- **规范化路径是唯一归属键**：同一物理目录经软链/不同盘符拼写访问时，`cwd` 与 workspace path 的规范化结果必须一致才能归属（W5）；不一致会被拒绝而不是被纠偏。
- **注入对模型是用户角色消息**：`agent/pre-step` 注入的是 `role:'user'`（`createUserMessage`），只是来源不同。模型可能把它当作指令执行，因此快照文本必须自述「这是上下文而非指令」，并保持精简。
- **注入每步都会经过监听器**：闸门写错会导致每步重复注入并污染日志与 token；因此闸门必须由投影/日志证据验证，而不能只看代码。

## 7. 验证证据

隔离宿主一次真实运行（18/18 步骤通过）。项目映射（8 项全部实测通过）：

| 检查 | 实测结果 |
| --- | --- |
| `list()` | 3 个 workspace；其中真实项目 `03696d17-12c2-4d78-9b3e-ff3bdf9e6f10` / `D:\BaiduSyncdisk\dsh-plugin\AIKanBan` / 标题 `AIKanBan` |
| `resolveByPath(项目路径)` | 命中同一 id，`status()='ok'` |
| `create(项目路径,'AIKanBan')` 幂等 | `beforeId === afterId`，标题未被改写 |
| 同名不同路径 | 两个 workspace 标题均为 `AIKanBan`，id 不同（`distinctIds=2`） |
| `resolveByPath(不存在路径)` | reject：`ENOENT: … realpath '…does-not-exist'` |
| 目录消失 | `status()='missing-dir'`、`stillListed=true`、`resolveByPath` reject |
| `create({workspaceId})` | `headerCwd='D:\BaiduSyncdisk\dsh-plugin\AIKanBan'`、`agentPreset='standard'`、`attachedToWorkspace=true` |
| `attachSession` cwd 不匹配 | reject：`its cwd resolves to 'D:\BaiduSyncdisk\dsh-plugin\AIKanBan'` |
| `attachSession` 无 cwd | reject：`its stored header carries no cwd to validate against` |

默认背景注入：

- 持久日志中**恰好 1 条** `source.kind='plugin'`、`source.plugin='aikanban-probe'`、`form='snapshot'` 的 `user/message`，`seq=11`。
- 两个**互相独立**的计数一致：原始日志扫描 = 1；本插件投影单元 `injections.length` = 1。
- `agent/pre-step` 实际调用记录：`{turn:1, step:1, decisionKind:'enter', incomingMessages:3, injected:true}`；`injections` 只发生在 step 1。
- `turnOutline`（`asOfSeq=18`）= `[{turn:1, seq:4, prompt:'Reply with the single word ACK, then use the pwsh…', response:''}]`：含派发文本、**不含** `AIKANBAN-PROBE-CONTEXT` 注入标记。
- 该宿主投影注册表同时暴露 18 个键（`title`、`goal`、`tokenUsage`、`turnOutline`、`subagent` …），
  且 `follow()` 的 `snapshot` 帧与 `inspect()` 在同一刻给出同一组键与同一 `cursor=18`，证明注入与既有投影共存无冲突。
- 三条读取通道（`inspect` / `follow` 快照 / `page`）对同一日志给出一致的 19 条事件，且 `page` 的
  `includesInjectedBlock=true`：注入块在**冷安全分页**里也可读，即「实际使用标记」不依赖实时会话。

### 7.1 证据分级（按物种分别标注，不合并）

| 结论 | 级别 | 依据 |
| --- | --- | --- |
| 项目映射的 8 项行为 | **已验证（真实运行证据）** | 见上表逐项实测结果 |
| 注入**恰好落库一次**（两个独立计数一致） | **已验证（真实 seq 证据）** | 原始日志扫描 = 1 且投影 `injections.length` = 1，均为 `seq=11` |
| 注入**只发生在 `step 1`** | **已验证（真实 handler 调用记录 + 代码闸门）** | `agent/pre-step` 实际调用记录为 `{turn:1, step:1, injected:true}`；本轮只产生了 step 1 |
| 注入**不被 `turnOutline` 当人工提问** | **已验证（真实 seq 证据）** | `turnOutline` 含派发文本、不含注入标记 |
| 注入块可被**冷安全分页**读到 | **已验证（真实 seq 证据）** | `page` 的 `includesInjectedBlock=true` |
| **真实多步轮次下 step 2 不再注入** | **未验证 —— 未执行真实 provider 轮次** | 见下 |

**必须分清的一点**：未验证的是「由真实工具调用驱动出 step 2，并在 step 2 观察 handler 不注入」。
缺失的只是一个真实 provider 轮次，**不是注入机制本身**：`step 1` 的注入是真实执行的（handler 调用记录 + 落库事件 + 两个独立计数），
闸门 `step !== 1 → return decision` 也已由源码与 step 1 实测共同确认。此项在 S0 阶段**永久延期**，
原因是一条**产品/安全决定，不是技术障碍**：真实凭据不得被物化到同步工作区目录内（写入凭据的尝试被用户本人拒绝）。

### 7.2 工程事实：隔离 home 是一次性的，探针证据必须落在仓库里

本次 S0 期间真实发生了一次证据风险事件：`tools/probe-host.mjs`（S0-W1 的加载链探针）会对它使用的 home 执行
`rmSync`，因此**运行它会把 `.probe-home/` 整个删掉**，包括我放在那里的 workspace 夹具与生成的 overlay；
它也确实在 12:55 与 13:16 各执行过一次，并顺带删掉了当时正准备写入的凭据文件。

由此得出两条必须写清的工程约定，否则下一个人还会丢证据：

1. **`.probe-home/` 是一次性目录，永远不要把它当作证据或状态的家。** 它被 `.gitignore` 覆盖，
   删除永远安全；`packages/plugin/src/probe/harness/prepare.mjs` 能从仓库内的文件完整重建它
   （探针包副本、真实 workspace 夹具、生成的 `--patch` overlay）。任何依赖 home 历史状态的设计都是错的。
2. **探针证据必须写进仓库。** 本探针的报告路径刻意指向
   `packages/plugin/src/probe/evidence/probe-report.json`（仓库内），而不是 `$DSH_HOME`；
   正因如此，13:16 的整目录删除**没有**丢失任何证据——20/20 步的那次运行报告至今完整。
   这条约定同样适用于后续阶段：**证据落仓库，运行环境可丢弃。**

两个探针若要同时稳定存在，必须使用不同的 home（`tools/probe-host.mjs` 支持 `--home`；
本探针的 home 由 `harness/prepare.mjs <home>` 与启动时的 `DSH_HOME` 共同指定）。

## 8. 尚未验证

1. **真实多步轮次下 step 2 不再注入**：`multiStepObserved=false`。原因见 7.1——未执行真实 provider 轮次（凭据被刻意排除），
   因此「step 2 不再注入」只在代码闸门与 step 1 的实测上成立，**没有真实多步事件序列**。此项在 S0 阶段永久延期。
2. **模型侧效果**：注入内容是否真的被模型读到并影响回答，未验证（同上，无真实 provider 轮次）。
   注意区分：**注入事件确实进入了模型请求的历史**（它是 `seq=11` 的持久 `user/message`，位于 `request/header`@`seq=12` 之前），
   但「模型实际读到了它」没有 live 证据。
3. **跨项目读取隔离**：只验证了归属键与读取面的行为，未构造「两个项目各有对话、读取不串数据」的端到端场景。
4. **`SessionHeader.cwd` 指向一个已消失目录的会话**：只验证了 `attachSession` 的两条拒绝路径与 `workspace.status()`；未验证该会话在 `sessionIds` 中的实际显示结果。
5. **重启后的持久性**：注入事件与项目归属在重启后的读回未验证。

## 9. 被替代关系

无。若将来宿主提供「背景快照」的一等原语（可标注来源且进入导航），本 ADR 的 4.2 节可被替代；若提供项目/工作范围的一等实体，4.1 节可被替代。

## 10. 公开语义未变

本 ADR 不改变成对保存、固定归属、历史隔离、人工修正等产品语义。特别地，4.1 第 7 条**加强**了历史隔离约束（禁止用派生视图充当历史归属），与 [ADR-002](./ADR-002-paired-confirmation-single-write.md) 的记录模型相容。
