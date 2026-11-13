# F03 implementation（实现记录：2026-11-13）

> **性质**：本文是 F03「手动维护任务概况与项目总览」在 S1 的**实现记录**，不是验收记录。它记录实际提交的契约、落点、门禁与仍未验证项；任何 AT 结论以未来 `verification.md` 的真实证据为准。
>
> **证据边界（2026-11-13，HEAD `58c7c69`）**：F03 的代码与门禁层已实现，提交为 `79e0fa2`（core/wire/host）、`973ee67`（client UI）与 `58c7c69`（R02 即时刷新修复），全量测试 462 passed（core 80 / plugin-client 205 / plugin 177），`typecheck`/`build` `EXIT 0`，`verify-host-import` 12/12，`probe-host` 5/5；`verify-rpc-roundtrip` 28/28 但**只覆盖 8 端点/9 码，不覆盖 F03**。F03 **已于 2026-11-13 安装到真实 `desktop` profile 并因 F03 重启三次**；真实 GUI 已执行 AT-26（任务概况保存/版本/重启保留，通过）与 AT-44（项目总览保存/版本/重启保留，部分执行）；R02 保存后卡片/详情不即时刷新的缺陷已修复并复验；AT-49、AT-26 联合、AT-27/29/45/67 仍待执行/待联合验收。逐条结论见 [verification.md](verification.md)，[交付状态](../../../delivery/status.md)记 F03「进行中 / 部分执行」。F01/F02 仍为部分执行，本文不借用其未执行 AT 作为 F03 结论。
>
> **与计划初稿的关系**：本文在 2026-11-13 早先有一版设计/实施计划初稿；现按实际提交改写为实现记录。主要差异是：UI 没有采用计划中的「进展/决策/问题/下一步」多段表单，而是使用**单 section 文本**（`id: 'manual'`，标题「任务概况」/「项目总览」）；wire 端点、结果形状与 client 状态以实际代码为准，见 §2.1。

## 1. 实现范围与边界

### 1.1 本切片实际交付

- 任务详情内新增「任务概况」区：无正式内容时显示空态与「编辑概况」，可读取、编辑、预览、保存；项目区新增「项目总览」入口，交互相同。
- 正式内容保存为**不可覆盖的新版本**：版本条目带 `origin: 'user'`、`source.generator: 'manual'`、`previousVersionId`、`changeKind`（created/modified/cleared）、`confirmedAt`；不原地覆盖历史。
- 保存前有**预览**：按行展示旧正式正文与新正文的差异（same/removed/added），并显示版本标签与元数据。
- 手动草稿使用 core 既有草稿槽：任务概况 `summaryDraft`、项目总览 `overviewDraft`，`objectId` 为 scope id；草稿保存不产生正式版本。
- 读取返回 `SummaryView`：当前正式版本、历史（新到旧）、活动手动草稿、SAVE-05 基线、待核对状态；版本历史只显示元数据，不展开正文。
- 全部本地可用：不依赖 AI、对话或已完成任务；不产生记录、来源对话或成果。

### 1.2 不在本切片

| 能力 | 归属/状态 |
| --- | --- |
| 四类内容的完整历史查看、正文展开与恢复 | F10；S1 只保存不可覆盖版本并展示元数据 |
| 任务记录生成、成对确认与来源对话链接 | F06；F03 不产生记录、不创建链接 |
| 项目成果生成与成果索引更新 | F13；总览中的成果描述仍是手动文本 |
| 来源结论的否定/替代/适用范围修正 | F09；S1 只编辑概况正文，保留既有结论字段 |
| 待处理更新的集中展示 | F15；F03 只提供本 scope 的手动草稿 |
| 离线/故障注入联合验收 | F18（AT-49 联合） |

### 1.3 与 F01/F02 的边界

- 任务标题、目标、状态、阻塞原因、列内顺序仍只由 F01/F02 的既有入口改变；`saveManualSummary` 只移动 scope head 的汇总成员，不写任务字段（F03-R03）。
- 卡片/详情消费**正式**概况，不消费草稿；手动保存成功后，client 用响应中的 `view` 更新编辑器，并立即把任务概况首行回写到当前 `read` 的任务卡与详情顶部（项目总览不触碰卡片）；不再依赖下一次 `board/read` 或切换项目。
- 任务目标实质变化后的「概况待核对」由 core 的 recheck 机制返回，S1 只展示，不改写正文。

