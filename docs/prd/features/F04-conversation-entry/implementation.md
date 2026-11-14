# F04 implementation（实现记录：2026-11-14；HEAD `745bec9`）

> **性质**：本文是 F04「新建、继续与查看工作对话」**切片 A** 的**实现记录**，不是验收记录。记录范围是已提交的代码与门禁结果：项目入口“新建未关联对话”、任务入口“新建并固定归属当前任务”、以及打开对话。**F04 尚未安装到真实 `desktop` profile、未因 F04 重启、未在真实 GUI 中操作；F04 的 AT 全部待执行，尚无 `verification.md`。** 本文不引用 F01/F02/F03 的既有验收结论作为 F04 证据，也不把联合 AT 提前写成通过。
>
> **证据边界（2026-11-14，HEAD `745bec9`）**：代码提交为 `97d9c78 feat(conversation): add conversation/link attribution endpoint`（host/wire/transport 归属端点）、`93ab480 feat(conversation): add browser entry for new conversations`（controller/model/board/runtime 浏览器入口）、`745bec9 fix(conversation): probe uiWorkspace through reflect first`（只改 `packages/plugin-client/src/index.tsx`，把 `uiWorkspace` 探测顺序改为先 `reflect` 再 `get`，避免真实 shell 差异；不改变 F04 行为）。代码工作区干净（实现已在上述提交；本文档为本次同步）。门禁：**505 用例通过**（core 80 / plugin-client 231 / plugin 194）、`typecheck`/`build` `EXIT 0`、`verify-host-import` 11/11（脚本当前 11 项检查全部 PASS；既有汇总的 12/12 口径与实测不符，按实测记录）、`probe-host` 5/5、`verify-rpc-roundtrip` 37/37、`check_docs` PASS（65 Markdown）。其中 `verify-rpc-roundtrip` 的 `CONTRACT_ENDPOINTS` 仍是 **11 端点**（切片 A 5 + B 3 + F03 3），**不包含 `conversation/link`**；37/37 是既有端点的实 HTTP 断言，**不构成 F04 端点的真实 HTTP 覆盖**，F04 的 HTTP 证据来自 host 侧测试而非该工具。`uiWorkspace` 的运行时行为、blank session 复用语义与 `openSession` 的真实效果仍未在真实 GUI 验证。**未安装/未重启/未真实 GUI/AT 待执行**；不能把本文的代码与门禁结果写成 F04 已验收。

## 1. 切片 A 范围与已落地内容

### 1.1 本切片已落地的三件事

1. **项目入口新建未关联对话**：项目区提供“新建对话（不关联任务）”，调用浏览器侧工作区能力 `uiWorkspace.connectWorkspace(projectId)` 创建或复用该项目的 blank session，再 `uiWorkspace.openSession(conversationId)` 打开；**不调用** `conversation/link`，不写任务归属。
2. **任务入口新建并固定归属**：任务详情提供“新建对话（固定归属当前任务）”，先 `connectWorkspace(projectId)` 得到 blank session，再调用 host `conversation/link` 把该 `conversationId` 固定归属到当前 `taskId`，成功后 `openSession(conversationId)` 打开；不复制历史、不重复绑定、不弹二次确认。
3. **打开**：只打开本次 connect 得到、并由（任务入口时）link 成功的对话；不做对话列表、搜索、继续任意既有对话、改选目标或来源展示。

本切片只建立“可继续输入、且任务入口已固定归属”的工作对话入口；发送消息后的实际工作、背景准备、记录形成均不在本切片。

### 1.2 明确不在本切片

| 能力 | 归属 / 本切片处理 |
| --- | --- |
| 工作对话列表、搜索、按全部/未关联/已关联筛选 | F04 后续切片；当前不渲染列表 |
| 继续任意既有对话、快捷继续、改选目标 | F04 后续切片；当前只打开刚 connect 的对话 |
| 已有对话绑定/解除绑定、候选归属 | F05；当前只在任务入口新建后固定归属，不提供改绑 |
| 默认背景、准备、发送同步、背景失败重试 | F11；当前不发送消息，不宣称背景已准备或已使用 |
| 任务记录、成对确认、来源对话链接 | F06；当前不形成记录 |
| 系统整理对话及其列表隔离 | F13；当前不创建/不展示系统整理对话 |
| 来源删除后的入口降级 | F17；当前不实现 |
| 对话标题同步/重命名、最近实际使用排序 | F04-R05 后续；当前不写标题、不声称与桌面标题一致 |
| 运行状态、阶段、记录存在、最近整理位置的完整展示 | 依赖 F02/F06/F11；当前只在打开后交给宿主对话界面 |

