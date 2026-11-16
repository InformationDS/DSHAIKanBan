# F04 implementation（实现记录：2026-11-17；HEAD `5e88bab`）

> **性质**：本文是 F04「新建、继续与查看工作对话」**切片 A** 的实现记录，不是验收记录。记录范围是已提交代码、已执行的构建/安装与真实 GUI 入口验证：项目入口“新建未关联对话”、任务入口“新建并固定归属当前任务”、以及打开对话。F04 **只验证到入口创建/归属/打开**；未执行真实双击连点，未验证发送/背景/记录/列表，AT-09、AT-100 仅部分执行，其余 AT 待执行或待联合验收。逐条结论见 [verification.md](verification.md)，不把联合 AT 提前写成通过。
>
> **证据边界（2026-11-17，HEAD `5e88bab`）**：代码提交为 `97d9c78 feat(conversation): add conversation/link attribution endpoint`（host/wire/transport 归属端点）、`93ab480 feat(conversation): add browser entry for new conversations`（controller/model/board/runtime 浏览器入口）、`745bec9 fix(conversation): probe uiWorkspace through reflect first`（探测顺序）、`5e88bab feat(conversation): create a fresh session through the host`（host `conversation/create` + client 改用 host 创建，修复任务入口复用已归属 blank session）、`fee1c32 fix(f04): resolve uiWorkspace on use after late binding`（`index.tsx`/`runtime.ts` 延迟解析 `uiWorkspace`）。门禁：**510 用例通过**（core **80** / plugin-client **233** / plugin **197**）、`typecheck`/`build` `EXIT 0`、`verify-host-import` **11/11**（脚本实测）、`probe-host` **5/5**、`verify-rpc-roundtrip` **37/37**。其中 `verify-rpc-roundtrip` 的 `CONTRACT_ENDPOINTS` 仍是 **11 端点**（切片 A 5 + B 3 + F03 3），**不包含 `conversation/create`/`conversation/link`**；37/37 不构成 F04 端点的真实 HTTP 覆盖，F04 的协议证据来自 host 侧测试与真实 GUI 后的 storage 检查。
>
> **已安装与真实 GUI**：F04 构建已于 2026-11-17 安装到真实 `desktop` profile（备份 `20261117-2`），安装物 client bundle **93702 B**、SHA256 `866C2A3062F8694CCE537C341A848A7E893B543A411772047AB303B6D7AC743A`；真实 GUI `http://127.0.0.1:13646`（activation `mwjef86q-1`，host pid `8168`）中，项目入口新建未关联空会话、任务入口分别新建两个空会话并写入归属，均未自动发送、无记录/成果。**但真实双击连点未执行，AT-09/AT-100 仍只记部分执行；其他 AT 待执行/待联合验收，不能写成 F04 已验收。**

## 1. 切片 A 范围与落地内容

### 1.1 本切片落地的三件事

1. **项目入口新建未关联对话**：项目区提供“新建对话（不关联任务）”。生产路径调用 host `conversation/create` 创建全新 blank session，成功后直接 `uiWorkspace.openSession(conversationId)` 打开；**不调用** `conversation/link`，不写任务归属。
2. **任务入口新建并固定归属**：任务详情提供“新建对话（固定归属当前任务）”。生产路径先 `conversation/create` 创建全新 blank session，再调用 host `conversation/link` 把该 `conversationId` 固定归属到当前 `taskId`，成功后 `openSession(conversationId)` 打开；不复制历史、不重复绑定、不弹二次确认。
3. **打开**：只打开本次创建的对话；不做对话列表、搜索、继续任意既有对话、改选目标或来源展示。

本切片只建立“可继续输入、且任务入口已固定归属”的工作对话入口；发送消息后的实际工作、背景准备、记录形成均不在本切片。

### 1.2 明确不在本切片