## 2. 规则落点（F03-R01—R07）

### 2.1 与计划初稿的差异

| 计划初稿 | 实际实现 |
| --- | --- |
| 任务概况四段表单（进展/决策/问题/下一步）、总览多段（目标/约定/约束/风险/成果索引） | 单 section：`id: 'manual'`，`title` 为「任务概况」或「项目总览」，`body` 为一个 textarea 文本 |
| `summary/save` 返回 `{ok, status, summary}` | 返回 `{outcome: 'committed'|'already-applied'|'no-change', …, view: SummaryViewValue|null}`；`view: null` 表示写已落地但重读失败，只允许重读 |
| `summary/read` 对无概况返回成功 + `current: null` | 同左；但对**已知 scope**，host 不会把整个 `summary` 置为 `null`；`current: null` 才表示「尚未保存过正式概况」 |
| client 编辑器状态 `idle/loading/editing/preview/...` 多值联合 | `SummaryEditorStatus = 'loading'|'ready'|'failed'|'saving'` + `editing`/`previewing`/`draftStatus` 等布尔/子状态 |

### 2.2 F03-R01 独立初始化

- core `readSummary({scopeKind, scopeId})` 只读：scope 不存在返回 `null`；scope 存在但没有正式概况时返回**非 null 视图**，其中 `current: null`，`baseline` 仍带 `{revision, applicabilityRevision, summaryVersionId: null}`。
- 任务概况存 `taskSummary` 链，项目总览存 `projectOverview` 链，`objectId` 均为 scope id；项目总览不要求先有已完成任务，也不产生成果。
- 保存不要求 `recordObjectId`、不要求对话/成果链接；版本 `origin: 'user'`，`source` 为 `{generator: 'manual', taskId}` 或 `{generator: 'manual', projectId}`，不写 `conversationId`。
- UI 空态：`summaryEmptyText` 显示「暂无任务概况」/「暂无项目总览」；正式内容为空时显示「暂无正式概况」，不预置示例段。
- 读取失败与「没有概况」严格区分：读失败显示「概况读取失败，未显示任何内容。」并给「重新读取概况」，不渲染成空态。

### 2.3 F03-R02 人工编辑和正式保存

- 编辑器只在已成功读取且拿到基线时开放；无基线时提示「无法编辑：概况缺少基线，请重新读取后再试。」，绝不凭空造基线。
- 编辑对象是单段文本；保存内容由 `summaryContentForSave` 构造为单个 `manual` section，正文原样保留（空文本合法）。
- 既有正式结论不因正文编辑被静默丢弃：`summaryConclusionsOf(view)` 取自当前正式版本（没有正式版本时取草稿的结论），随保存内容带回；S1 不提供结论片段的编辑 UI。
- 预览：`summaryPreviewRows` 对旧正式正文与当前 textarea 文本做行级 diff（`same`/`removed`/`added`），显示「预览修改：旧正式内容 vs 新内容」；无差异时显示「新内容与旧正式内容一致。」。
- 确认保存：一次只发一个 `summary/save`；`updateId` 在打开编辑器时铸造，重试复用（`summaryEditorState.updateId`），连点/两窗口提交按幂等处理。请求携带 `expected` 三元组（`revision` / `applicabilityRevision` / `summaryVersionId`）。
- core 实质保存：追加一个版本条目（`changeKind` 由 `planMember` 判定，`previousVersionId` 指向前一版本，`revision + 1`），并在**同一次** scope-head 写入中追加 `summary-saved` 活动条目；无实质变化（或空内容对空正式内容）返回 `no-change`，不制造版本。
- 保存成功才更新视图；保存失败时保留编辑器与输入，正式视图不变；成功响应中的 `view` 直接刷新编辑器，并由 `applyTaskSummaryProgress` 立即回写当前任务卡的 `summaryProgress`、`hasSummary` 与详情顶部；项目总览不触碰卡片。R02 缺陷已由 `58c7c69` 修复。

### 2.4 F03-R03 来源与控制边界