### 1.3 规则覆盖状态

| 规则 | 本切片状态 |
| --- | --- |
| F04-R01 项目内新建 | **代码/UI 已落地**：connect 得到未关联 blank session，不产生任务绑定；未安装/未真实 GUI |
| F04-R02 任务内新建与固定归属 | **代码/UI 已落地**：connect 后 `conversation/link`；`linked`/`already-linked` 都算成功；归档/删除拒绝未实现（见 §6） |
| F04-R03 创建流程与补偿 | **代码/UI 已落地**：connect/link/open 分步展示，按步骤重试；`requestId` 仅用于 link 重试/诊断 |
| F04-R04 打开与背景职责 | **部分覆盖**：只打开、不自动发送、不改状态、不形成记录；背景同步留给 F11 |
| F04-R05 列表和命名 | **不在本切片**：不渲染列表、不写标题 |
| F04-R06 记录与新内容提示 | **不在本切片**：依赖 F06 |
| F04-R07 来源不可用 | **不在本切片**：依赖 F17 |

## 2. 规则的实际落点（F04-R01—R04）

### 2.1 F04-R01 项目内新建

- **入口**：`packages/plugin-client/src/board.tsx` 的项目区工具条，在“项目总览”按钮之后；无进行中的 entry 时按钮带 `data-aikanban-new-project-conversation="true"`，文案“新建对话（不关联任务）”。
- **动作**：`BoardController.newProjectConversation()`（`controller.ts`）→ `startConversation('project')`。每次入口生成新的 `requestId`（`mintOperationId()`），把 entry 置为 `connecting`，再 `workspace.connectWorkspace(projectId)` 取得 `conversationId`；项目入口**直接进入 `opening`**，不调用 `conversation/link`。
- **打开**：`workspace.openSession(conversationId)`；成功后 `phase='opened'`、`step='open'`，显示“已打开未关联任务的工作对话。”
- **失败**：connect 失败保留 entry（`phase='failed'`、`step='connect'`、`code`），显示“对话准备失败，未产生对话。可重试。”；打开失败保留 `conversationId`，只重试打开。不生成列表行、不伪造对话 id。
- **空项目/无总览**：只要项目已解析且看板可读即可显示入口；不要求先完成任务或先有总览。
- **边界**：project 入口不写任务归属，也不调用 host 端点；host 对项目入口无感知。

### 2.2 F04-R02 任务内新建与固定归属

- **入口**：`board.tsx` 任务详情内，在 F03 概况区之后；无 entry 时按钮带 `data-aikanban-task-new-conversation="<taskId>"`，文案“新建对话（固定归属当前任务）”，旁边说明“该对话将固定归属当前任务，不复制此前历史”。
- **顺序**：
  1. `startConversation('task')` 取当前 `openTaskId` 与 `selectedProjectId`，生成 `requestId`，置 `connecting`；
  2. `workspace.connectWorkspace(projectId)` 得到 `conversationId`；
  3. 置 `linking`，调用 `source.linkConversation({ taskId, conversationId, requestId })` → host `conversation/link` → `core.linkConversation`；
  4. 成功值 `linkStatus:'linked'|'already-linked'` 均视为归属成立，置 `opening` 并 `workspace.openSession(conversationId)`。
- **归属成功条件**：只有 `linked`/`already-linked` 才显示“已创建并打开对话，并固定归属当前任务。”或“该对话此前已归属当前任务，已打开。”；归属未成功前不显示已归属。
- **拒绝**：会话已归属其他任务 → host `save-failed`，message 说明原归属不变；客户端保留该失败，不静默改绑、不重开第二条会话。
- **任务不存在/项目未登记** → `not-found`/`unknown-project`；不写归属。
- **归档/删除任务**：PRD 要求归档任务先恢复、已删除任务不能新建。当前 adapter **只做 `preReadTask` + 任务所属项目登记校验**，**归档/删除的拒绝尚未实现**（见 §6.2）；不能把归档/删除任务当作已支持。
- **host 不创建 session**：任务入口同样先由浏览器 `connectWorkspace` 得到会话，host 只接收 `conversationId` 做归属；host 不调用 `sessionController.create`，不存在 `conversation/create`。

### 2.3 F04-R03 创建流程与补偿