| 能力 | 归属 / 本切片处理 |
| --- | --- |
| 工作对话列表、搜索、按全部/未关联/已关联筛选 | F04 后续切片；当前不渲染列表 |
| 继续任意既有对话、快捷继续、改选目标 | F04 后续切片；当前只打开刚创建的对话 |
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
| F04-R01 项目内新建 | **代码/UI 已落地并安装**：host `conversation/create` 得到新 blank session，不产生任务绑定；真实 GUI 已观察项目入口创建未关联空会话。 |
| F04-R02 任务内新建与固定归属 | **代码/UI 已落地并安装**：created session 再 `conversation/link`；`linked`/`already-linked` 都算成功；真实 GUI 已用两个任务分别观察新建与归属；归档/删除拒绝尚未实现（§5.2）。 |
| F04-R03 创建流程与补偿 | **代码/UI 已落地并安装**：create/link/open 分步展示，按步骤重试；`requestId` 在 `conversation/create` 上必填并由 host 去重。真实双击连点未执行，仅单测覆盖。 |
| F04-R04 打开与背景职责 | **部分覆盖**：只打开、不自动发送、不改状态、不形成记录；背景同步留给 F11。 |
| F04-R05 列表和命名 | **不在本切片**：不渲染列表、不写标题。 |
| F04-R06 记录与新内容提示 | **不在本切片**：依赖 F06。 |
| F04-R07 来源不可用 | **不在本切片**：依赖 F17。 |

## 2. 规则的实际落点（F04-R01—R04）

### 2.1 F04-R01 项目内新建

- **入口**：`packages/plugin-client/src/board.tsx` 的项目区工具条，在“项目总览”按钮之后；无进行中的 entry 时按钮带 `data-aikanban-new-project-conversation="true"`，文案“新建对话（不关联任务）”。
- **动作**：`BoardController.newProjectConversation()` → `startConversation('project')`。每次入口生成新的 `requestId`（`mintOperationId()`），把 entry 置为 `connecting`，`connectConversationStep` 调 `source.createConversation({ projectId, requestId })`（host `conversation/create`）取得 `conversationId`；项目入口**直接进入 `opening`**，不调用 `conversation/link`。
- **打开**：`uiWorkspace.openSession(conversationId)`；成功后 `phase='opened'`、`step='open'`，显示“已打开未关联任务的工作对话。”
- **失败**：create 失败保留 entry（`phase='failed'`、`step='connect'`、`code`），显示“创建或复用对话失败，未打开任何会话。”；打开失败保留 `conversationId`，只重试打开。不生成列表行、不伪造对话 id。
- **真实 GUI 证据**：项目 `pluginInstall` 的项目入口新建 `session-4ad43a14-991c-4611-a879-6e4b08a074c1`（335 B 空会话），项目 `links.conversations` 仍为空。
- **边界**：project 入口不写任务归属；host 只创建会话，不接收任务归属。

### 2.2 F04-R02 任务内新建与固定归属

- **入口**：`board.tsx` 任务详情内，在 F03 概况区之后；无 entry 时按钮带 `data-aikanban-task-new-conversation="<taskId>"`，文案“新建对话（固定归属当前任务）”，旁边说明“该对话将固定归属当前任务，不复制此前历史”。
- **顺序**：
  1. `startConversation('task')` 取当前 `openTaskId` 与 `selectedProjectId`，生成 `requestId`，置 `connecting`；
  2. `source.createConversation({ projectId, requestId })`（host `conversation/create`）得到**全新** `conversationId`；
  3. 置 `linking`，调用 `source.linkConversation({ taskId, conversationId, requestId })` → host `conversation/link` → `core.linkConversation`；
  4. 成功值 `linkStatus:'linked'|'already-linked'` 均视为归属成立，置 `opening` 并 `uiWorkspace.openSession(conversationId)`。