- `saveManualSummary` 在**一次** `port.update` 内完成决策与写入，只更新 `current` / `chains` 的汇总成员，并追加活动；任务字段、状态、排序、记录正文、对话运行状态均不被触碰。
- 来源字段只由 core 写 `generator: 'manual'` 与 scope id；wire 的 `content` 不携带来源字段，host 也不接受客户端指定来源，避免冒充 AI 原稿或伪造对话。
- 目标实质变化后的待核对：`SummaryView.needsRecheck` 与 `recheck` 来自 core 的 `computeRecheck`；UI 显示「概况待核对：请核对概况适用范围。」，不自动改写正文、不自动确认。

### 2.5 F03-R04 后续更新保留人工修正

- 基线三元组包含 `applicabilityRevision`；`saveManualSummary` 在幂等检查之后核对 expected 与当前 head。不一致返回 `blocked` / `baseline-changed`，附 `expected` 与 `actual`，**不写入**。
- host 把该结果映射为 `stale-baseline`，失败详情携带 `baseline: {expected, actual}`；client 显示「概况已被其他操作更新，本次未保存；请核对最新内容后再提交。」并提示期望/实际 revision，保留用户输入。
- 显式重读时若编辑器正在编辑，`loadSummaryFor` 保留已输入文本，只把基线移动到新视图，并提示「已重新读取概况基线，未保存的输入已保留。」（F03-R04 的 stale-view 路径）。
- 正式版本历史不可变；AI/记录路径的合并算法不在 S1，F03 只提供版本与基线。

### 2.6 F03-R05 结论修正和摘要删减

- 编辑范围仅是概况正文（单 section 文本）；S1 **不提供**来源结论片段的编辑、否定、替代或适用范围调整。
- 保存时保留当前正式结论字段（见 §2.3）；删正文中的一句话只改变正文，不会自动否定来源结论。涉及来源结论的完整修正（片段关联、适用范围、修正说明、同次预览一致生效）属于 F09，未在本次实现。
- 无来源片段时 S1 不制造 `conclusions`；来源片段出现后，相关修正必须接入 F09 后才能开放。

### 2.7 F03-R06 总览与概况内容边界

- 概况/总览的正文内容规则（汇总整项任务的有效成果、总览精简、保留风险与约束、成果描述带截止范围、不跨项目共享、不替代正式文档、不自动改代码）仍是产品内容要求；S1 的实现只是单段手动文本，不自动生成、不自动改写、不自动改状态。
- 项目总览与任务概况共用同一套单 section 编辑与版本机制，区别仅是 section 标题与 scope 类型；总览中的成果描述是用户手动写入的文本，不产生 F13 成果对象。

### 2.8 F03-R07 独立草稿和重复操作

- 草稿复用 core 既有方法（`saveDraft` / `getDraft` / `listDrafts` / `setDraftState` / `abandonDraft` / `deleteDraft` / `draftIdFor`），**未新增 core 草稿方法**。
- 任务概况草稿 `kind: 'summaryDraft'`，项目总览草稿 `kind: 'overviewDraft'`，`objectId` 为 scope id；`base` 由 `saveDraft` 记录 scope revision / applicability revision / 版本基线。
- 草稿独立于记录成对草稿（`taskRecord`/`projectRecord`），互不覆盖；`readSummary` 只返回本 scope 的候选手动草稿（`summaryDraft`/`overviewDraft`，`CANDIDATE_STATES`，按 `updatedAt` 新到旧）。
- 幂等优先：`saveManualSummary` 在 `port.update` 内先按 `updateId` 查汇总链，命中即返回 `already-applied`（带 `appliedRevision`/`appliedAt`/`versionId`），即使本次内容不同也不产生第二个版本。
- 草稿消费只在提交**durable 之后**进行：匹配 kind/scope/候选状态且 `updateId` 相同（或显式 `consumeDraftIds`）；消费失败不回滚版本，只返回 `draftUpdateFailures`。`blocked`/`rejected`/`no-change`/`already-applied` 不消费草稿。
- 残余：当前 UI 只有显式「保存草稿」按钮，输入不会自动 debounce 保存；关闭编辑器会丢弃未保存到草稿的内存输入；没有 `summary/draft.discard` 端点或「放弃草稿」按钮；这些不改变已保存的正式内容，见 §6。

