# @aikanban/core

AIKanBan 的核心数据模型：**一次确认 = 一次原子写**的成对生效、四类正式内容的只增不改版本链、草稿、基线与「概况待核对」保存门槛、关键结论适用性，以及 **F01 项目隔离与任务字段 + F02 状态机、列内顺序与撤销**（项目键 = `workspace.id`，任务字段与正式内容分离，一次管理动作 = 一次原子写）。

设计依据与实测结论见 [`docs/engineering/decisions/ADR-002-paired-confirmation-single-write.md`](../../docs/engineering/decisions/ADR-002-paired-confirmation-single-write.md) 与 [`ADR-003`](../../docs/engineering/decisions/ADR-003-project-mapping-and-context-injection.md)。**`board` 接线只需读 [`F01 契约`](#f01-契约项目隔离与任务字段board-接线用)。**

## 命令

```bash
pnpm --filter @aikanban/core run typecheck   # tsc -p tsconfig.test.json（继承根 tsconfig.base.json）
pnpm --filter @aikanban/core run test        # vitest run（66 个测试）
pnpm --filter @aikanban/core run build       # tsc -p tsconfig.json（composite，供根 tsc -b）
node packages/core/experiments/storage-domain-atomicity.mjs   # ADR-002 的 25 项实测证据
```

## 宿主集成（三步）

```ts
import z from 'zod';
import {
  AIKANBAN_TABLES,
  buildDomainSpec,
  createKanbanCore,
  createStorageDomainPort,
} from '@aikanban/core';

// 1. 打开域（defineDomain 来自 @deepseek-ai/dsh-storage-domain；buildDomainSpec 只描述形状，不引入 zod 依赖）
const spec = defineDomain(buildDomainSpec(z));
const domain = await ctx.storageDomain.open(spec);
const core = createKanbanCore({ port: createStorageDomainPort(domain) });

// 2. 创建任务/项目时建立 scope（缺少 scope 时确认会以 unknown-scope 拒绝，不会猜测位置）
await core.ensureScope({ scopeKind: 'task', scopeId: taskId });
await core.linkConversation({ taskId, conversationId });   // OBJ-03 固定归属，改绑被拒绝

// 3. 成对确认（唯一会写正式内容的路径）
await core.confirmPaired({ updateId, scopeKind: 'task', scopeId: taskId, recordObjectId: conversationId, expected, origin: 'ai', record: {...}, summary: {...} });

// 4. F01：登记项目 + 读看板（board 只看这一节；任务由 createTask 幂等创建，不需要先 ensureScope）
await core.registerProject({ projectId: workspace.id, title: workspace.title, path: workspace.path });
const board = core.readBoard({ projectId: workspace.id, workScope: { availability: workspace.status() === 'ok' ? 'ok' : 'missing-dir' } });
// board.status：'ok' | 'unknown-project'（未登记，不是空项目）| 'failed'（读取失败，保留已知数据）

// 关闭域由宿主负责（通常是 ctx.effect 的 disposer）：await domain.close();
```

`defineDomain` 需要宿主自己的 zod，本包不依赖 zod；若宿主的 zod 版本与 `ZodLike` 结构不完全匹配，可直接用 `isScopeStateRecord` / `isDraftRecord` 自建 schema：

```ts
tables: {
  scope_state: domainTable(z.custom(isScopeStateRecord)),
  drafts: domainTable(z.custom(isDraftRecord)),
}
```

## 域规格（domain spec）

| 项 | 值 |
| --- | --- |
| 域名称 | `aikanban_core`（须匹配 `UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/`） |
| 版本 | `1` |
| 布局 | `layout: 'single'`（理由见 ADR-002；`per-record` 会把损坏记录静默读成不存在，违反 REC-05） |
| 全局槽 | 无 |
| `invalidRecords` | 不声明（该策略面向可丢弃的派生数据，且在 `single` 下无效） |
| 表 | `scope_state`、`drafts` |

记录键（全部经 `encodeKey` 转义为 `[a-zA-Z0-9_-]+`，`_` 只作分隔符，因此复合键无歧义）：

| 记录 | 键 | 说明 |
| --- | --- | --- |
| scope head | `scope1_<scopeKind>_<encodedScopeId>` | 每个 task / project 一条；**一次确认的全部内容都在这条记录里** |
| 草稿 | `draft1_<kind>_<scopeKind>_<encodedScopeId>_<encodedObjectId>` | 槽位即键 ⇒ 每槽位最多一份活动草稿（OBJ-07） |
| 版本号 | `v1_<objectKind>_<encodedObjectId>_<encodedUpdateId>` | 确定性派生：同一次确认重试必然得到同一版本号 |

`scope_state` 记录形状（`ScopeStateRecord`）：`scope`、`revision`（内容提交计数）、`applicabilityRevision`（适用性修正计数，正文未加版本也会变）、`lastCommittedUpdateId`、`lastConfirmedAt`、`links`（固定归属）、`current`（每个 objectKind 的当前版本指针）、`chains`（每个 objectKind × objectId 的只增版本链）、`amendments`（适用性修正链）、`recheck`（概况/总览待核对标记）、**`activity`**（F01-R07 重要活动历史，只增）、**`task`**（F01 任务字段，仅任务 scope）、**`project`**（项目登记/工作范围观测/看板位置，仅项目 scope）、`createdAt` / `updatedAt`。

后三项是 F01 新增的**可选**字段：域版本仍为 `1`，S0 写入的文档照常打开（`normalizeScope` 回填默认值）；但只要出现就会被**严格校验**，所以损坏仍然 fail loud（REC-05）。任务字段与正式内容同处一条记录，正是「改字段 + 写历史 + 标记待核对」能成为一次原子写的原因。

F02 在同一处再追加两个可选子结构：`task.recentStatusUpdateIds`/`task.lastStatusChange`（撤销基线与幂等窗口）与 `project.boardOrder`/`project.orderRevision`（列内手动顺序与它的版本）。旧记录缺这两个结构时由 `normalizeScope` 回填为「无可撤销、无顺序偏好」。

## 端口（StoragePort）

```ts
interface StoragePort {
  readonly name: string;
  get<T>(table: string, key: string): T | undefined;
  put<T>(table: string, key: string, value: T): Promise<void>;
  delete(table: string, key: string): Promise<boolean>;
  update<T>(table: string, key: string, fn: (current: T) => T): Promise<T>;  // fn 必须同步
  entries<T>(table: string): IterableIterator<[string, T]>;
  keys(table: string): IterableIterator<string>;
  size(table: string): number;
}
```

契约（实测，见 ADR-002 第 3 节）：一次 `put`/`update` 恰好原子发布一个文档；两次写不是事务；`update` 的 `fn` 在自己的队列槽位求值且必须同步；持久化先于内存，失败不留分歧；对不存在的键 `update` 以 `code: 'missing-key'` 拒绝；读取返回存储对象本身，不做防御性拷贝（不要就地修改返回值）。

实现：

- `createStorageDomainPort(domain)` —— 生产用，适配真实 `Domain`/`KvTable`（结构化类型，**不 import 任何 DSH 类型**）。
- `createMemoryStoragePort(createMemoryMedium(), { beforeWrite })` —— 测试用，复刻上述契约；`medium` 跨端共享即为「重启」，`beforeWrite` 用于故障注入；`port.journal` 记录每次持久写（断言「一次确认恰好一次写」用的就是它）。

## 公开 API

```ts
createKanbanCore({ port, now? }): KanbanCore
```

**归属与范围**

| 方法 | 说明 |
| --- | --- |
| `ensureScope({scopeKind, scopeId, at?})` | 建立 scope head；已存在则不改写。必须在首次确认前调用 |
| `linkConversation({taskId, conversationId})` | OBJ-03 固定归属；重复关联幂等，改绑返回 `rebind-forbidden` |
| `linkOutcomeTask({projectId, taskId})` | 同上（成果任务 ↔ 项目） |
| `readScopeState({scopeKind, scopeId})` | 读取 head 记录（诊断/断言用） |

**草稿**（SAVE-01/03/10、OBJ-07）

| 方法 | 说明 |
| --- | --- |
| `saveDraft(input)` | 写入/替换一个槽位；记录基线（revision + 各成员版本）与 AI 原稿、被拒分区 |
| `getDraft(draftId)` / `listDrafts(filter)` | `activeOnly` 只返回候选状态 |
| `draftIdFor({kind, scopeKind, scopeId, objectId})` | 计算槽位键（consumedDraftIds 需要） |
| `setDraftState(draftId, state)` | `editing`/`ready`/`needsRecheck`/`saved`/`abandoned`/`failed` |
| `abandonDraft(draftId)` | 只取消本次候选，不动正式内容与其它草稿 |
| `deleteDraft(draftId)` | 删除草稿记录本身 |
| `isConfirmableDraftState(state)` | 是否计入「待确认」（OBJ-07） |

**成对确认（唯一写正式内容的路径）**（SAVE-02/06、F06-R07、F08-R06）

```ts
confirmPaired(input: ConfirmInput): Promise<ConfirmOutcome>
```

`ConfirmInput`：`updateId`（确认身份，幂等键）、`scopeKind`、`scopeId`、`recordObjectId`（对话 id / 成果任务 id）、`expected`（基线：`revision` + `applicabilityRevision` + 各成员版本）、`origin`、`source?`、`confirmedAt?`、`record: MemberInput`、`summary: MemberInput`、`consumeDraftIds?`、`amendments?`、`bothCheckedNoUpdate?`。

`MemberInput`（必须三选一表态，沉默不是「无需更新」）：

| 字段 | 语义 |
| --- | --- |
| `content` | 新正文；与当前正式正文完全一致则不算变化；仅排版差异默认不产生版本（`allowCosmeticVersion: true` 可强制） |
| `cleared: true` | **明确清空 = 删除变化**（SAVE-02），会生成 `changeKind: 'cleared'` 的空正文版本；对已空对象则是无变化 |
| `confirmUnchanged: true` | 用户已核对且本成员无需修改（F07-R05）；记录实质变化时它同时解除「概况待核对」门槛 |

可选：`aiDraft`、`userResult`、`readSourceVersionIds`、`coveredStage`（SAVE-08 元信息）。

`ConfirmOutcome`：

| status | 含义 |
| --- | --- |
| `committed` | 已生效；`versions`（哪些成员产生版本）、`changed`/`cleared`/`unchanged`/`cosmeticOnly`、`amendments`、`consumedDraftIds`、`recheck` |
| `already-applied` | 同一 `updateId` 已生效（连点/超时重试/多窗口）：返回**原结果**，不产生第二版本，不写 |
| `no-change` | 双方确实无需更新；**不产生版本、不产生写入**；`processingPositionHint: 'advance'` 仅在 `bothCheckedNoUpdate: true` 时给出 |
| `blocked` | `code: 'recheck-pending'`（概况/总览待核对，或记录实质变化但汇总未核对）或 `'baseline-changed'`（基线已变）；带 `actual`、`needsRecheck`、`preservedDraftIds`、`recheckPersisted`；只写待核对标记，不写正式内容 |
| `rejected` | `invalid-input` / `unknown-scope` / `unlinked-conversation` / `unknown-conclusion` / `unknown-version` / `nothing-to-confirm`；不写 |

**适用性修正**（APP-03/04、F09-R04）

`amendApplicability({...ConfirmInput 去掉 record/summary, amendments})` —— 与 `confirmPaired` 同一条写路径：修正可以单独提交（`revision` 不变、`applicabilityRevision` +1、不产生正文版本），也可以携带正文变化在同一次写内生效（「文案与状态不能半生效」）。修正按 `appliesTo` 的 scope 隔离。

**恢复为新版本**（SAVE-09/10、APP-07）

`restoreAsNewVersion({updateId, scopeKind, scopeId, recordObjectId, versionId, expected, origin, summary, reconfirmApplicability?, consumeDraftIds?})` —— 以历史正文追加新版本，不删后续版本、不回滚任务状态；已确认的否定/替代**不会**因恢复正文而复活；要重新采用须显式列在 `reconfirmApplicability` 里，并在同一次写生效。

**读取与核对**

| 方法 | 说明 |
| --- | --- |
| `readPair({scopeKind, scopeId, recordObjectId})` | 一致快照：`consistent: true`（两成员来自同一次记录读取）、`revision`、`applicabilityRevision`、`pairToken` |
| `readObject({...objectKind, objectId})` | 当前正式对象；`conclusions` 带有效状态与修正来源；`readToken` 覆盖正文版本与有效结论状态 |
| `readVersion({...versionId})` / `history({...})` | 指定版本 / 该对象升序全链 |
| `checkBaseline({...expected})` | 预检：`ok`、`issues`（`revision-changed`/`applicability-changed`/`member-base-changed`/`recheck-pending`/`scope-missing`）、`recheck` |
| `readRecheck({scopeKind, scopeId})` | 已持久化标记 ∪ 由过期草稿推导出的标记，附 `staleDrafts` |
| `clearRecheck({scopeKind, scopeId, target})` | 手动核对完成（F07-R05）：不产生版本、不推进 `revision` |

## F01 契约：项目隔离与任务字段（`board` 接线用）

本节是 peer `board`（`packages/plugin` 的 AI 工具 / `packages/plugin-client` 的看板）接线所需的**唯一**接口。看板**不得**自建第二套状态、任务字段或存储访问：状态 id、字段、排序、活动历史与草稿全部来自这里。

### 数据落点（先读这一条）

F01 的任务字段、活动历史、项目登记**与成对确认共处同一条 scope head 记录**（`scope_state`，键 `scope1_task_<id>` / `scope1_project_<id>`）。因此：

- **一次管理动作 = 一次原子写**：字段 + 活动历史条目 +（目标实质变化时的）「概况待核对」标记一起发布，不存在「字段改了但历史/标记没写」的中间态；
- 域与表**没有新增**（仍是 `aikanban_core` v1 + `scope_state`/`drafts` 两张表）；新增字段是**可选**的，S0 文档仍能打开（不 bump 版本，避免旧文档 open 失败＝数据损失）；
- 任务 id **由 `(projectId, requestId)` 确定性派生**（`taskIdOf`）：同一 `requestId` 永远指向同一条记录，所以「同一次提交连点/超时重试」在结构上不可能产生第二个任务。

### 项目（项目键 = `workspace.id`，标题只用于显示）

```ts
registerProject({ projectId, title, path, at? }): Promise<ProjectOutcome>
readProject({ projectId, workScope? }): ProjectView | null      // 未登记 ⇒ null，绝不自动新建
listProjects(): readonly ProjectView[]
observeWorkScope({ projectId, availability, detail?, at? }): Promise<ProjectOutcome>
canUseWorkScope({ projectId }): { projectId, path, availability, allowed, reason }
saveBoardPosition({ projectId, selectedTaskId?, view?, at? }): Promise<ProjectOutcome>
```

| 语义 | 说明 |
| --- | --- |
| 项目身份 | `projectId` **必须**是 `workspace.id`；`title` 仅供参考显示，任何读取/去重都不得用标题（ADR-003 实测两条路径同名） |
| `path` | = `workspace.path`；`observeWorkScope` **永不改写** `path`（目录消失也一样） |
| `availability` | `'ok' \| 'missing-dir' \| 'unknown'`，来自宿主 `workspace.status()`；`unknown` = 尚未观测，不得当作「无范围」 |
| `ProjectOutcome` | `{status:'registered'\|'refreshed'\|'recorded'\|'saved'\|'unchanged', project}` 或 `{status:'rejected', code:'invalid-input'\|'unknown-project', message}`。**`unchanged` 不写存储**（可安全轮询） |
| 工作范围不可用 | **管理数据照常读写**（创建任务、改字段、改位置都允许）；`workScope.allowed=false` 只用于「需要真实文件系统动作」时拒绝。范围恢复后同一 `projectId` 直接可用，数据不删 |
| 看板位置 | 每项目独立（`position.selectedTaskId` + `position.view`）；`selectedTaskId` 不属于该项目时 `rejected/invalid-input`，所以切换项目不会串位置 |
| 显示用实时观测 | `readProject`/`readBoard` 可传 `workScope: {availability, detail?}` **仅影响本次展示**，不落库；要落库用 `observeWorkScope` |

### 任务字段（F01 用户字段，独立于记录/概况）

```ts
createTask({ projectId, requestId, title, goal?, initialStatus?, blockedReason?, at? }): Promise<CreateTaskOutcome>
lookupCreate({ projectId, requestId }): CreateLookupResult
readTask({ taskId }): TaskView | null
readBoard({ projectId, workScope? }): BoardReadResult
updateTaskFields({ taskId, requestId, expected: FieldsBaseline, title?, goal?, at? }): Promise<UpdateFieldsOutcome>
saveFieldDraft({ taskId, requestId, title?, goal?, at? }): Promise<FieldDraftOutcome>
readFieldDraft({ taskId }): PendingFieldDraft | null
discardFieldDraft({ taskId }): Promise<boolean>
readActivity({ scopeKind, scopeId, limit? }): readonly ActivityEntry[]   // 最新在前
```

**`createTask` 的错误语义**（全部**不写存储**，并回显 `keptInput`）：

| code | 触发 |
| --- | --- |
| `invalid-title` | 标题为 `''` 或仅空白（F01-R02）；**不清空目标输入** |
| `blocked-reason-required` | `initialStatus:'blocked'` 但原因缺失/空白；此时**不创建半成品正式任务** |
| `invalid-status` | 未知状态（含把「归档」当状态） |
| `unknown-project` | 项目未 `registerProject`：不猜测归属位置（REC-05） |
| `invalid-input` | `projectId`/`requestId` 为空 |
| `request-id-collision` | 派生 id 已被一条**身份不同**的记录占用（防御分支，摘要碰撞时才可达，不合并、不覆盖） |

`CreateTaskOutcome`：`{status:'created'|'already-created', taskId, task, project}` / `{status:'rejected', code, message, keptInput}` / `{status:'failed', code:'write-failed', message, taskId, projectId, requestId, keptInput}`。

**结果未知的处理（REC-02/REC-03）**：写返回 `failed` 时**什么都没落地**（端口先持久化后改内存），列表不变。正确顺序是 `lookupCreate({projectId, requestId})` 核对 → `'not-created'` 则用**同一个 `requestId`** 重试；`'created'` 则直接用返回的任务。**不要为同一次提交换新 `requestId`**——那才会产生第二个任务。`createTask` 的成功结果**报告归属项目**（`project.projectId`），不依赖页面当前标题。

**`readBoard` 的三态**（不要把失败/未登记当空项目）：

| status | 含义 |
| --- | --- |
| `ok` | `{project, tasks, columns, recheck, boardToken}`；`tasks` 已按列内顺序排序、排除归档；空项目就是 `tasks: []` |
| `unknown-project` | 未登记（或只有内容没有项目字段）：界面须显示「项目信息不可用」，**不显示空看板** |
| `failed` | 读取失败（`code:'read-failed'`）：保留已知数据并允许重试（REC-05） |

`columns` 固定五列 `todo/doing/blocked/done/cancelled`，`cancelled.collapsedByDefault === true`、`done` 仍可见（F02-R01）；`label` 是中文显示兜底（`TASK_STATUS_LABELS`）。**归档是 `task.archived` 可见性属性，不是第六种状态**，S1 恒为 `false`。`boardToken` 在同一状态上稳定：把响应与「当前选中的 `projectId`」比对，即可丢弃切换项目后迟到的旧项目响应（F01-R01）。

**`updateTaskFields` 的错误语义**：

| status / code | 语义 |
| --- | --- |
| `saved` | 只有**实质变化**才写：`fieldsRevision` +1、（目标变化时）`goalRevision` +1、`updatedAt` 前进；`changed` 列出 `'title'\|'goal'`；**成功保存会清掉该任务的字段草稿** |
| `no-change` | 与当前正式值相同，或目标仅空白差异（`cosmeticOnly:['goal']`）：**0 次写、不产生版本** |
| `already-applied` | 同一 `requestId` 已生效（连点/超时重试/另一窗口），**保留最近 16 个**已生效 id，因此旧请求重试不会复活旧值 |
| `baseline-changed` | `expected` 已过期（`actual` 给出当前值）：**不覆盖**并发修改，本地输入保留为草稿（`draft`/`draftPersisted`），界面须展示差异让用户核对 |
| `failed/write-failed` | 正式字段与时间**保持原值**，输入保留为草稿（`draft`，重启后仍可读）；用同一 `requestId` 重试 |
| `rejected/unknown-task` \| `invalid-title` \| `invalid-input` | 不写；`invalid-title` 只对**标题**生效（目标可清空为 `''`） |

**实质性判定**：打开页面、`readTask`/`readBoard`、`saveFieldDraft`（每次键入）**都不算实质更新**——正式 `updatedAt`/`fieldsRevision` 不变，也不写活动历史；只有 `updateTaskFields` 成功才算。目标**实质**变化会在**同一次写**里追加 `goal-changed` 标记（`task.needsRecheck === true`，`recheckCodes` 含 `'goal-changed'`），未核对前 `confirmPaired` 会被 `recheck-pending` 阻断（SAVE-04）；**普通重命名不标记、不废弃**已有成果或记录草稿。

**字段草稿槽**：每任务一份（`pendingFieldDraft`），与记录成对草稿（`drafts` 表）互不覆盖；保存成功即在同一写里清空；`discardFieldDraft` 只清草稿槽，不动正式字段（返回 `false` 表示本就没有草稿，也没有写）。

**`TaskView` 的派生字段**（看板卡片直接用，不要自算）：`statusLabel`、`order`（列内生效位置）、`statusRevision`（改状态要回传的基线）、`lastStatusUpdateId`、`undoTarget`、`needsRecheck`、`recheckCodes`（如 `'goal-changed'`/`'draft-stale'`）、`summaryProgress`（**正式**任务概况的第一行；`null` ⇒ 卡片用 `goal`；**严禁**用草稿或「最后一条记录」冒充整体进展）、`hasSummary`、`hasRecord`、`pendingFieldDraft`、`archived`。

### 活动历史（F01-R07 / SAVE-08）

`readActivity({scopeKind, scopeId, limit?})` 返回**最新在前**的 `ActivityEntry`：`{activityId, at, scopeKind, scopeId, code, summary, details}`。`code` 是机器可读的（界面可用自己的文案本地化，`summary` 只是当时的中文快照）：`task-created`、`task-title-changed`、`task-goal-changed`、`task-status-changed`、`task-blocked`、`task-unblocked`、`task-reopened`、`task-order-changed`、`task-undone`、`pair-confirmed`、`project-registered`、`project-updated`、`work-scope-changed`、`board-position-changed`（`task-undo-refused` 为保留码）。**每次键入、打开页面、读取都不产生条目**。确认（`confirmPaired`）本身也是重要变化，其历史条目与版本在同一次写里发布。

### 与成对确认的关系（F01-R06）

- 确认路径**从不写**任务字段：`confirmPaired` 只动 scope head 里的版本链/指针/修正/待核对标记，任务字段与 `fieldsRevision` 不受影响，因此「记录审核期间改目标/状态」不会被回滚（AT-29）；
- 想在确认时同时核对任务字段基线，可传 `fieldBaseline: {fieldsRevision, statusRevision}`：移动过则提交仍生效，但结果里 `fieldsChangedSinceBaseline === true`（同时给出 `fieldsBaseline` 当前值），界面据此显示「相关范围需核对」；
- 直接修正概况/总览不回写聊天、不改任务字段（F03/S3 使用同一 `confirmPaired` 路径）。

## F02 契约：状态、列内顺序与撤销（`board` 接线用）

**词表只有一个来源**：`TaskStatus = 'todo'|'doing'|'blocked'|'done'|'cancelled'`，`TASK_STATUSES`/`TASK_STATUS_LABELS`/`BOARD_COLUMNS`/`isTaskStatus`/`statusLabelOf` 全部从 `@aikanban/core` 导入。客户端**不得**再声明一套 `TaskStatus`/列/标签（已出现过一次双份词表导致的构建错误）；UI 只做呈现适配。

### 状态入口（唯一）

```ts
setTaskStatus({ taskId, requestId, toStatus, expected: { statusRevision }, blockedReason?, toIndex?, at? }): Promise<StatusOutcome>
```

拖拽与菜单**必须都调用这一个入口**（F02-R02 要求两者等效，键盘走菜单也走它）。`expected.statusRevision` 就用 `TaskView.statusRevision`。

| 结果 | 语义 |
| --- | --- |
| `saved` | `{task, change:{previousStatus, blockedCleared, reopened, order, requestedIndex}, statusRevision, columnIds}`；`columnIds` 是目标列的权威顺序，UI 无需再读 |
| `no-change` | 同状态、同原因、同位置：**0 次写**（可安全重复提交） |
| `already-applied` | 同 `requestId` 连点/重试（保留最近 16 个身份）：返回当前任务，不产生第二次 |
| `baseline-changed` | `expected.statusRevision` 已过期：**不覆盖**，`actual` 给出当前版本，UI 必须重读后按当前状态执行 |
| `rejected/blocked-reason-required` | 进入已阻塞但原因为空/空白：**不写存储**、原状态原列保持，`keptInput` 回显输入（取消输入不改变正式状态） |
| `rejected/invalid-status` | 未知状态（含把「归档」当状态：归档是 `archived` 可见性属性，不是第六种状态） |
| `failed/write-failed` | 正式**状态与顺序都不变**，可重试同一 `requestId` |

规则细节：进入 `blocked` 必须给非空原因；离开 `blocked` 自动清空当前阻塞提示，旧原因进入 `task-unblocked` 的 `details.previousReason`（活动历史仍可查）；`done`/`cancelled` → 其他状态为**重新打开**（`change.reopened === true`），不生成项目记录、不归档、不停止任何对话、不动草稿；`toIndex` 可选（拖到某列的具体位置），实现先写列偏好（一次写）再写状态（一次写）——若第二步失败，偏好只是提示，卡片不会被移动。

### 列内手动排序

```ts
reorderTask({ taskId, requestId, toIndex, expected: { statusRevision } }): Promise<ReorderOutcome>
```

- **一次写**：整列顺序存在项目 head 的偏好列表里，要么整列保存要么不保存，不存在半排序（不逐个任务写 `order`）。
- `saved` 返回 `{task, column, fromIndex, toIndex, columnIds, orderRevision}`；`toIndex` 自动 clamp 到列范围；落到原位是 `no-change`（0 写）；写失败是 `failed`（正式顺序不变，0 次成功写）。
- 偏好列表是**顺序偏好**而非成员清单：读取时按任务当前状态过滤，未列出的任务按（任务自身创建序号, `createdAt`, `taskId`）追加。因此任务移出再移回会回到原位置，不需要额外写。
- `reorderTask` 不消耗 `statusRevision`、不产生 `undoTarget`（排序不是状态流转），也不会被状态撤销覆盖（撤销只改状态，不动列表）。

### 撤销（F02-R04）

```ts
undoStatusChange({ taskId, undoId, expected: { statusRevision, appliedUpdateId } }): Promise<UndoOutcome>
```

`expected` 直接回传 `TaskView.undoTarget`（`null` 表示当前状态不是一次可撤销的流转，UI 就不显示撤销入口）。

判定**只用版本与身份**，不看时间戳：`statusRevision` 必须等于操作时的版本，`appliedUpdateId` 必须等于产生当前状态的那次操作身份。

| 结果 | 语义 |
| --- | --- |
| `undone` | `{task, restored:{status, blockedReason}, previousStatus, statusRevision}`：恢复本次操作前的状态与适用字段（状态 + 阻塞原因）；**列内位置不动**（属于排序这一独立事实） |
| `cannot-undo/nothing-to-undo` | 当前状态不是一次流转产生的（新任务或最近一次是撤销本身） |
| `cannot-undo/superseded` | **竞争失败**：之后已有新修改、或同一撤销已生效。**带 `current`（当前状态+原因）、`currentStatusRevision`、`currentAppliedUpdateId`**，UI 必须展示当前值——绝不静默 no-op、绝不覆盖后续结果 |
| `failed/write-failed` | 撤销要么整个生效要么整个不生效（一次写） |

被拒绝的撤销**不写存储**（0 次写），因此「不覆盖新事实」是结构性的。

### 不变式（F02-R01，可核对）

状态只由 `setTaskStatus` 改变；`confirmPaired`、`saveDraft`、`updateTaskFields`、`saveBoardPosition`、`observeWorkScope` 与一切读取都不会改 `status`/`order`/`statusRevision`（对话、AI 结束、记录确认、成果保存都不驱动状态）。`archived` 在 S1 恒为 `false`，不参与列。

### 行为证据

`packages/core/test/f01-project-isolation.test.ts`（6）、`f01-task-create-edit.test.ts`（12）、`f01-activity.test.ts`（2）、`f02-status-and-order.test.ts`（11）真实运行覆盖：同名项目不合并、任务不跨项目、未登记≠空项目、读取失败≠空看板、位置各自保留、工作范围不可用仍可读写且不改写路径、创建无副作用（恰好 1 次写、无记录/概况/对话）、连点 8 次与重试只产生一项、故障注入后 `lookupCreate`＋同 `requestId` 重试恢复、字段保存失败保留草稿并跨重启、基线过期不覆盖新值、重命名不废弃成果/草稿、目标变化标记待核对并阻断未核对保存、活动历史不含键入且按 scope/项目隔离；F02 覆盖：完整流转与重新打开、阻塞必填与「原因无效不写」、完成/重开不动记录与草稿且不生成项目成果、确认/字段编辑/草稿/读取均不改状态、故障注入下状态与顺序都不半生效、列顺序一次写且读回一致、`toIndex` 跨列落点、撤销恢复状态+原因、撤销竞争返回 `superseded` 与当前值、被拒撤销 0 次写、同 `requestId` 并发只消耗一个 `statusRevision`、不同 `requestId` 竞争一个生效另一个 `baseline-changed`、`boardToken` 随状态变化、损坏的状态/顺序结构被 schema 拒绝（REC-05）。

## 与 PRD 的对应

| 规则 | 落点 |
| --- | --- |
| OBJ-05 四类内容 | 四个 `objectKind`，各自 `current` 指针与独立 `chains` |
| OBJ-01/02/03（F01-R01…R07） | 项目键 = `workspace.id`（标题仅显示）；任务字段独立于正式内容；`archived` 是可见性属性而非状态；工作范围不可用只拒真实文件系统动作；创建幂等（派生 taskId）；活动历史不含键入 |
| OBJ-02（F02-R01…R03） | 五状态词表唯一来源；状态只由 `setTaskStatus` 改变；阻塞原因必填、离开即清提示且旧原因入历史；完成/取消可重开且不生成成果、不归档、不停止对话 |
| F02-R04 顺序与撤销 | 列顺序 = 项目 head 的偏好列表（一次写整列）；撤销以 `statusRevision` + `appliedUpdateId` 判定，竞争失败返回 `superseded` + 当前值；保存失败状态与顺序都不半生效 |
| F02-R05 卡片来源 | `TaskView.summaryProgress` 只取正式概况第一行，`null` 回退 `goal`；`statusLabel`/`blockedReason` 提供文字 |
| OBJ-06 状态分离 | 「记录更新状态」= `DraftState`；「待确认结论」= 结论状态 `pending`（可保存）；「概况待核对」= `recheck`（阻断保存） |
| OBJ-07 草稿粒度 | 槽位即键：每对话一份记录草稿、每任务一份项目记录草稿；手动概况/总览草稿独立槽位 |
| SAVE-02/06 | 一次确认 = 一次 `put`；幂等按 `updateId` + 基线 |
| SAVE-04/05 | 基线核对含适用性；只标记受影响汇总；草稿只被标记为过期，从不被丢弃 |
| SAVE-08/09/10 | 只增版本链 + 每次确认的新版本；恢复为新版本；放弃只取消候选；版本号与处理位置分离 |
| APP-01…07 | 正文措辞与有效状态分离；修正按 scope 生效并在所有读出携带 |
| REC-01/03/04/05 | 失败保持旧一致结果；重启一致；竞争不丢草稿；损坏记录被 schema 拒绝而非读成空 |

## 注意

- `src/**` 只有可擦除语法（`erasableSyntaxOnly`），因此同一份源码既被 vitest 直接运行，也能被 `tsc` 构建。
- 源码内相对导入带 `.ts` 后缀，构建时由 `rewriteRelativeImportExtensions` 改写为 `.js`。
- 包内不使用 `node:*` 内建模块（只有测试使用）。