- **为什么必须 host 创建**：`uiWorkspace.connectWorkspace(projectId)` 会复用任意 blank session，包括已经归属其他任务的会话；`5e88bab` 改为 host `conversation/create` 创建全新会话，避免任务入口复用已归属会话。`connectWorkspace` 现在只作为注入测试 source 的兼容回退，生产 source 走 `createConversation`。
- **归属成功条件**：只有 `linked`/`already-linked` 才显示“已创建并打开对话，并固定归属当前任务。”或“该对话此前已归属当前任务，已打开。”；归属未成功前不显示已归属。
- **拒绝**：会话已归属其他任务 → host `save-failed`，message 说明原归属不变；客户端保留该失败，不静默改绑、不重开第二条会话。
- **任务不存在/项目未登记** → `not-found`/`unknown-project`；不写归属。
- **归档/删除任务**：PRD 要求归档任务先恢复、已删除任务不能新建。当前 adapter **只做 `preReadTask` + 任务所属项目登记校验**，**归档/删除的拒绝尚未实现**（见 §5.2）；不能把归档/删除任务当作已支持。
- **真实 GUI 证据**：任务 `F04 对话入口测试`（`te817ad493b3fa430e8156eb2237ce317`）新建 `session-a4efa985-5154-448b-9016-d59ac12f447f`（336 B），linkedAt `2026-11-16T15:10:38.659Z`；任务 `F04 任务入口截图`（`t69c9a4ed47ded64869c5d356301c152f`）新建 `session-c19ce0db-2764-420f-88a7-b66dd3a291db`（336 B），linkedAt `2026-11-16T15:13:47.886Z`；两次均未复用已归属 t11 的 `session-ee3628ef-0a4c-438f-8561-f1f1ce839c5d`，UI 打开空会话输入区，无自动发送/记录/成果。

### 2.3 F04-R03 创建流程与补偿

实际状态机（`ConversationEntryState`，`model.ts`）：

```text
phase: connecting | linking | opening | opened | failed
step:  connect | link | open
fields: scopeKind, scopeId, taskId, conversationId, requestId, linkStatus, code, error
```

- **分步展示**：`connecting` → “正在创建或复用空白对话…”；`linking` → “对话已就绪，正在写入任务归属…”；`opening` → “归属已写入，正在打开对话…”；成功按 scope 显示不同文案；失败按 `step` 显示 headline 与“重试创建对话/重试归属/重试打开”。
- **连点/重复入口**：`startConversation` 在当前 scope 已有 entry 时直接忽略（无论进行中还是已打开）；controller 测试覆盖“双击只 connect 一次”。**真实 GUI 的连点未执行**，不能以单测替代档 1。
- **重试只补失败步骤**：`retryConversation(scopeKind)` 按 `step` 分派：connect 失败重新 create；link 失败复用同一 `conversationId` 且**不重新 create**；open 失败复用同一 id 且只重新打开。
- **requestId**：`conversation/create` 的 `CreateConversationPayload` 上 **必填**，host 按 `requestId` 记住已创建会话（同一请求重试返回同一 `conversationId`）；`conversation/link` 的 `requestId` 在 wire 上可选，任务入口 controller 每次入口生成并发送，用于重试/诊断。host 的 link 幂等以 `conversationId` 为准。
- **create 成功、link 失败**：失败结果只有 `code`/`message`，客户端自己保存 `conversationId`/`taskId`（不依赖 wire details），只重试 link，不另建会话、不显示已归属。
- **link 结果未知**：客户端归为 `unknown-result`，显示“归属结果需核对”；重试同一 `conversationId`；host 返回 `already-linked` 时按成功处理。
- **打开失败**：保留 `conversationId` 与 `step='open'`，只重试打开；不重新 create/link，不自动发送消息。
- **收起/切换**：`dismissConversation` 只在 settled（非 connecting/linking/opening）时清空 entry 并递增 seq；切换项目或关闭任务详情会重置对应 entry。`conversationStillCurrent` 用 seq 与当前 scope 丢弃迟到响应，避免旧项目的 create/link 结果写进新上下文。
- **取消/离开**：若 create/link 已成功而用户没有继续打开，entry 仍保留已准备的 `conversationId`；不会假称未发生，也不会自动重发。

### 2.4 F04-R04 打开与背景职责

- 打开仅调用 `uiWorkspace.openSession(conversationId)`；controller 不调用 `prompt`、不发送继续指令、不改任务状态、不形成记录、不自行开始工作。
- 打开失败保留 `conversationId` 与失败原因，提供重试；不会重新 create/link，也不会把失败显示成“未准备”。
- 背景准备、发送同步属于 F11；本切片不显示“背景已使用”，不把“已关联”当作“已准备”。
- **真实 GUI 观察**：任务入口打开后显示空会话输入区，未自动发送；项目/任务入口均未生成记录或成果。发送后的运行状态属于宿主/F11，本切片未验证。

## 3. 契约落地

### 3.1 core：复用既有 `linkConversation`，不改 core

F04 没有修改 `packages/core`。归属复用既有：