## 3. core 实现

### 3.1 类型（`packages/core/src/types.ts`）

- `SummaryBaseline`（`:1020-1024`）：`revision`、`applicabilityRevision`、`summaryVersionId: string | null`；`summaryVersionId: null` 是「尚无正式概况」的合法基线。
- `SummaryVersionView extends ObjectView`（`:1033-1035`）：额外带 `changeKind`，供编辑器显示「修改结果」。
- `SummaryView`（`:1038-1053`）：`scopeKind`、`scopeId`、`revision`、`applicabilityRevision`、`baseline`、`current: SummaryVersionView | null`、`history`（新到旧）、`draft: DraftRecord | null`、`needsRecheck`、`recheck`。
- `ManualSummaryInput`（`:1063-1076`）：`scopeKind`、`scopeId`、`updateId`、`expected`、`content?`、`cleared?`（与 `content` 恰好一个）、`consumeDraftIds?`、`confirmedAt?`。
- `ManualSummaryOutcome`（`:1079-1115`）五态：`committed`（revision/applicabilityRevision/versionId/changeKind/consumedDraftIds/draftUpdateFailures/needsRecheck）、`already-applied`（appliedRevision/appliedAt/versionId/consumedDraftIds）、`no-change`（revision/summaryVersionId）、`blocked`（`baseline-changed` + expected/actual）、`rejected`（`unknown-scope` | `invalid-input`）。
- `ActivityCode`（`:230`）新增 `'summary-saved'`。

### 3.2 `KanbanCore` 方法（`types.ts:1221-1238`）

- `readSummary({scopeKind, scopeId}): SummaryView | null`：只读；不注册项目、不创建空概况、不写数据；scope 不存在返回 `null`，存在但无正式概况返回视图且 `current: null`。
- `saveManualSummary(input): Promise<ManualSummaryOutcome>`：独立于 `confirmPaired`，无 `recordObjectId`、无 conversation/outcome 链接校验；`updateId` 幂等；SAVE-05/F03-R04 基线校验；一次 scope-head `put`；不碰任务字段；实质保存同次追加版本与一条 `summary-saved`。

### 3.3 实现路径（`packages/core/src/core.ts`）

- `manualDraftKindOf`（`:707`）：task → `summaryDraft`，project → `overviewDraft`。
- `summaryBaselineOf`（`:709-716`）、`summaryVersionOf`（`:718-721`）、`activeManualDraftOf`（`:723-739`）、`summaryViewOf`（`:741-761`）：只读视图；`current: null` 时仍返回 baseline 和空 history。
- `saveManualSummary`（`:772-954`）：
  1. 入口校验：scope 存在；`updateId` 非空；`content` 与 `cleared` 恰好一个；`sections` 必须是数组；`conclusions` 若给出必须是数组（`:777-796`）。
  2. 一次 `port.update`（`:805`）：先按 `updateId` 查链 → `already-applied`（`:812-835`）；再核对 expected 三元组 → `blocked`/`baseline-changed`（`:837-845`）。
  3. `planMember('summary', …)`（`:847-856`）：无实质变化/仅文案变化，或空内容对空正式内容 → `no-change`（`:857-864`）。
  4. 实质变化：写版本条目（`origin:'user'`、`source:{generator:'manual',taskId|projectId}`、`changeKind`、`previousVersionId`、`revision+1`）（`:866-893`），一次写 next scope head（`:894-902`），同次 `appendActivity({code:'summary-saved', summary:'已保存手动任务概况/项目总览（第 N 次提交）', details:{...}})`（`:903-914`）。
  5. 提交 durable 后消费草稿（`:934-953`），失败只回 `draftUpdateFailures`。
- `confirmPaired`（`:956`）与 `runConfirm`（`:958` 起）仍是 F06 的成对确认路径；固定归属校验在其内部（`:967` 之后），手动概况不经过该路径，也不伪造链接。

### 3.4 为什么不是 `confirmPaired`