实际状态机（`ConversationEntryState`，`model.ts`）：

```text
phase: connecting | linking | opening | opened | failed
step:  connect | link | open
fields: scopeKind, scopeId, taskId, conversationId, requestId, linkStatus, code, error
```

- **分步展示**：`connecting` → “正在创建或复用空白对话…”；`linking` → “对话已就绪，正在写入任务归属…”；`opening` → “归属已写入，正在打开对话…”；成功按 scope 显示不同文案；失败按 `step` 显示 headline 与“重试创建对话/重试归属/重试打开”。
- **连点/重复入口**：`startConversation` 在当前 scope 已有 entry 时直接忽略（无论进行中还是已打开）；controller 测试覆盖“双击只 connect 一次”。
- **重试只补失败步骤**：`retryConversation(scopeKind)` 按 `step` 分派：connect 失败重新 connect；link 失败复用同一 `conversationId` 且**不重新 connect**；open 失败复用同一 id 且只重新打开。
- **requestId**：wire 上可选；任务入口每次入口生成并随 link 发送，仅用于重试/诊断。host 以 `conversationId` 做幂等：同一会话重复 link 返回 `already-linked`，仍是成功。
- **connect 成功、link 失败**：失败结果只有 `code`/`message`，客户端自己保存 `conversationId`/`taskId`（不依赖 wire details），只重试 link，不另建会话、不显示已归属。
- **link 结果未知**：客户端归为 `unknown-result`，显示“归属结果需核对”；重试同一 `conversationId`；host 返回 `already-linked` 时按成功处理。
- **打开失败**：保留 `conversationId` 与 `step='open'`，只重试打开；不重新 connect/link，不自动发送消息。
- **收起/切换**：`dismissConversation` 只在 settled（非 connecting/linking/opening）时清空 entry 并递增 seq；切换项目或关闭任务详情会重置对应 entry。`conversationStillCurrent` 用 seq 与当前 scope 丢弃迟到响应，避免旧项目的 connect/link 结果写进新上下文。
- **取消/离开**：若 connect/link 已成功而用户没有继续打开，entry 仍保留已准备的 `conversationId`；不会假称未发生，也不会自动重发。

### 2.4 F04-R04 打开与背景职责

- 打开仅调用 `uiWorkspace.openSession(conversationId)`；controller 不调用 `prompt`、不发送继续指令、不改任务状态、不形成记录、不自行开始工作。
- 打开失败保留 `conversationId` 与失败原因，提供重试；不会重新 connect/link，也不会把失败显示成“未准备”。
- 背景准备、发送同步属于 F11；本切片不显示“背景已使用”，不把“已关联”当作“已准备”。
- 对话运行中的实际状态展示留给 F02/F11；本切片不做运行状态快照，也不声称已展示实际运行状态。

## 3. 契约实现

### 3.1 core：复用既有 `linkConversation`，不改 core

F04 没有修改 `packages/core`。归属复用既有：

- `KanbanCore.linkConversation({ taskId, conversationId, at? })`：只写任务 scope 的 conversations 链接与时间；返回 `linked`、`already-linked` 或 `rejected`（`unknown-scope`、`rebind-forbidden`、`invalid-input`）。
- `LinkOutcome` 还包含供 `linkOutcomeTask` 使用的 `linked-outcome`/`already-linked-outcome`；`linkConversation` 本身只返回前三种结果。
- 不创建会话、不创建任务、不改任务标题/目标/状态、不产生记录；会话创建属于浏览器工作区能力，不属于 core。
- 本切片**不新增 core API**；core 的既有拒绝语义（尤其 `rebind-forbidden` 保留原归属）在适配层只做 code 映射，不改变。

### 3.2 wire：`conversation/link`

- **端点**：`BOARD_ENDPOINTS.conversationLink = 'conversation/link'`，`BOARD_ENDPOINTS` 由 11 增至 **12**。**不存在 `conversation/create` 端点**，wire 不承担 session 创建。
- **失败码**：仍为既有 **9 码**（`invalid-reason`、`invalid-input`、`not-found`、`save-failed`、`stale-baseline`、`unknown-result`、`read-failed`、`unknown-project`、`unavailable`），不新增浏览器可见失败码；host-only `invalid-payload` 不发给浏览器。
- **请求**（`LinkConversationPayload`）：

  ```text
  {
    taskId: string,          // 非空
    conversationId: string,  // 非空；浏览器 connect 得到的既有会话
    requestId?: string       // 可选；任务入口 controller 每次生成并发送，仅用于重试/诊断
  }
  ```