- `KanbanCore.linkConversation({ taskId, conversationId, at? })`：只写任务 scope 的 conversations 链接与时间；返回 `linked`、`already-linked` 或 `rejected`（`unknown-scope`、`rebind-forbidden`、`invalid-input`）。
- `LinkOutcome` 还包含供 `linkOutcomeTask` 使用的 `linked-outcome`/`already-linked-outcome`；`linkConversation` 本身只返回前三种结果。
- 不创建会话、不创建任务、不改任务标题/目标/状态、不产生记录；会话创建走宿主 `sessionController`，不进入 core。
- 本切片**不新增 core API**；core 的既有拒绝语义（尤其 `rebind-forbidden` 保留原归属）在适配层只做 code 映射，不改变。

### 3.2 wire：`conversation/create` 与 `conversation/link`

- **端点**：`BOARD_ENDPOINTS` 共 **13 个**，新增：
  - `conversationCreate = 'conversation/create'`（`wire.ts:159`）
  - `conversationLink = 'conversation/link'`（`wire.ts:170`）
- **失败码**：仍为既有 **9 码**（`invalid-reason`、`invalid-input`、`not-found`、`save-failed`、`stale-baseline`、`unknown-result`、`read-failed`、`unknown-project`、`unavailable`），不新增浏览器可见失败码；host-only `invalid-payload` 不发给浏览器。
- **`conversation/create` 请求**（`CreateConversationPayload`，`:306-309`）：

  ```text
  {
    projectId: string,   // 非空；会话在该项目的 workspace 中创建
    requestId: string    // 必填；host 用它识别重复创建
  }
  ```

- **`conversation/create` 成功值**（`CreateConversationValue`，`:606-608`）：

  ```text
  { conversationId: string }
  ```

- **`conversation/create` 失败映射**：缺字段/空值 → `invalid-input`；项目未登记/无法解析 → `unknown-project`；host `sessionController` 未绑定 → `unavailable`；创建异常/空 id → `unknown-result`（提示先核对，不要直接重复创建）。**不写任务归属**；项目入口与任务入口都先走它。
- **`conversation/link` 请求**（`LinkConversationPayload`，`:281-286`）：

  ```text
  {
    taskId: string,          // 非空
    conversationId: string,  // 非空；本次 create 得到的会话
    requestId?: string       // 可选；任务入口 controller 每次生成并发送
  }
  ```

- **`conversation/link` 成功值**（`LinkConversationValue`，`:571-575`）：

  ```text
  {
    taskId: string,
    conversationId: string,
    linkStatus: 'linked' | 'already-linked'
  }
  ```

  `already-linked` 表示同一 `conversationId` 已归属同一 `taskId`，是成功，不重复写。
- **失败值**：两个端点都只有 `{ ok:false, code, message }`，**没有结构化 `details`**；客户端自己保存 `conversationId`/`taskId` 用于重试，不依赖 wire 回传。
- **`conversation/link` 失败映射**（实际 host adapter）：缺字段/空值 → `invalid-input`；任务不存在 → `not-found`；所属项目未登记 → `unknown-project`；会话已归属其他任务 → `save-failed`（message 说明原归属不变，**保留原归属**）；写入失败 → `save-failed`；结果未知 → `unknown-result`；host 能力未就绪 → `unavailable`。
- **解析器**：`parseCreateConversationPayload`/`parseCreateConversationValue`、`parseLinkConversationPayload`/`parseLinkConversationValue`（`wire.ts`）先校验再进适配器；payload 解析失败在 host handler 返回 host-only `invalid-payload`。
- **自动覆盖限制**：`tools/verify-rpc-roundtrip.mjs` 仍是 11 端点契约，不含 `conversation/create`/`conversation/link`；不要写“roundtrip 覆盖 F04”。

### 3.3 host：`sessionController.create` + `conversation/link`