`confirmPaired` 的 task 分支要求 `scope.links.conversations[recordObjectId]?.taskId === scopeId`，project 分支要求 `scope.links.outcomeTasks[recordObjectId]?.projectId === scopeId`；手动概况没有 `recordObjectId`，若走该路径只能伪造链接（违反 F03-R01/R03）或必然被拒。它还会同时写记录成员、评估 AI 输入并追加成对活动，均不适用于纯手动概况。实际实现使用独立的 `saveManualSummary` 单成员路径。

## 4. wire 实现（`packages/plugin-client/src/wire.ts`）

### 4.1 端点

`BOARD_ENDPOINTS` 由 8 个增至 **11 个**，失败码仍为 **9 个**（未新增）：

| 常量 | 端点 | 方向 | 负载 → 值 |
| --- | --- | --- | --- |
| `summaryRead` | `summary/read`（`:136`） | 读 | `{scopeKind, scopeId}` → `{summary: SummaryViewValue \| null}` |
| `summarySave` | `summary/save`（`:143`） | 写 | `{scopeKind, scopeId, updateId, expectedRevision, expectedApplicabilityRevision, expectedSummaryVersionId, content?, cleared?, confirmedAt?, consumeDraftIds?}` → `SummarySaveValue` |
| `summaryDraftSave` | `summary/draft.save`（`:149`） | 写 | `{scopeKind, scopeId, content, updateId?, at?}` → `{draft: SummaryDraftValue}` |

### 4.2 值形状

- `SummaryViewValue`（`:686-696`）：`scopeKind`、`scopeId`、`revision`、`applicabilityRevision`、`baseline`、`current`、`history`、`draft`、`needsRecheck`、`recheck`。
- `SummaryVersionValue`（`:634-647`）：版本元数据、正文/结论、`origin`、`changeKind` 等；`SummaryDraftValue`（`:649-657`）、`SummaryDraftSaveValue`（`:660-661`）。
- `SummarySaveValue`（`:711-738`）：三种已知结果都带 `outcome`，并带 `view: SummaryViewValue | null`；`view: null` 仅表示**写已落地但保存后的权威重读失败**，不是「没保存」。
- `SummarySaveFailureDetails`（`:741-744`）：`baseline?: {expected, actual}`，用于 `stale-baseline`。
- 解析器位于 `wire.ts:1488-1899`（`parseSummaryReadPayload` / `parseSummarySavePayload` / `parseSummaryDraftSavePayload` / `parseSummaryReadValue` / `parseSummarySaveValue` / `parseSummarySaveFailureDetails` 等）。

### 4.3 失败码映射（复用 9 码）

| 结果 | wire 码 |
| --- | --- |
| `blocked` / `baseline-changed` | `stale-baseline`（带 expected/actual 基线） |
| `rejected` / `unknown-scope`（task） | `not-found` |
| `rejected` / `unknown-scope`（project） | `unknown-project` |
| `rejected` / `invalid-input` | `invalid-input` |
| 保存异常、结果未知 | `unknown-result`（只重读核对，不自动重发） |
| 其它保存/读取异常 | `save-failed` / `read-failed` |
| 通道或数据层未就绪 | `unavailable` |

`summary/draft.save` 不检查基线、不产生正式版本；失败只用 `invalid-input` / `save-failed` / `unavailable` 等既有码。

### 4.4 已知文档债务（代码注释未改）

`wire.ts:130-134` 的注释仍把「已知 scope 无概况」描述为返回 `summary: null`，`board-adapter.ts:43-45` 与 `source.ts:377` 附近也有同类措辞；实际契约是：**已知 scope 返回非 null 视图（`current: null`）**，只有 scope 不存在才返回 `null`（host 还会先报 `not-found`/`unknown-project`），client 把 `summary: null` 当作读取结果不一致并按失败处理。上述注释属于早期设计的残留，本次只改文档、不改代码；后续代码清理时应同步更正。

## 5. host 实现

### 5.1 端口（`packages/plugin/src/board-channel.ts`）

`HostBoardPort` 新增（均带 `signal?: AbortSignal`，`:409-428`）：

- `readSummary(input: HostSummaryReadInput): Promise<HostSummaryReadOutcome>`；
- `saveSummary(input: HostSummarySaveInput): Promise<HostSummarySaveOutcome>`；
- `saveSummaryDraft(input: HostSummaryDraftSaveInput): Promise<HostSummaryDraftSaveOutcome>`。