- **成功值**（`LinkConversationValue`）：

  ```text
  {
    taskId: string,
    conversationId: string,
    linkStatus: 'linked' | 'already-linked'
  }
  ```

  `already-linked` 表示同一 `conversationId` 已归属同一 `taskId`，是成功，不重复写。
- **失败值**：只有 `{ ok:false, code, message }`，**没有结构化 `details`**；客户端自己保存 `conversationId`/`taskId` 用于重试，不依赖 wire 回传。
- **失败映射**（实际 host adapter）：

  | 场景 | code | 说明 |
  | --- | --- | --- |
  | 请求体缺字段/空字符串 | `invalid-input` | host 前置校验；不写归属 |
  | 任务不存在/不可见 | `not-found` | `preReadTask` 拒绝 |
  | 所属项目未登记 | `unknown-project` | 不写归属 |
  | 会话已归属其他任务 | `save-failed` | message 说明原归属不变；**保留原归属**，拒绝本次 link，不改绑 |
  | 任务归档/删除等 PRD 禁止状态 | — | **尚未校验**；当前不把归档/删除任务当作已支持（见 §6.2） |
  | 归属写入失败 | `save-failed` | 不半写；可重试 |
  | 归属结果未知 | `unknown-result` | 重试同一 `conversationId`，`already-linked` 视为成功 |
  | host link 能力未绑定/不可用 | `unavailable` | 不写归属，不伪造成立 |
- **解析器**：`parseLinkConversationPayload`（`wire.ts`）校验 `taskId`/`conversationId` 为非空字符串、`requestId` 若出现也必须非空；payload 解析失败在 host handler 返回 host-only `invalid-payload`；成功值解析校验 `linkStatus` 两值。
- 该端点**没有真实 HTTP 的自动覆盖**：`tools/verify-rpc-roundtrip.mjs` 仍是 11 端点契约，不含 `conversation/link`；不要写“roundtrip 覆盖 F04”。

### 3.3 host：只做 link，不创建 session

- `packages/plugin/src/board-channel.ts`：
  - 新类型 `HostLinkConversationInput { taskId, conversationId, requestId? }`、`HostLinkConversationSuccess { ok:true, taskId, conversationId, linkStatus }`、`HostLinkConversationFailure { ok:false, code, message }`、`HostLinkConversationOutcome`；
  - `HostBoardPort.linkConversation(input, signal?)`；
  - `createBoardChannelHandler` 新增 `conversation/link` 分支：解析 payload → host 校验（缺字段/空值 → `invalid-payload`）→ 调 port → 失败透传 `code/message`，成功返回 `{ taskId, conversationId, linkStatus }`，未捕获异常 → `unknown-result`。
- `packages/plugin/src/board-adapter.ts`：
  - `workspaceRegistry()` 缺失 → `unavailable`；`deps.core()` 为空 → `unavailable`；
  - `preReadTask(taskId)`：任务不存在 → `not-found`；读取异常 → `save-failed`；
  - 任务所属项目在 `workspaceRegistry.get(...)` 中不存在 → `unknown-project`；
  - `core.linkConversation({ taskId, conversationId })` 的映射：`linked`/`linked-outcome` → `linked`；`already-linked`/`already-linked-outcome` → `already-linked`；`rejected/unknown-scope` → `not-found`；`rejected/rebind-forbidden` → `save-failed`（保留原归属）；`rejected/invalid-input` → `invalid-input`；其它 rejected 与异常 → `save-failed`/`unknown-result`；
  - **host 不调用 `sessionController.create`，不新增 `sessionController` accessor，不新增 `HostContext.sessionController`**；只依赖既有 core 与 workspaceRegistry。
- `packages/plugin/src/delayed-board-port.ts`：host 未就绪时 `linkConversation` 返回 `unavailable`；coreReady 后委托真实 port。

### 3.4 client：connect → link（任务）→ open

- **transport**（`packages/plugin-client/src/source.ts` / `channel-source.ts`）：
  - `LinkConversationInput { taskId, conversationId, requestId? }`、`LinkConversationSuccess`、`LinkConversationFailure`、`LinkConversationResult`；
  - `BoardSource.linkConversation(input)`；`channel-source.ts` 本地校验 id 非空 → `invalid-input`，按需带 `requestId`，调用 `call(BOARD_ENDPOINTS.conversationLink, payload)`；抛错 → `unknown-result`，未知失败码归一为 `save-failed`，成功值解析失败 → `unknown-result`；
  - 无通道时返回 `unavailable`，文案“看板数据通道未接通：无法写入任务归属，会话本身未被创建或修改。”