- **创建会话**（`board-adapter.ts` 的 `createConversation`，`:1465`）：
  - `deps.sessionController?.()` 未绑定 → `unavailable`（“会话创建不可用：宿主的 sessionController 服务未绑定；未创建任何会话。”）；
  - 按 `requestId` 查 `createdConversations`，命中直接返回已有 `conversationId`（重复创建保护）；
  - 先 `resolveProject(projectId)` 解析/登记项目；`sessionController.create({ workspaceId: projectId })` **不传 `sessionId`**，由宿主创建全新 session；
  - 异常 → `unknown-result`；返回空 id → `unknown-result`；成功后记录 `requestId → conversationId` 并返回 `{ ok:true, conversationId }`。
  - `packages/plugin/src/index.ts` 的 `HostBoardAdapterDeps` 增 `sessionController: () => serviceOf<SessionControllerLike>(ctx, 'sessionController')`（`:596`），仍用 reflect 非抛错；`inject` 导出数组仍为空。
- **归属**（`linkConversation`，`:1519`）：`workspaceRegistry()`/`deps.core()` 检查 → `preReadTask`（不存在 `not-found`、读异常 `save-failed`）→ 项目登记检查 → `core.linkConversation`；映射见 §3.2。
- **channel**（`board-channel.ts`）：`HostCreateConversationInput/Success/Failure/Outcome`、`HostLinkConversation*`；`HostBoardPort.createConversation`/`linkConversation`；两个 handler 均 parse → 校验 → port → 映射失败，未捕获异常 → `unknown-result`。
- **delayed-board-port.ts**：host 未就绪时两个方法返回 `unavailable`，coreReady 后委托真实 port。
- **已知缺口**：adapter 只校验任务存在与所属项目登记，**归档/删除任务的拒绝尚未实现**；不能把归档/删除任务当作可用。

### 3.4 client：create → link（任务）→ open

- **transport**（`source.ts` / `channel-source.ts`）：
  - `CreateConversationInput { projectId, requestId }`、`CreateConversationSuccess/Failure/Result`；`BoardSource.createConversation`；无通道返回 `unavailable`，文案“看板数据通道未接通：无法创建对话，未创建任何会话。”；
  - `channel-source.ts` 本地校验 projectId/requestId 非空 → `invalid-input`，`call(BOARD_ENDPOINTS.conversationCreate, payload)`；抛错 → `unknown-result`，未知失败码归一为 `save-failed`，成功值解析失败 → `unknown-result`；
  - `LinkConversationInput/Success/Failure/Result`、`BoardSource.linkConversation`；失败值无 details；无通道返回 `unavailable`，文案“看板数据通道未接通：无法写入任务归属，会话本身未被创建或修改。”
- **controller**（`controller.ts`）：
  - `WorkspacePort { connectWorkspace(projectId): Promise<string>; openSession(conversationId): void }`；`isAvailable?()`；
  - `newProjectConversation()`、`newTaskConversation()`、`retryConversation(scopeKind)`、`dismissConversation(scopeKind)`；
  - `connectConversationStep`（`:1694-1768`）先检查 workspace 可用；生产 source 有 `createConversation` 时调用 host `conversation/create`，取新 `conversationId`；否则（测试注入 source）回退 `workspace.connectWorkspace(projectId)` 兼容；
  - 项目入口 create 后直接 opening/open（不 link）；任务入口 create 后 linking/link，成功保存 `linkStatus` 再 open；
  - `startConversation` 每 scope 一个 entry，已有 entry 直接忽略（连点保护，仅单测覆盖）；`requestId=mintOperationId()` 每次入口生成；重试按 step 只补失败步骤，link/open 复用同一 `conversationId`；
  - seq + scope 校验丢弃切换项目/关闭详情后的迟到响应；`dismiss` 仅 settled 可用。
- **runtime / index**（`runtime.ts` / `index.tsx`）：
  - runtime 使用 late-bound resolver，每次使用重新探测 `uiWorkspace`；`createLazyWorkspacePort()` 的 `connectWorkspace`/`openSession` 在调用时解析；`isAvailable()` 反映当前是否可用；
  - `index.tsx` 的 `probeWorkspace(ctx)` 每次入口调用，顺序 `ctx.reflect?.get('uiWorkspace', false) ?? ctx.get?.('uiWorkspace')`（`fee1c32` 后延迟绑定也在使用时解析），可用时 `setWorkspaceResolver(...)`，不可用时记录“uiWorkspace probe deferred: conversation entry resolves on use”，入口点击后以 `unavailable` 解释，不伪造对话；
  - 打开仍依赖 `uiWorkspace.openSession`；`connectWorkspace` 只作为无 host create 的测试兼容路径。