结果类型在 `:287-371`：成功携带 `summary` / `value` / `draft`；失败携带 `code`、`message`，`summary/save` 失败可带 `baseline`。`readSummary` 不返回整块看板快照，保存也不提供撤销语义（F03 保存不可撤销）。

三个 handler 分支（`:612` / `:627` / `:665`）沿用四段式：解析 payload → 校验 scope → 调用 port → 映射成功/失败；payload 解析失败仍走 host-only `invalid-payload`，不发给浏览器。

### 5.2 core → host 适配（`packages/plugin/src/board-adapter.ts`）

- `readSummary`（`:948-990`）：先做 scope 存在性检查（任务用 `preReadTask`，项目用 `resolveProject`），任务不存在 `not-found`、项目未登记 `unknown-project`/`read-failed`；然后调用 `core.readSummary`。已知 scope 返回非 null 视图并转成 `summaryViewValueOf`；仅当 core 返回 `null` 时才透传 `summary: null`（正常已知 scope 不会走到）。
- `saveSummary`（`:1005-1140`）：校验 payload（`updateId`、expected 三元组、`content`/`cleared` 恰好一个）；调用 `core.saveManualSummary`；`committed`/`already-applied`/`no-change` 都返回 `ok: true` 并带 `view: summaryViewAfterSave(core, input)`；`blocked` → `stale-baseline` + expected/actual；`rejected` 按 scope 映射 `not-found`/`unknown-project`/`invalid-input`；异常 → `unknown-result`/`save-failed`。
- `summaryViewAfterSave`（`:343-347`）：保存后重读；重读失败返回 `view: null`，client 只提供重读，不把写入判为失败。
- `saveSummaryDraft`（`:1154-1196`）：`saveDraft({kind: 'summaryDraft'|'overviewDraft', scopeKind, scopeId, objectId: scopeId, content, updateId?})`，成功返回 `{ok: true, draft}`；不检查正式基线、不追加版本。
- `delayed-board-port.ts`（`:107-121`、`:152-159`）：core 未就绪时三个方法分别返回 `unavailable`（读失败不伪装成空概况）；就绪后委托给真实端口。

## 6. client 实现

### 6.1 数据源（`packages/plugin-client/src/source.ts` / `channel-source.ts`）

- `BoardSource` 新增 `readSummary` / `saveSummary` / `saveSummaryDraft`（`:552-573`）；输入类型 `SummaryScopeInput`/`ReadSummaryInput`/`ManualSummarySaveInput`/`ManualSummaryDraftSaveInput`（`:349-442`）。
- 无通道时返回 `unavailable`，文案明确「这不等于『还没有概况』」：`NO_CHANNEL_SUMMARY_READ_MESSAGE`、`NO_CHANNEL_SUMMARY_SAVE_MESSAGE`、`NO_CHANNEL_SUMMARY_DRAFT_MESSAGE`（`:595-602`）。
- `channel-source.ts`（`:417-436`、`:447-504`、`:522-555`）：经 `ctx.connection.rpc.call` 发三个端点，解析值/失败详情；`summary: null` 原样交给 controller 处理（controller 视为不一致，见 §6.2）。

### 6.2 控制器（`packages/plugin-client/src/controller.ts`）