- **controller**（`controller.ts`）：
  - `WorkspacePort { connectWorkspace(projectId): Promise<string>; openSession(conversationId): void }`；
  - `newProjectConversation()`、`newTaskConversation()`、`retryConversation(scopeKind)`、`dismissConversation(scopeKind)`；
  - `startConversation` 每次入口生成 `requestId`、把 entry 置 `connecting`，项目入口 connect 后直接 open，任务入口 connect 后 link 再 open；
  - 每 scope 一个 entry，重复入口忽略；重试按 `step` 只补失败步骤；`dismiss` 仅 settled 可用；
  - seq + scope 校验丢弃切换项目/关闭详情后的迟到响应；
  - 打开调用 `workspace.openSession` 是同步接口；controller 包在 try/catch 中，异常归为 `failed/step='open'`。
- **runtime / index**（`runtime.ts` / `index.tsx`）：
  - `runtime` 保存可选 `WorkspacePort`；`setWorkspacePort` 设置并丢弃 controller；`getBoardController` 把 workspace 注入 controller；`resetBoardRuntime` 清空；
  - `index.tsx` 中 `UiWorkspaceLike` 只要求 `connectWorkspace` 与 `openSession` 两个函数，`isWorkspaceLike` 做结构判断；
  - 探测顺序是 `ctx.reflect?.get('uiWorkspace', false) ?? ctx.get?.('uiWorkspace')`（`745bec9` 修复点），**不声明 `inject`**；可用时设置 port 并记录“uiWorkspace available: conversation entry enabled”，不可用时设置 null 并记录“uiWorkspace unavailable: conversation entry explains itself”，F04 入口仍显示但点击后以 `unavailable` 解释，绝不伪造对话。
- **UI**（`board.tsx` / `model.ts`）：
  - 项目区按钮 `data-aikanban-new-project-conversation="true"`；任务详情按钮 `data-aikanban-task-new-conversation="<taskId>"`；
  - 有 entry 时渲染 `renderConversationArea`，数据属性 `data-aikanban-conversation`、`-phase`、`-status`、`-error`、`-retry`、`-progress`、`-id`、`-dismiss`；
  - `DETAIL_PLACEHOLDERS` 中 F04 的“任务对话”占位已被真实入口取代，不再同时显示“未实现”占位与按钮；
  - 文案与状态：见 §2.3 与 `model.ts` 的 `conversation*` 辅助函数；失败不会显示“已关联/已准备背景”。

## 4. 测试与门禁

### 4.1 覆盖的测试

- `packages/plugin-client/test/controller.test.ts`：F04 相关 11 条（项目入口不写归属、任务入口 link 后打开、双击只 connect 一次、connect 失败只重试 connect、link 失败保留 id 且只重试 link、open 失败只重试 open、`already-linked` 成功、无 workspace 时失败且不 link、切换项目丢弃迟到 connect、关闭详情丢弃迟到 connect、忙碌时拒绝收起）。
- `packages/plugin-client/test/wire.test.ts`：`conversation/link` payload/value 解析、失败值只有 code/message、无 details。
- `packages/plugin/test/channel-roundtrip.test.ts`：handler 层 6 条（真实 bundle 归属且不建 session、重复归属 `already-linked`、他任务归属 `save-failed` 且保留原主、畸形 payload、畸形成功值、空 id 本地拒绝）。
- `packages/plugin/test/board-adapter.test.ts`：adapter 6 条（`linked`、`already-linked`、他任务保留原归属、pre-read 抛错 → `save-failed`、core 抛错 → `unknown-result`、合法空 task summary 不依赖会话）。
- 这些测试证明代码/契约层行为；**不证明真实 GUI、`uiWorkspace` 真实语义或产品验收**。

### 4.2 门禁（2026-11-14 @ `745bec9`）

| 门禁 | 结果 | 备注 |
| --- | --- | --- |
| 全量测试 | **505 passed**（core 80 / plugin-client 231 / plugin 194） | 含 F04 新增测试 |
| `typecheck` | `EXIT 0` | |
| `build` | `EXIT 0` | |
| `verify-host-import` | 11/11 | 脚本当前 11 项检查全部 PASS；既有 12/12 口径与实测不符 |
| `probe-host` | 5/5 | |
| `verify-rpc-roundtrip` | 37/37 | **仍是 11 端点契约，不含 `conversation/link`；不覆盖 F04** |
| `check_docs` | PASS（65 Markdown） | 文档完整性检查，不代表产品验收 |