- **UI**（`board.tsx` / `model.ts`）：
  - 项目区按钮 `data-aikanban-new-project-conversation="true"`；任务详情按钮 `data-aikanban-task-new-conversation="<taskId>"`；
  - 有 entry 时渲染 `renderConversationArea`，数据属性 `data-aikanban-conversation`、`-phase`、`-status`、`-error`、`-retry`、`-progress`、`-id`、`-dismiss`；
  - `DETAIL_PLACEHOLDERS` 中 F04 的“任务对话”占位已被真实入口取代；
  - 文案与状态见 §2.3 与 `model.ts` 的 `conversation*` 辅助函数；失败不会显示“已关联/已准备背景”。

## 4. 测试、门禁与安装

### 4.1 覆盖的测试

- `packages/plugin-client/test/controller.test.ts`：F04 相关条目覆盖项目入口不写归属、任务入口 link 后打开、双击只 create 一次、create 失败只重试 create、link 失败保留 id 且只重试 link、open 失败只重试 open、`already-linked` 成功、无 workspace 时失败且不 link、切换项目丢弃迟到 create、关闭详情丢弃迟到 create、忙碌时拒绝收起。
- `packages/plugin-client/test/wire.test.ts`：`conversation/create`、`conversation/link` 的 payload/value 解析、失败值只有 code/message、无 details。
- `packages/plugin/test/channel-roundtrip.test.ts`：创建/归属 handler 往返（真实 bundle）、重复归属 `already-linked`、他任务归属 `save-failed` 且保留原主、畸形 payload、畸形成功值、空 id 本地拒绝等。
- `packages/plugin/test/board-adapter.test.ts`：create（sessionController 未绑定、requestId 去重、空 id、异常）、link（`linked`、`already-linked`、他任务保留原归属、pre-read 抛错、core 抛错）等。
- 这些测试证明代码/契约层行为；**不证明真实 GUI 连点、`uiWorkspace` 全部语义或产品验收**。

### 4.2 门禁（2026-11-17 @ `5e88bab`）

| 门禁 | 结果 | 备注 |
| --- | --- | --- |
| 全量测试 | **510 passed**（core 80 / plugin-client 233 / plugin 197） | 含 F04 create/link 与 controller/wire/channel/adapter 用例 |
| `typecheck` | `EXIT 0` | |
| `build` | `EXIT 0` | client bundle 93702 B |
| `verify-host-import` | 11/11 | 脚本当前 11 项检查全部 PASS；既有 12/12 口径与实测不符 |
| `probe-host` | 5/5 | |
| `verify-rpc-roundtrip` | 37/37 | **仍是 11 端点契约，不含 `conversation/create`/`conversation/link`；不覆盖 F04** |
| `check_docs` | PASS（65 Markdown） | 文档完整性检查，不代表产品验收 |

### 4.3 安装与真实 GUI（2026-11-17）

- 已安装到真实 `desktop` profile（备份 `20261117-2`）；安装物 client bundle **93702 B**、SHA256 `866C2A3062F8694CCE537C341A848A7E893B543A411772047AB303B6D7AC743A`。
- 真实 GUI `http://127.0.0.1:13646`，activation `mwjef86q-1`，host pid `8168`，主窗口 handle `854728`。
- 已观察：项目入口新建 `session-4ad43a14-991c-4611-a879-6e4b08a074c1`（335 B，未关联）；任务入口新建 `session-a4efa985-5154-448b-9016-d59ac12f447f`（336 B，linkedAt `2026-11-16T15:10:38.659Z`）与 `session-c19ce0db-2764-420f-88a7-b66dd3a291db`（336 B，linkedAt `2026-11-16T15:13:47.886Z`）；UI 打开空会话输入区，无自动发送、无记录/成果。截图与状态见 `docs/evidence/2026-11-17-f04/`，逐条记录见 [verification.md](verification.md)。
- **未执行真实双击连点**；AT-09/AT-100 因此只记部分执行，其余 AT 待执行/待联合验收。

## 5. 仍未验证与已知限制

### 5.1 未验证（不得写成通过）