- 状态：`BoardState` 新增 `taskSummary: SummaryEditorState | null`、`projectSummary: SummaryEditorState | null`（`:312-315`）；`SummaryEditorState` 含 `scopeKind`、`scopeId`、`status`、`view`、`text`、`baseline`、`editing`、`previewing`、`dirty`、`updateId`、`draftStatus`、`error`、`notice` 等（`model.ts:923` 起）。
- API（`:535-563`、实现 `:1997-2045`）：`loadTaskSummary`、`loadProjectSummary`、`closeProjectSummary`、`openSummaryEditor`、`closeSummaryEditor`、`setSummaryText`、`saveSummaryDraft`、`previewSummary`、`cancelSummaryPreview`、`saveSummary`。
- 读取（`:1203-1255`）：按 scope 一次一读；`result.summary === null` 视为读取结果不一致并显示失败（`:1230-1238`），不渲染空态；显式重读时若正在编辑，保留未保存输入并移动基线（`:1245-1254`）。
- 编辑（`:1257-1303`）：无基线拒绝编辑；打开时铸造/复用 `updateId`；关闭丢弃未保存到草稿的内存输入。
- 草稿（`:1305-1348`）：仅「保存草稿」按钮触发 `saveSummaryDraft`，成功后草稿状态为 `saved`，不产生正式版本；失败保留输入并显示错误。
- 预览/保存（`:1350-1455`）：`previewSummary` 打开差异；`saveSummary` 带 expected 基线与当前 `updateId`，成功后用返回 `view` 重建编辑器；`no-change` 提示未修改；`already-applied` 提示已生效；失败按可重放码（`save-failed`/`unavailable`）给写重试，其它（`stale-baseline`/`not-found`/`unknown-project`/`invalid-input` 等）只给重读，`invalid-input` 不重试；`view: null` 时显示「概况已保存，但视图未刷新。请重新读取。」并只提供重读。

### 6.3 UI（`packages/plugin-client/src/board.tsx` / `model.ts`）

- 任务详情内渲染 `renderSummaryArea('task', …)`（`:955-957`）；项目区用 `data-aikanban-project-summary-button` 打开总览，再渲染 `renderSummaryArea('project', …)`（`:1341-1353`）。
- 单 section：`SUMMARY_SECTION_ID = 'manual'`，标题「任务概况」/「项目总览」；textarea 的 `data-aikanban-summary-text` 编辑正文（`model.ts:759-770`、`board.tsx:794-799`）。
- 数据属性（client-ui 证据）：`data-aikanban-summary='task'|'project'`、`data-aikanban-summary-open`、`data-aikanban-summary-edit`、`data-aikanban-summary-text`、`data-aikanban-summary-save-draft`、`data-aikanban-summary-preview`、`data-aikanban-summary-save`、`data-aikanban-summary-back`、`data-aikanban-summary-cancel`、`data-aikanban-summary-close`、`data-aikanban-summary-official`、`data-aikanban-summary-version`、`data-aikanban-summary-history`、`data-aikanban-summary-diff`、`data-aikanban-summary-error`、`data-aikanban-summary-notice`、`data-aikanban-summary-draft-badge` 等。
- 版本展示：`summaryVersionLabel` / `summaryVersionMeta` 显示「用户手动」、确认时间与修改结果；历史只列元数据（`summaryHistoryEntries`），不展开正文、不提供恢复。
- 预览：`summaryPreviewRows` 行级 diff，行属性 `data-aikanban-summary-diff-row='same|removed|added'`。

### 6.4 残余（未实现/未验证）

- 草稿只有显式「保存草稿」按钮，输入没有自动 debounce 保存；关闭编辑器会丢弃未写入草稿的内存输入。
- 没有 `summary/draft.discard` 端点，也没有「放弃草稿」按钮；草稿的放弃/清理仍只能走 core 既有方法，UI 未接。
- UI 不暴露 `cleared` 分支（只发送 `content`）；core/wire 的 `cleared` 契约保留，空文本保存与显式清空在行为上尚未形成独立入口。
- 活动区直接显示 core 生成的 `summary`（已是中文）与原始 `code`；S1 不需要额外的客户端 code→中文映射。
- 2026-11-13 已安装到真实 profile 并因 F03 重启三次，真实 GUI 已执行 AT-26/44 的保存与重启观察；其余 AT 与失败路径仍待执行。

## 7. 测试与门禁（2026-11-13 @ `973ee67`）

| 项 | 结果 | 备注 |
| --- | --- | --- |
| 全量测试 | **462 passed**（core **80** / plugin-client **205** / plugin **177**） | 含 F03 core/wire/adapter/client 用例与 R02 即时刷新回归；测试不等于 AT |
| `pnpm typecheck` / `pnpm build` | `EXIT 0` | |
| `verify-host-import` | **12/12** | 新增 wire/host 导入未破坏加载链 |
| `probe-host` | **5/5** | 第 5 项 `channel=/aikanban registered=true path=compat dataLayerReady=true` |
| `verify-rpc-roundtrip` | 28/28 | **仍只覆盖 8 端点/9 码，不覆盖 F03 三端点**；不能以该项通过声称 F03 协议已往返验证 |
| `check_docs` | PASS（见本次报告） | 文档检查不等于实现/验收 |