## 5. 仍未验证与已知限制

### 5.1 未验证（不得写成通过）

- **未安装到真实 `desktop` profile、未因 F04 重启、未在真实 GUI 操作**；F04 的 AT-09—12、AT-15、AT-20、AT-36、AT-57、AT-92—94、AT-100、AT-101 **全部待执行**，联合 AT 需 F06/F11 等联合验收；无 `verification.md`。
- `uiWorkspace` 的运行时形状、`connectWorkspace` 是否真正复用 blank session、返回的 `conversationId` 语义、`openSession` 是否触发执行及是否挂到项目工作区：均**未在真实 GUI 验证**。代码在不可用时只解释不伪造，但不能据此宣称真实环境已可用。
- 打开后的发送、运行状态、消息输入、背景准备属于宿主/F11；本切片未验证。
- 任务归档/删除的拒绝未实现（见 §5.2）。

### 5.2 已知限制与风险

- **归档/删除任务**：PRD 要求归档任务先恢复、已删除任务不能新建。当前 adapter 只校验任务存在与项目登记，没有归档/删除校验；在补齐前不能把这两类任务当作可用。
- **真实 HTTP 覆盖**：`verify-rpc-roundtrip` 不含 `conversation/link`；只有 host 侧测试，不能写“12 端点已真实 HTTP 覆盖”。
- **`uiWorkspace` 探测**：`745bec9` 只调整 `reflect`/`get` 顺序，真实 shell 中服务是否暴露、两方法签名是否完全一致仍未验证；若不可用，按钮会给出不可用说明而不是创建。
- **项目入口不写归属**：这是契约，不是缺口；host 对项目入口无端点、无会话创建。
- **标题/列表/搜索/继续既有对话/F11/F06/F13/F17** 均不在本切片；不要从 F04 代码推导这些能力。
- **host 不创建 session**：本切片没有 `sessionController.create`、没有 `conversation/create`；若后续需要会话创建，必须另立契约与任务。

## 6. 依据与链接

- 需求与验收行：[F04 PRD](prd.md) §1—§7；AT 清单见 §6。
- 宿主能力与工作区映射：[宿主能力合同](../../../engineering/host-capabilities.md) HOST-02（会话创建/工作区的部分证据）、HOST-03（消息投递边界）、HOST-08（AI 不可用信号）；[架构准备](../../../engineering/architecture.md) 的“项目 = workspace”与项目对话创建约定。
- 现有接线规格与 F04 接线记录：[S1 接线规格](../../../engineering/s1-wiring.md) §0/§11；[S1 接线实施记录](../../../engineering/s1-wiring-implementation.md) §22。
- core 固定归属契约：[类型定义](../../../../packages/core/src/types.ts) `LinkOutcome` 与 `linkConversation`；[core 实现](../../../../packages/core/src/core.ts) 的 `linkConversation`。
- 客户端实现：[wire.ts](../../../../packages/plugin-client/src/wire.ts) `conversation/link` 类型与解析器；[source.ts](../../../../packages/plugin-client/src/source.ts) `linkConversation`；[channel-source.ts](../../../../packages/plugin-client/src/channel-source.ts)；[controller.ts](../../../../packages/plugin-client/src/controller.ts) F04 状态机；[model.ts](../../../../packages/plugin-client/src/model.ts) 文案；[board.tsx](../../../../packages/plugin-client/src/board.tsx) 入口；[index.tsx](../../../../packages/plugin-client/src/index.tsx) `uiWorkspace` 探测。
- host 实现：[board-channel.ts](../../../../packages/plugin/src/board-channel.ts) `conversation/link` handler；[board-adapter.ts](../../../../packages/plugin/src/board-adapter.ts) `linkConversation`；[delayed-board-port.ts](../../../../packages/plugin/src/delayed-board-port.ts)。
- 交付状态与接线状态由[交付状态](../../../delivery/status.md)和 [S1 接线规格](../../../engineering/s1-wiring.md)维护；本文只记录实现与门禁，不维护功能级状态。
- 参考实现记录格式：[F03 implementation](../F03-manual-summaries/implementation.md)；F03 的已安装/验收结论不能借用为 F04 证据。