- **真实双击连点未执行**（仅单测覆盖连点保护），AT-09、AT-100 只能部分执行；AT-10、AT-11、AT-12、AT-15、AT-20、AT-36、AT-57、AT-92—94、AT-101 仍待执行或待联合验收。
- 发送消息后的实际工作、运行状态、消息输入、背景准备属于宿主/F11；本切片未验证。
- 任务归档/删除的拒绝未实现（见 §5.2）。
- `uiWorkspace.openSession` 的打开是否触发执行/挂到项目工作区、late-bound 行为在真实 shell 中是否始终成立，未有独立证据；本切片只观察到打开空会话输入区。

### 5.2 已知限制与风险

- **归档/删除任务**：PRD 要求归档任务先恢复、已删除任务不能新建。当前 adapter 只校验任务存在与项目登记，没有归档/删除校验；在补齐前不能把这两类任务当作可用。
- **真实 HTTP 覆盖**：`verify-rpc-roundtrip` 不含 `conversation/create`/`conversation/link`；只有 host 侧测试与真实 GUI 后的 storage 检查，不能写“13 端点已真实 HTTP 覆盖”。
- **创建幂等只在 host 进程内**：`createdConversations` 以 `requestId` 记住本次创建，进程重启后不保留；客户端不得靠重试 `requestId` 跨重启复用会话，需以实际会话列表核对。
- **标题/列表/搜索/继续既有对话/F11/F06/F13/F17** 均不在本切片；不要从 F04 代码推导这些能力。
- **F04 的 13 端点不是 `verify-rpc-roundtrip` 的 11 端点**：工具待扩展；在此之前 F04 的协议证据只到 host 侧测试与 GUI storage 观察。

## 6. 依据与链接

- 需求与验收行：[F04 PRD](prd.md) §1—§7；逐条验收记录：[verification.md](verification.md)。
- 真实 GUI 证据：`docs/evidence/2026-11-17-f04/f04-project-entry.png`、`f04-task-entry.png`、`f04-state.txt`；storage `%USERPROFILE%\.dsh\storages\aikanban_core.json`。
- 宿主能力与工作区映射：[宿主能力合同](../../../engineering/host-capabilities.md) HOST-02（`sessionController.create` 与工作区）、HOST-03（消息投递边界）、HOST-08（AI 不可用信号）；[架构准备](../../../engineering/architecture.md) 的“项目 = workspace”约定。
- 现有接线规格与 F04 接线记录：[S1 接线规格](../../../engineering/s1-wiring.md) §0/§11；[S1 接线实施记录](../../../engineering/s1-wiring-implementation.md) §22。
- core 固定归属契约：[类型定义](../../../../packages/core/src/types.ts) `LinkOutcome` 与 `linkConversation`；[core 实现](../../../../packages/core/src/core.ts) 的 `linkConversation`。
- 客户端实现：[wire.ts](../../../../packages/plugin-client/src/wire.ts) `conversation/create`/`conversation/link` 类型与解析器；[source.ts](../../../../packages/plugin-client/src/source.ts)；[channel-source.ts](../../../../packages/plugin-client/src/channel-source.ts)；[controller.ts](../../../../packages/plugin-client/src/controller.ts)；[runtime.ts](../../../../packages/plugin-client/src/runtime.ts)；[index.tsx](../../../../packages/plugin-client/src/index.tsx)；[model.ts](../../../../packages/plugin-client/src/model.ts)；[board.tsx](../../../../packages/plugin-client/src/board.tsx)。
- host 实现：[board-channel.ts](../../../../packages/plugin/src/board-channel.ts) 两个 handler；[board-adapter.ts](../../../../packages/plugin/src/board-adapter.ts) `createConversation`/`linkConversation`；[delayed-board-port.ts](../../../../packages/plugin/src/delayed-board-port.ts)；[index.ts](../../../../packages/plugin/src/index.ts) `sessionController` accessor。
- 交付状态与接线状态由[交付状态](../../../delivery/status.md)和 [S1 接线规格](../../../engineering/s1-wiring.md)维护；本文只记录实现、门禁与入口证据，不维护功能级状态。
- 参考实现记录格式：[F03 implementation](../F03-manual-summaries/implementation.md)；F03 的已安装/验收结论不能借用为 F04 证据。