F03 相关测试文件：`packages/core/test/f03-manual-summary.test.ts`、`packages/plugin-client/test/wire.test.ts`、`packages/plugin/test/board-adapter.test.ts`、`packages/plugin-client/test/board.test.ts` 及 controller 相关用例。

## 8. 仍未验证与风险

- **安装与真实 GUI**：2026-11-13 已用 `tools/install-to-profile.mjs` 安装 F03 构建（首次 client SHA256 `15DC8705…`、82541 B），并三次完全退出/重开 DSH（前两次为首次安装与保存验证，第三次为 R02 修复后复验）；R02 修复后以 client SHA256 `48661F59…`、83372 B 第三次安装/重启复验。AT-26/44 已在真实 GUI 执行；R02 即时刷新已复验。安装后未再出现 web-boot 崩溃，回滚包在 `C:\Users\InformationDS\aikanban-profile-backup-20261113` 与 `...-2`。
- **AT 仅部分执行**：AT-26 S1 通过、AT-44 部分执行；AT-49、AT-26 联合、AT-27/29/45/67 仍待执行/待联合验收；逐条见 [verification.md](verification.md)。不得把本文或 §7 的测试/门禁写成验收通过。
- **联合场景未实现**：F06 记录、F09 结论修正、F10 历史恢复、F13 成果、F18 故障注入均不在本切片；AT-27/29/45/67 需联合验收；AT-49 需关闭 AI 并具备已登记的失败注入开关，当前未执行。
- **R02 即时刷新缺陷（已修复）**：曾出现保存任务概况成功后任务卡/详情顶部仍显示旧内容、切换项目或重启后才更新；storage/版本历史正确。2026-11-13 由 `58c7c69` 在 controller 保存成功路径回写 `summaryProgress` 修复；真实 GUI 第三次重启后保存第 2 版，未切项目、未重启即更新；证据 `docs/evidence/2026-11-13-f03/at26-r02-immediate.png` 与 `at26-r02-immediate-state.txt`。
- **草稿生命周期缺口**：无自动保存/debounce、关闭丢弃内存输入、无放弃草稿入口；这与 F03-R07「离开/重启恢复可用草稿」仍有距离，需在真实 GUI 与后续实现中核实/补齐。
- **类型注释与契约不一致**：`summary: null` 的旧注释（wire/adapter/source）仍是文档债务；实际行为以「已知 scope 返回视图」为准（§4.4）。
- **工具覆盖缺口**：`verify-rpc-roundtrip` 未覆盖 F03 三端点；需要扩展端点/失败码清单后才能作为协议层证据。
- **F01/F02 仍部分执行**：F03 的详情/项目区入口依赖 F01/F02 的现有 UI；F03 的验收不能借用 F01/F02 未执行的 AT 结论。

## 9. 依据

- 需求与验收：[F03 PRD](prd.md)（§1—§7）；[验收映射](../../mapping/acceptance.csv)；[验收执行规则](../../../engineering/acceptance-execution.md)；[M6 模板](../../templates/vibecoding-task.md)。
- 代码：`packages/core/src/types.ts`、`packages/core/src/core.ts`、`packages/core/test/f03-manual-summary.test.ts`、`packages/plugin-client/src/wire.ts`、`packages/plugin-client/src/source.ts`、`packages/plugin-client/src/channel-source.ts`、`packages/plugin-client/src/controller.ts`、`packages/plugin-client/src/model.ts`、`packages/plugin-client/src/board.tsx`、`packages/plugin/src/board-channel.ts`、`packages/plugin/src/board-adapter.ts`、`packages/plugin/src/delayed-board-port.ts`。
- 接线上下文：[s1-wiring.md](../../../engineering/s1-wiring.md) §10、[s1-wiring-implementation.md](../../../engineering/s1-wiring-implementation.md) §21、[交付状态](../../../delivery/status.md)、[ADR-004](../../../engineering/decisions/ADR-004-界面挂载点与看板形态.md)、[ADR-005](../../../engineering/decisions/ADR-005-浏览器半与宿主半的数据通道.md)。
