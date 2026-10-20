# S1 接线设计与实施规格（切片 A / 切片 B）

> **本文是实施前置规格，不是实现记录，也不是验收记录。** 切片 A **尚未开工**：本页只把「已有代码 → 可运行的 S1 接线」的接口、映射、改动面、测试与证据判据写到可直接实施的程度。决策依据是 [ADR-007](decisions/ADR-007-s1-wiring-and-current-project.md)（**已定**：设计经用户确认、工程证据待取证）；用户已拍板 **Q1＝B（当前项目每次显式选择、不持久化）**、**Q2＝A（扩展 wire/BoardController 契约，不在适配层弱化 F02-R04/SAVE-05）**。本文回应独立评审指出的接线类前置条件（B1/B2/H1/H2）；评审原文不在仓库，本文只按任务书转述的范围落规格，不替评审定义编号含义。
>
> **证据边界**：所有代码引用均来自当前工作区（`main`，HEAD `8fd082a` 起点）的真实文件，行号已逐条核对；未能用仓库内材料证实的点标「**未确认**」。**AT 全部仍是「待执行」**：本文与未来切片 A/B 的单元/集成测试都不能当作 F01/F02 的验收证据；验收按[验收执行规则](acceptance-execution.md)与各功能 `verification.md` 执行。

## 0. 属性

| 信息 | 内容 |
| --- | --- |
| 日期 | 2026-10-20 |
| 状态 | 实施规格（前置，待取证） |
| 决策依据 | [ADR-007](decisions/ADR-007-s1-wiring-and-current-project.md)（已定）；Q1=B、Q2=A、Q3=允许 test-only 故障注入（[验收执行规则](acceptance-execution.md)第 3 节） |
| 影响功能 | F01（主）、F02（主）；边界：F03、F04 |
| 当前缺口 | core 未被 host 半打开；`/aikanban` 通道未注册（`packages/plugin/src/index.ts:396-404` 自述）；浏览器半拿不到真实数据 |
| 切片 A 完成判据 | 见 §7；**不等于 F01/F02 验收通过** |

## 1. 目标与切片

### 1.1 切片 A（可独立实施、独立取证；范围固定为现有 4 端点）

**目标**：host 半在真实宿主里打开 `aikanban_core` 域并创建 core；用 core 实现 `HostBoardPort`；在 `apply()` 中注册 `/aikanban` 通道；浏览器半经真实端口读写 `board/read`、`task/status.set`、`task/reorder`、`task/status.undo` 四端点，**并把 F02-R04/SAVE-05 的基线语义完整带过 wire**（Q2=A）。

**范围外**：项目列表/项目选择 UI（切片 B）、任务创建与字段编辑（B）、活动历史（B）、任何 F03/F04 及以后功能、真实 profile 安装。**切片 A 的看板面板在 B 之前没有项目选择入口**：它只显示「请显式选择项目」的空态（Q1=B 的必然结果），因此 A 的验收是**集成测试 + 探针证据**，不是「可指着界面说 S1 可用」。不得把 A 的集成测试写成产品验收。

**A 的改动面（实施清单）**

| # | 文件 | 改动 | 现状锚点 |
| --- | --- | --- | --- |
| A1 | `packages/plugin/src/board-adapter.ts`（**新建**） | `createHostBoardPort(...)`：把 4 端点映射到 core；含项目解析与 `registerProject`、`capabilities` 合成、workScope 摊平、错误映射 | `HostBoardPort` 接口见 `packages/plugin/src/board-channel.ts:109-114` |
| A2 | `packages/plugin/src/index.ts` | `HostContext` 补 `storageDomain`/`workspaceRegistry`/`connection`；`apply()` 中同步探测并注册通道；`ActivationSnapshot` 补通道字段；新增 `aikanban:board-channel` 诊断事件；再导出适配器 | `HostContext:167-172`；`ActivationSnapshot:102-121`；`apply():305`；通道再导出 `:406-418` |
| A3 | `packages/plugin/src/board-channel.ts` | 仅按新契约改 payload 提示文案/校验（端点集合不变）；handler 永不全抛 | `createBoardChannelHandler:145-212` |
| A4 | `packages/plugin/package.json` / `tsconfig.json` | 加 `@aikanban/core` 依赖（`devDependencies`）与 project reference | `packages/plugin/package.json:56-58`；`packages/plugin/tsconfig.json:13` |
| A5 | `packages/plugin-client/src/wire.ts` | `projectId` 必填；写 payload 携带编码后的基线；读快照补 `undoTarget`/版本字段；解析器收紧 | `ReadBoardPayload:113-117`（注释“Absent means the current project”必须改）；写 payload `:119-146`；快照 `:153-162` |
| A6 | `packages/plugin-client/src/source.ts` | `BoardSource.readBoard(projectId)`；写输入补 `expectedStatusVersion` 必填与 `appliedUpdateId`；`UndoToken` 语义 | `BoardSource:153-172`；输入 `:36-68` |
| A7 | `packages/plugin-client/src/channel-source.ts` | `projectId` 构造参数必填；payload 组装；无选择时拒绝调用 | 选项 `:114-120`；`readBoard:136-155`；写 `:195-223` |
| A8 | `packages/plugin-client/src/controller.ts` | 新增 `selection-required` 读状态；`load()` 无选择不调用 source；状态/排序/撤销发送基线；`UndoToken` 带 `{statusVersion, appliedUpdateId}` | 读状态联合 `:94-117`；`load:542-598`；变更输入 `:521-527`、`:684-691`；撤销 `:731-740`；token `:80-83` |
| A9 | `packages/plugin-client/src/model.ts` / `board.tsx` | 模型补 `statusVersion`/`undoTarget`；面板渲染选择空态、按 `undoTarget` 显示撤销 | `model.ts:119-146`；`board.tsx:403-483` |
| A10 | `packages/plugin-client/src/runtime.ts` / `index.tsx` | 选择不持久化（内存变量，刷新即丢）；每次挂载进入选择空态 | `runtime.ts:30`、`:58-71`；`index.tsx:199-214` |
| A11 | 测试 | 新增 core↔handler 集成测试；扩既有测试（清单见 §4.5、§7.1） | 见 §7 |
| A12 | `tools/probe-host.mjs` | 新增「`registerBoardChannel` 实际被调用」断言 | 观察者生成 `:353-359`；第 4 检查 `:445-463` |

> A 不新增端点、不改 `BOARD_ENDPOINTS`（`wire.ts:96-101`），不改 UI 信息架构。

### 1.2 切片 B（F01 管理动作；**不在 A 内**，本文只给扩展清单与归属）

B 在 A 全绿后开始，新增 4 个端点并接上 F01 的最小用户闭环（选择项目→建任务→改字段→看活动历史）：

| 端点（建议名） | 语义 | core 来源 | 浏览器侧 |
| --- | --- | --- | --- |
| `project/list` | 可选择的项目列表；**每次进入现取，不缓存为“当前项目”** | 宿主 `ctx.workspaceRegistry.list()`（ADR-003 W1，:27；实测见 :119） | 选择器；选定后 `readBoard(projectId)` |
| `task/create` | 幂等创建任务（`requestId` 由 UI 铸） | `createTask`（`packages/core/src/planning.ts:451`；契约 `types.ts:1067-1075`） | 新建表单、就地错误、`keptInput` 回显 |
| `task/fields.update` | 标题/目标的基线保存（字段草稿可选后置） | `updateTaskFields`（`planning.ts:620`；`types.ts:1083-1090`） | 详情内联编辑、失败留草稿 |
| `activity/read` | 任务/项目重要活动历史 | `readActivity`（`planning.ts:1176`；`types.ts:1101-1105`） | 活动列表 |

B 的扩展清单（端点 payload、`HostBoardPort` 方法、`BoardSource` 方法、`BoardController` 方法、面板 UI、测试）见 §9。B 同样**只在 A 的通道/适配器同一条写路径上扩展**，不得另起第二套数据源或第二套选择状态。

## 2. 当前项目解析（Q1=B：每次显式选择、不持久化）

### 2.1 事实

- 项目列表的权威来源是宿主 `ctx.workspaceRegistry`：`get(id)`/`list()`/`resolveByPath`/`status`，见 [ADR-003](decisions/ADR-003-project-mapping-and-context-injection.md) W1（:27）、W2（:28）、W6（:32），实测 `list()` 返回 3 个 workspace（ADR-003 :119）。
- core 侧没有“当前项目”概念：`listProjects()` 只列**已登记**项目（`planning.ts:928`），`registerProject` 承担登记（`planning.ts:862`）；`readBoard` 必须带 `projectId`（`types.ts:574-577`、`planning.ts:1059-1060`）。
- 浏览器半当前没有任何持久化：全 `packages/plugin-client/src` 无 `localStorage`/`sessionStorage`/`cookie`/`indexedDB`（已 grep 核对，`NONE`）；`runtime.ts:30` 的 `selectedProjectId` 只在内存，`runtime.ts:86-90` 可重置。这符合 Q1=B，不需要“移除旧持久化”。
- **不得**把选择塞进已有的位置保存：core 的 `saveBoardPosition`（`planning.ts:1012`）与 `ProjectFields.position`（`types.ts:312-316`、`:341-358`）是**每个项目自己的看板内位置**，不是“哪一个项目处于打开状态”；`readBoard` 的 `boardToken` 也把 position 计入（`planning.ts:1098`）。把选择写进去会让“进入即恢复上次项目”，直接违反 Q1=B。

### 2.2 规则

1. **每次进入看板都必须显式选择项目**：面板挂载时初始 `read` 状态为 `selection-required`（新增状态，见 §4.4），**不发 `board/read`**；选择来自 B 的 `project/list` UI。
2. **选择只保存在本次页面会话的内存**（`runtime.ts` 的 `selectedProjectId` 即可）；刷新、重开页面、重进座位一律回到 `selection-required`。不写 profile、不写 core、不写浏览器存储、不记忆“上次选择”。
3. **不默认第一个、不按最近使用、不按标题猜**：`board/read` 的 `projectId` 缺失时，宿主一律返回失败（`invalid-payload`，见 §6），**绝不** fallback 到 `list()` 的第一项或 `readProject()` 的任何结果。
4. **空态文案**（建议，实施时可改措辞但不能含默认选择暗示）：
   - 标题：`请选择项目`
   - 说明：`看板不会记住上次的项目；每次进入都需要显式选择。`
   - 未接通/读取失败仍按 REC-05 显示失败与重试（`source.ts:178-200`）。
5. **选择后的读取**：`readBoard(projectId)`；打开另一个项目 = 换 `projectId` 重新读取；旧项目的迟到响应继续由 controller 按 `projectId` 丢弃（`controller.ts:578-593`），该保护保留。
6. **`project/list` 自身不写任何持久状态**；也不调用 core（core 没有“所有 workspace”的权威列表，只有已登记项目）。列表项至少含 `projectId`、`title`、`path`；同名项目用 `path` 辨识（F01 §3、ADR-003 W2）。

### 2.3 `projectId` 缺失语义与 `wire.ts` 现有注释的收敛

现状是**三处口径不一致**：

| 位置 | 现状 | 问题 |
| --- | --- | --- |
| `packages/plugin-client/src/wire.ts:113-117` | `ReadBoardPayload.projectId?`，注释“Absent means ‘the current project’” | Q1=B 下不存在“当前项目”，该语义必须删除 |
| `wire.ts:447-460` `parseReadBoardPayload` | 省略 payload 合法，返回 `{}` | 与上条一起造成“宿主可猜项目” |
| `packages/plugin-client/src/channel-source.ts:114-120`、`:136-137` | 无 `projectId` 时发送 `{}` | 实际调用会走到“猜”的路径 |
| `controller.ts:542-598` | `selectedProjectId` 可为 `null`，仍调用 `source.readBoard()` | 无选择时会发一次没有项目的读取 |

**收敛方案（A5/A7/A8 一起改）**：

1. `ReadBoardPayload` 改为 `{ readonly projectId: string }`（必填，非空字符串）；删除“current project”注释；`parseReadBoardPayload` 对缺省/空串返回 `null` → host handler 返回 `invalid-payload`（`board-channel.ts:151` 的失败分支已存在）。
2. `BoardSource.readBoard(projectId: string)`：类型上强制显式项目；`createChannelBoardSource` 的选项改为必填 `projectId`（或在每次 `readBoard` 时传，推荐后者，见 §3.4 的 runtime 处理）。
3. controller 的 `selection-required` 状态发生在调用 source **之前**；`load()` 在没有选择时只切状态，不发请求。
4. 该改动是**破坏性契约变更**：会改到的既有测试见 §4.5。

### 2.4 对切片 A 的直接后果

A 没有 `project/list`，所以 A 的面板只能停在 §2.2 的第 4 条空态；**A 的集成测试显式传 `projectId` 驱动 handler**，不通过 UI 选择。演示“选择项目 → 看板”必须等 B。这是评审 B1 里“切片顺序”的硬约束，不得在 A 里提前造一个假的列表或默认项目。

## 3. 协议字段映射（host 适配层；A1 的准绳）

### 3.1 `board/read` 三态与项目解析

core `readBoard` 三态：`ok`/`unknown-project`/`failed`（`types.ts:441-463`；实现 `planning.ts:1059-1121`）。适配流程（每次 `board/read`）：

1. `projectId` 来自 payload（必填）；禁止任何 fallback。
2. 用宿主 `ctx.workspaceRegistry.get(projectId)` 解析 workspace（ADR-003 W1）；取不到 → 返回 `HostReadFailure{code:'unknown-project', message:'项目不存在或尚未在此工作区登记'}`（**不是空看板**）。
3. `workspace.path` 为空 → `unknown-project`（core `registerProject` 拒绝空 path，`planning.ts:867-871`）。
4. 调 `core.registerProject({projectId: workspace.id, title: workspace.title, path: workspace.path})`（`planning.ts:862`）：`registered`/`refreshed`/`unchanged` 继续；`rejected` → `unknown-project`（invalid-input）或 `read-failed`（其余）。
5. 调 `core.readBoard({projectId, workScope: hint})`（`types.ts:574-577`）；`hint.availability` 来自 `workspace.status()`：`'ok'`→`ok`、`'missing-dir'`→`missing-dir`、其他/未观测→`unknown`（ADR-003 W6 :32；host-capabilities HOST-01 :14）。**只作为本次展示提示，不落库、不调用 `observeWorkScope`**（读取不写；`planning.ts:389-390` 已支持 display hint）。
6. `ok` → 映射快照（§3.2）；`unknown-project` → 同码失败；`failed` → `read-failed`。

### 3.2 快照字段映射（core → `BoardSnapshotValue`）

宿主侧参照：`ProjectView`（`types.ts:419-429`）、`TaskView`（`:368-405`）、`BoardColumnView`（`:432-438`）、`BoardReadResult`（`:441-463`）；wire 侧目标：`BoardSnapshotValue`（`wire.ts:153-162`）、`BoardProjectView`（`model.ts:165-173`）、`BoardTask`（`model.ts:119-146`）。

| wire 字段 | 来源 | 规则 |
| --- | --- | --- |
| `project.projectId` / `title` | `ProjectView.projectId/title` | 原样 |
| `project.path` | `ProjectView.path` | 原样（项目路径，非“范围可用性”） |
| `project.workScopeAvailability` | `ProjectView.workScope.availability`（`types.ts:408-416`） | 三值原样；`unknown` 不得当“无范围” |
| `project.workScopeAllowed` | `ProjectView.workScope.allowed` | 原样；false 只表示真实文件动作会被拒绝 |
| `project.workScopeReason` | `ProjectView.workScope.reason` | **`null` → 省略字段**（wire `isOptionalString` 不接受 null，`wire.ts:191`、解析 `:383-384`） |
| `tasks` | `BoardReadResult.tasks`（已排除归档、按列内顺序，`planning.ts:1076-1077`） | 每个 `TaskView` 按 §3.3 映射 |
| `columns[].status/label/collapsedByDefault` | `BoardColumnView`（`types.ts:432-438`） | 原样；`tasks` 不必随列下发（UI `buildBoardView` 会按 status 过滤，`model.ts:304-340`） |
| `boardToken` | `BoardReadResult.boardToken`（`types.ts:448-449`；`planning.ts:1093-1110`） | 原样 |
| `capabilities` | **适配层合成**，见 §3.4 | 不是 core 字段 |
| `hints` | **恒不下发**（省略字段） | 见 §3.5 |

### 3.3 `TaskView → BoardTask`

wire 解析器要求/可选的字段见 `wire.ts:280-331`；core 字段见 `types.ts:368-405`。

| wire 字段（`model.ts:119-146`） | core | 处理 |
| --- | --- | --- |
| `taskId` / `projectId` / `title` / `goal` / `status` / `order` | 同名 | 原样；`statusLabel` 原样（core 已给中文兜底） |
| `blockedReason` | `TaskView.blockedReason` | `null`→省略（wire 同 §3.2 的 null 限制）；非阻塞态通常为 null |
| `archived` | `TaskView.archived` | S1 恒 false，仍下发 |
| `fieldsRevision` | `TaskView.fieldsRevision` | A 阶段下发（B 的字段编辑基线用） |
| `statusRevision` | `TaskView.statusRevision` | **改为必填**（Q2=A 的基线来源；当前 wire 解析可选，`wire.ts:293-294`） |
| `summaryProgress` | `TaskView.summaryProgress` | 原样（`null` 可下发，wire 已区分 null/absent，`wire.ts:233-239`） |
| `hasSummary` / `hasRecord` / `needsRecheck` / `recheckCodes` | 同名 | 原样 |
| `undoTarget`（**新增**） | `TaskView.undoTarget`（`types.ts:385-391`，`{statusRevision, appliedUpdateId}\|null`） | 过 wire 为 `{ statusVersion, appliedUpdateId } \| null`；用于刷新后仍可撤销（§4.2） |
| `hints` | — | 省略（§3.5） |

### 3.4 `capabilities` 合成（适配层，Q2 的一部分）

core 没有 capabilities 字段（`BoardReadResult` 仅上述四项，`types.ts:441-463`）；wire 解析**要求**它（`wire.ts:396-397`），`BoardCapabilities` 三个布尔见 `model.ts:180-187`。合成规则：

- `statusChange`、`reorder`、`undo` = **数据层已就绪**（core 已创建、域已打开）→ 全 `true`；数据层未就绪的读取本来就返回失败，不会走到快照。
- 三者的能力是**契约级**（core 支持该操作，见 `types.ts:1107-1138`），不是“这张卡片当前可撤销”。**单卡撤销**由 `undoTarget` 表达（UI 只有 `undoTarget !== null` 才显示撤销；`UndoOutcome` 的拒绝语义见 `types.ts:672-692`），两者不得混为一个字段。
- 禁止按“当前是否有任务/是否 blocked”等数据细节开关能力：那会让同一能力在不同读取里闪烁，且属于产品规则（F02-R01/R02）而非接线。

### 3.5 `hints` 恒空（遵守 `model.ts` 的 real-only 约束）

`BoardActionHint` 的注释明确：UI **不自行合成**提示，S1 没有对话/记录/成果，所以“待确认记录”“对话运行中”“待生成项目记录”必须**不出现**（`model.ts:144-159`）。core `TaskView` 也没有 hints 来源（`types.ts:368-405`）。因此适配层**不输出 `hints` 字段**（wire 解析允许省略，`wire.ts:304-305`；UI 为空数组）。F04/F06/F13 接入后由对应端点在数据层提供真实 hints，届时再扩契约——A/B 期间不得先填占位文案。

## 4. 写路径契约（Q2=A：扩 wire/controller，不在适配层弱化）

### 4.1 现状缺口（已核对）

- **读快照不携带撤销凭据**：`TaskView` 有 `undoTarget`（`types.ts:385-391`），但 wire 快照没有该字段（`wire.ts:153-162`、`model.ts:119-146`）；controller 的 `UndoToken` 只有 `{taskId, operationId}`（`controller.ts:80-83`），撤销按钮只在“刚成功”的横幅里出现（`controller.ts:387-395`），**刷新/重读后无法撤销**。
- **基线字段存在但从未被填写**：wire 的三个写 payload 都有可选的 `expectedStatusVersion`（`wire.ts:119-146`），`StatusChangeInput`/`ReorderInput`/`UndoInput` 也有（`source.ts:36-68`），但 controller 构造输入时**不传**（`controller.ts:521-527`、`:684-691`、`:738`）；`channel-source` 只是把它 passthrough（`:195-223`）。
- **core 要求基线**：`setTaskStatus`/`reorderTask` 要 `expected:{statusRevision}`（`types.ts:1114-1131`），`undoStatusChange` 要 `{statusRevision, appliedUpdateId}`（`:1133-1138`）；缺基线时 core 无法判断 SAVE-05/F02-R04。
- **撤销身份混淆**：core 的 `appliedUpdateId` = 产生当前状态的那次操作的 requestId（`planning.ts:1288`、`:1435`），而 wire `UndoStatusPayload.operationId` 注释是“**被撤销那次操作的** operationId”（`wire.ts:141-146`）；core 的 `undoId` 却是**这次撤销的身份**（用于 REC-02 重试幂等，`planning.ts:1416`）。A 必须把两个身份分开。

### 4.2 编码与解析规则（版本号过 wire）

- **统一编码**：`statusVersion = 'ver1:' + statusRevision.toString()`，只允许非负整数（例：`ver1:0`、`ver1:7`）。解析用严格正则 `^ver1:(0|[1-9]\d*)$`；不合法/缺失 → 视为**协议违规**，host 返回 `invalid-payload`（不猜基线、不当作 0）。
- 为什么用字符串：wire 已有 `FormalStatusValueWire.statusVersion: string`（`wire.ts:176-180`），失败详情用它回显正式值（`detailsOf`，`board-channel.ts:135-137`）；写 payload 用同一编码即可全链路一致，也避免 JSON number 与“缺省”混淆。
- 快照中的任务同时保留 **数值** `statusRevision`（供 UI 读）与按需编码（UI 用 `ver1:` 前缀构造 payload）；两者不得出现第二个版本事实源。B 的 `fieldsRevision` 同理（编码建议 `fver1:<n>`，在 B 定稿）。

### 4.3 三个写端点的 payload → core 映射

| 端点 | wire payload（改后） | 适配器 → core |
| --- | --- | --- |
| `task/status.set` | `taskId`、`next`、`operationId`、`reason?`、`toIndex?`、**`expectedStatusVersion: string`（必填）** | `core.setTaskStatus({taskId, requestId: operationId, toStatus: next, expected:{statusRevision: decode(expectedStatusVersion)}, blockedReason: reason ?? null, toIndex})`（`types.ts:1114-1123`） |
| `task/reorder` | `taskId`、`status`、`toIndex`、`operationId`、**`expectedStatusVersion: string`（必填）** | **先 `core.readTask(taskId)`** 核对 `status===payload.status`（wire 的 `status` 是“用户看到的列”）；不一致 → `stale-baseline`。然后 `core.reorderTask({taskId, requestId: operationId, toIndex, expected:{statusRevision: decode(...)}})`（`types.ts:1125-1131`；core 用任务当前 status，`planning.ts:1373-1375`） |
| `task/status.undo` | `taskId`、**`operationId`（本次撤销的身份）**、**`expectedStatusVersion: string`**、**`appliedUpdateId: string`（被撤销那次的 requestId）** | `core.undoStatusChange({taskId, undoId: operationId, expected:{statusRevision: decode(expectedStatusVersion), appliedUpdateId}})`（`:1133-1138`） |

重试语义：`operationId` 在重试时**复用**（REC-02；`source.ts:40-41` 的约定、`controller.ts:709-729` 的重试路径）；`retryPending` 使用保存的原输入即可。撤销的 `operationId` 必须是**新铸**（一次撤销意图一个 id），`appliedUpdateId` 来自 `undoTarget`。

### 4.4 快照与 controller 契约改动

1. `BoardTask` 增 `undoTarget: {statusVersion, appliedUpdateId} | null`（由 `TaskView.undoTarget` 映射）；`statusRevision` 改必填（见 §3.3）。
2. controller：`StatusChangeInput`/`ReorderInput` 的 `expectedStatusVersion` 改必填；`UndoInput` 改为 `{taskId, operationId, expectedStatusVersion, appliedUpdateId}`；`UndoToken` 改为 `{taskId, expectedStatusVersion, appliedUpdateId}`（不是两次操作的 operationId）。
3. controller 在**每次写前**从当前视图的任务取 `statusRevision` 编码为 `expectedStatusVersion`；任务不在视图/无 `statusRevision` → 拒绝并提示需重读（不发送无基线请求）。
4. **撤销入口扩展**：成功横幅撤销保留；详情/卡片在 `task.undoTarget !== null` 时显示撤销（由 `undoTarget` 驱动，刷新后仍可撤销）。撤销发送 `undoTarget.statusVersion` 与 `undoTarget.appliedUpdateId`。
5. **新增读状态** `selection-required`（§2）：`BoardReadState` 增 `{kind:'selection-required', message}`；`load()` 无选择 → 设置该状态并返回；`selectProject(id)` 记录内存选择并读取；`selectProject(null)` 回到该状态。
6. `runtime`：`selectedProjectId` 仍为内存；`setSelectedProject` 保持“换源/重建 controller”的现有语义（`runtime.ts:58-61`）；**不得**新增任何持久化。

### 4.5 要改的文件与受影响的既有测试

改文件见 §1.1 A5—A10。**会被破坏、必须同步修改的既有测试**（实施 A 时逐个跑）：

| 测试文件 | 受影响点 |
| --- | --- |
| `packages/plugin/test/channel-roundtrip.test.ts`（12 用例） | 固定快照没有 `statusRevision`/`undoTarget`（fixtures `:51-85`）；适配器 `createChannelBoardSource` 构造需显式 `projectId`（`:209`、读用例 `:215`）；写 payload 断言新增必填基线 |
| `packages/plugin/test/host.test.ts`（19 用例） | `ActivationSnapshot` 新字段使手写字面量需补（`:173-183`、`:262-264`、`:294-296`）；新增“通道注册”事件断言 |
| `packages/plugin/test/client-bundle.test.ts`（7 用例） | 若 bundle 导出面变化（新增/改名导出）需同步；否则仅回归 |
| `packages/plugin-client/test/controller.test.ts`（19 用例） | fake source 的 `readBoard` 无参（`:97-100`）、change input 无基线断言（多处）；新增 `selection-required` 与新撤销输入的用例 |
| `packages/plugin-client/test/model.test.ts`（19 用例） | 任务 fixture 是否需要补 `statusRevision`/`undoTarget`（`model.ts` 类型变必填时） |
| `packages/plugin-client/test/slots.test.ts`（7 用例） | 预期不受影响（座位注册），仅回归 |
| `packages/core/test/*`（66 用例） | 不受影响；作为“不改 core 语义”的回归基线 |

**新增测试**（至少）：
- `packages/plugin/test/board-adapter.test.ts`（新）：真实 `createKanbanCore` + `createMemoryStoragePort(createMemoryMedium())`（`packages/core/src/index.ts:16`、`port.ts:101-121`）经真实 `createBoardChannelHandler` 打通四端点；覆盖成功/失败/未知结果/不抛异常（§7.1）。
- `packages/plugin-client/test/wire.test.ts`（新）：`ver1:` 编解码、必填校验、非法基线拒绝、`undoTarget` 解析。
- controller 新用例：无选择不读、选择后读、基线发送、撤销凭据来源、刷新后可撤销。

## 5. 启动链路与依赖边

### 5.1 顺序（apply 同步 + 数据层异步）

1. **`apply(ctx)` 同步阶段**（不得改动现有加载链语义；`verify-host-import.mjs:292-321` 依赖 `apply` 同步发布激活信号）：
   1. 现有：logger 标记（`packages/plugin/src/index.ts:334`）、探测 `tools`/`systemPrompt`（`:337-373`）、`internal/service` 重试（`:379-382`）。
   2. **新增探测**：`connection`、`storageDomain`、`workspaceRegistry`，各自 `ctx.reflect?.get(name,false)`；与现有 `internal/service` 重试同构（不新增 `inject`，避免缺服务把 fiber 卡死——与 `packages/plugin/src/index.ts:280` 及 `packages/plugin-client/src/index.tsx:99-105` 的既有理由一致）。
   3. **`connection` 就绪 → 立即 `registerBoardChannel(connection, port)`**（`board-channel.ts:256-275`）。`port` 是**延迟就绪适配器**：数据层未好时每个方法返回 `{ok:false,...}`（`unavailable`/`read-failed`），绝不抛；因此通道可以先注册。
   4. 注册结果写入 `ActivationSnapshot.boardChannelRegistered/boardChannel`（§5.4），并发布 `aikanban:board-channel` 诊断事件（§7.2）。然后发布激活信号（沿用 `:384-392`）。
   5. **异步引导**（`void bootstrap()`，不阻塞 apply）：`storageDomain.open(spec)` → `createKanbanCore({port: createStorageDomainPort(domain)})` → 数据层 ready。失败：记录原因、保持 `dataLayerReady=false`，所有读取返回 `read-failed`（消息含原因）；不得让 apply 抛错、不得伪造空看板。
2. **每个 `board/read` 前的项目登记**：按 §3.1 第 2—4 步 `registerProject`（一次写；同项目后续为 `unchanged` 不写，`planning.ts:874-878`）。
3. **关闭**：宿主卸载时若可取得 disposer，关闭 domain 并注销通道（`registerBoardChannel` 返回的 `dispose`，`board-channel.ts:244-275`）。cordis 的销毁钩子形态**未确认**；先按“进程级生命周期不主动关闭 domain”实现并在 A 的探针里观察卸载行为，记录为已知局限。

### 5.2 core 域规格的构造（zod 依赖问题）

- core 要求宿主用**自己的** validator 构造 spec：`buildDomainSpec(zod: ZodLike)`（`domainSpec.ts:249-288`；`DomainSpecLike` `:259-265`），域层实际只调用 `valueSchema.parse`（ADR-002 实验把它写成 `{ parse: value => value }`，`packages/core/experiments/storage-domain-atomicity.mjs:77-78`）。
- host 半**不能** import `zod` 或 `@deepseek-ai/dsh-storage-domain`（裸 specifier 会让 `verify-host-import.mjs:265-276` 失败；当前 host 半的导入图只有相对路径与 `node:` 内建）。
- **A 的实现选择**：在 host 半内部实现一个**结构校验器 shim**（仅 `custom(check) → { parse(value){ if(!check(value)) throw …; return value } }`）传给 `buildDomainSpec`，再调 `ctx.storageDomain.open(spec)`。core 的校验函数本身已导出（`isScopeStateRecord`/`isDraftRecord`，`domainSpec.ts:212/239`）。
- **未确认**：`ctx.storageDomain.open()` 是否接受**未经 DSH `defineDomain()` 包装**的 `DomainSpecLike`。S0 实验用的是 `defineDomain(...)`（实验 `:41`、`:98`），但 `defineDomain` 可能只是类型/形状辅助；host 半无法导入它。**取证方式**：切片 A 的隔离探针/集成测试第一步就打开域并做一次 `getDraft` 读；若 open 拒绝，则不改产品语义，记录为阻塞并在 ADR-007 修订里选替代（例如由宿主侧注入 defineDomain 能力，或申请允许一个受控的 peer import——但**不得**静默引入裸 specifier）。

### 5.3 构建依赖边（必须保持 `verify-host-import` 11/11）

- **`packages/plugin/package.json`**：`devDependencies` 增加 `"@aikanban/core": "workspace:*"`（当前只有 `@aikanban/plugin-client`，`:56-58`）。core 会被 tsdown 打进 host bundle，因此**不需**成为运行时 `dependencies`。
- **`packages/plugin/tsconfig.json`**：`references` 增加 `{ "path": "../core" }`（当前只有 `../plugin-client`，`:13`）。
- **`packages/plugin/tsdown.config.ts`**：**无需改**——已有 `deps.alwaysBundle: (id) => id.startsWith('@aikanban/')`（`:42`），core 会被内联；host bundle 的导入图因此仍只含相对路径/`node:`。
- **`verify-host-import.mjs` 不能退化**：11 项检查见 `tools/verify-host-import.mjs`（`check(` 于 `:225`、`:231`、`:236`、`:243`、`:252`、`:265`、`:278`、`:282`、`:287`、`:292`、`:323`）；重点是 `:265-276`（导入图不得有 bare specifier）与 `:292-321`（无服务上下文 `apply()` 仍发布激活）。core 源码**没有任何 `node:` import**（已核对 `packages/core/src/*.ts`：NONE），内联后不会新增外部依赖。**实施 A 后必须重跑并贴原始输出**。
- **未确认（实施第一步验证）**：core 的 `package.json` 导出指向源码（`packages/core/package.json:7-10`：`types/default` 都是 `./src/index.ts`）。`tsc -b` 经 project reference 解析它时可能报 TS6305/TS6059（引用项目产物未构建/文件不在项目内）。若出现，最小修法是让 core 的 `exports["."].types` 指向 `./lib/index.d.ts`（core 已有 `tsc -p tsconfig.json` 的 `lib` 产出，`packages/core/package.json:17`），**不要**在 plugin 里用 `paths` 绕开依赖图；此判断需实测确认，本文按「未确认」处理。

### 5.4 `HostContext` 需要补的成员（结构性类型，不 import DSH）

| 成员 | 形状（最小） | 用途 | 现状 |
| --- | --- | --- | --- |
| `connection?` | `{ rpc: { handle(channel, handler): unknown } }` | 注册 `/aikanban` | 已有结构类型 `HostConnectionLike`，`board-channel.ts:224-241` |
| `storageDomain?` | `{ open(spec: DomainSpecLike\|unknown): Promise<DomainLike> }` | 打开域 | **新增**（core 的 `DomainLike` 见 `port.ts:294-298`） |
| `workspaceRegistry?` | `{ get(id): WorkspaceLike \| undefined; list(): readonly WorkspaceLike[] }`；`WorkspaceLike` 至少 `{ id, title, path, status(): 'ok'\|'missing-dir'\|unknown }` | 项目解析/列表 | **新增**（ADR-003 W1 只给了方法名，精确返回类型**未确认**） |
| `effect?` / `on('dispose')` | cordis 生命周期 | 关闭 domain/注销通道 | **未确认**，按 §5.1 第 3 步处理 |

`HostContext` 当前只有 `logger/reflect/on`（`packages/plugin/src/index.ts:167-172`）；以上全部**可选**，缺失时按失败可见处理，不得让 apply 抛错。

### 5.5 激活快照与诊断事件（供探针断言）

- `ActivationSnapshot`（`packages/plugin/src/index.ts:102-121`）增：`boardChannelRegistered: boolean`、`boardChannel: string | null`、`dataLayerReady: boolean`（数据层异步就绪后更新快照并重发激活信号；现有 `snapshot()` 闭包 `:316-327` 与 `getLastActivation():291` 的模式可复用）。
- 新增诊断事件 `aikanban:board-channel`（常量导出，`node:diagnostics_channel`，与 `ACTIVATION_CHANNEL` `:60` 同风格；命名带 `[aikanban]` 前缀避免遮蔽 DSH 通道）。payload：`{ channel, registered, reason?: 'no-connection'|'register-failed', at }`；`registerBoardChannel` 返回 `{ok:true}` 后发布 `registered:true`。
- 现有测试/脚本影响：`verify-host-import` 的无服务上下文仍能发布激活（新字段为 false，不影响 `:292-321`）；`probe-host.mjs` 的观察者需订阅新通道（§7.2）。

## 6. 错误码映射表

wire 的浏览器侧失败码集合固定为 8 个（`wire.ts:58-67`）；host handler 另有两个**仅 host 侧**的协议码 `invalid-payload`/`unknown-endpoint`（`board-channel.ts:151`、`:210`），浏览器把不认识的读码归为 `read-failed`、写码归为 `save-failed`（`channel-source.ts:96-99`、`:173-180`）。**适配层不得抛异常**（`board-channel.ts:174/191/206` 的 catch 已把异常变 `unknown-result`；适配器自身的异常应在内部转成失败结果）。

### 6.1 读（`board/read`）

| core / 适配层结果 | wire code | 说明 |
| --- | --- | --- |
| `ok` | — | 成功快照 |
| `unknown-project`（未登记/未在 registry/空 path） | `unknown-project` | UI 显示“项目信息不可用”，不显示空看板（`source.ts:109-120`） |
| `failed`（code `read-failed`） | `read-failed` | 保留已知数据+重试（REC-05） |
| 数据层未就绪/引导失败 | `unavailable` | 显式“数据层不可用”，**不是**空看板 |
| payload 缺 `projectId`/协议违规 | `invalid-payload`（host 码）→ 浏览器 `read-failed` | A5 收紧后这是调用方 bug，仍不猜项目 |

### 6.2 写（`setTaskStatus` / `reorderTask` / `undoStatusChange`）

| core 结果 | 细节 | wire code |
| --- | --- | --- |
| `saved` | 重读快照成功 | 成功 `{snapshot, undoable}` |
| `saved` 但服务端重读失败 | 写已生效、快照未取到 | 成功 `{snapshot:null, undoable:…}`（wire `BoardWriteValue.snapshot` 允许 null，`wire.ts:164-174`；浏览器按“未知结果”提示，`channel-source.ts:186-188`） |
| `no-change` | 0 次写 | 成功（快照重读；`undoable:false`） |
| `already-applied` | 同 requestId 重试 | 成功（快照重读；`undoable` 取 `undoTarget!==null`） |
| `baseline-changed` | `actual` 给当前基线 | `stale-baseline` + `details.current:{status,statusVersion}`（`board-channel.ts:135-137`、`source.ts:89-95`） |
| `rejected/unknown-task` | 任务不存在 | `not-found` |
| `rejected/unknown-project`（reorder） | 项目未登记 | `unknown-project` |
| `rejected/blocked-reason-required` | 阻塞无原因 | `invalid-reason`（wire 边界已先拒绝，`board-channel.ts:165-169`；core 仍兜底） |
| `rejected/invalid-status`、`invalid-input` | 协议/输入错误 | `save-failed`（不可映射为产品语义；message 原样带出） |
| `failed/write-failed`（核心写失败） | 正式值未变 | `save-failed` + `current` |
| 适配器/数据层异常（未确认结果） | 写可能已落地 | `unknown-result`（不重发） |
| 撤销 `cannot-undo/nothing-to-undo` | 当前无可撤销流转 | `stale-baseline` + `current`（UI 在 undo 分支显示当前值，`controller.ts:398-411`） |
| 撤销 `cannot-undo/superseded` | 竞争/撤销已生效 | `stale-baseline` + `current`（core 已给 `currentStatusRevision`，`planning.ts:1428-1436`、`:1439-1456`） |
| 撤销 `undone` | 成功 | 成功（快照；`undoable:false`） |

### 6.3 切片 B 的错误码扩展（B 再定稿）

B 需要区分“输入被拒绝”的一类（标题空白、字段非法），建议**新增 1 个浏览器侧失败码 `invalid-input`**（同时保留 `invalid-reason` 给阻塞原因），并把 `keptInput` 放进成功/失败值结构以支持就地回显（core 已回显：`CreateTaskOutcome` `types.ts:482-504`、`UpdateFieldsOutcome` `:525-566`）。新增码必须同时改 `BOARD_FAILURE_CODES`（`wire.ts:58-67`）、host hander、浏览器映射（`channel-source.ts:173-180`）与测试；不得在 A 里预留半成品。

## 7. 证据与完成判据

### 7.1 集成测试（切片 A 的主要证据，档 2）

新测试 `packages/plugin/test/board-adapter.test.ts`，用**真实** `createKanbanCore({port: createMemoryStoragePort(createMemoryMedium())})`（`packages/core/src/index.ts:14/16`、`port.ts:101-121`；契约说明见 `packages/core/README.md:16-45`、`:81-101`）→ 真实适配器 → 真实 `createBoardChannelHandler`（`board-channel.ts:145`），断言：

1. `board/read` 成功：`capabilities` 三分量、`workScope` 摊平（null→省略）、`hints` 缺省、`statusRevision`/`undoTarget` 在（§3.2/3.3）。
2. `board/read` 未登记项目 → `unknown-project`（不是空看板）；payload 缺 `projectId` → `invalid-payload`，且无任何项目被猜中。
3. `task/status.set` 成功、阻塞无原因被拒（无写）、`baseline-changed` → `stale-baseline`+current、同 operationId 重试 → `already-applied`。
4. `task/reorder` 成功与 `status` 不符 → `stale-baseline`。
5. `task/status.undo` 用 `undoTarget` 成功；竞争/已撤销 → `stale-baseline`+current。
6. 故障注入（内存 port 的 `beforeWrite`，选项定义见 `port.ts:82`、注入点 `:185`；属测试代码，不进入正式构建，符合 Q3 政策）：写失败 → `save-failed` 且正式值不变；适配器异常 → handler 返回 `unknown-result`，**handler 永不抛**。
7. 未知端点 → `unknown-endpoint`（`board-channel.ts:210`）。
8. 快照读：`readBoard` 返回的 `boardToken` 与 core 一致、迟到响应比较仍成立（controller 侧）。

切片 B 再加：`project/list`（不猜、不写）、`task/create` 幂等与 `keptInput`、`task/fields.update` 基线/草稿、`activity/read` 排序与 scope 隔离。

### 7.2 隔离探针新增断言（档 3；当前缺口）

现状：`tools/probe-host.mjs` 只断言 4 件事——合成树含 aikanban 行（`:275-286`）、profile 解析并激活（`:288-333`）、宿主发布 `window.__DSH_BOOT__` 行并服务 client.js（`:343-443`）、宿主进程内发布 `aikanban:activation`（`:445-463`）；**没有任何断言证明 `registerBoardChannel` 被调用**。A 完成后必须新增：

1. `tools/probe-host.mjs` 生成的观察者（`:353-359`）同时订阅 `aikanban:board-channel`，把 payload 写成 `[probe] BOARD-CHANNEL <json>` 行（与 ACTIVATION 同模式）。
2. 第 4 步增加第 5 项检查：等到 `[probe] BOARD-CHANNEL` 行且 `registered===true && channel==='/aikanban'` → `record('host half registered /aikanban via registerBoardChannel', true, …)`；超时/失败 → `false`（不是 SKIP）。
3. 若观察者 preload 被宿主拒绝（现有 `observerUnavailable` 分支 `:456-459`）：写 `observations`「未观察」并保持“不冒充已验证”，不得写 PASS。
4. 现有 4 项检查与退出码语义不变（`:443-489`）；新增检查通过后 README/验收记录引用的是**新增后的探针输出**。

### 7.3 门禁（A 的定义性完成判据，全部要贴原始输出）

| # | 判据 | 命令/方式 |
| --- | --- | --- |
| A-G1 | typecheck/build 通过 | `pnpm run typecheck`、`pnpm run build`（根 README 命令） |
| A-G2 | 测试全绿且新增集成测试在列 | `pnpm -r --if-present run test`；记录 core/plugin/plugin-client 用例数（当前 66/38/45=149，更新后据实） |
| A-G3 | `verify-host-import` **11/11 不退化** | `node tools/verify-host-import.mjs`（`:225-335`） |
| A-G4 | 探针新增断言通过 | `node tools/probe-host.mjs`（§7.2；输出含新检查 PASS） |
| A-G5 | 代码事实核对 | `git status` 只含本切片改动；未改 `docs/prd/**`、未改产品语义 |

**A 完成 ≠ F01/F02 验收**：AT 全部「待执行」；`implementation.md`/`verification.md` 的更新与 AT 执行按[验收执行规则](acceptance-execution.md)另做。A 的测试/探针只能作为档 2/档 3 辅助证据。

## 8. 未定与风险（需真实 profile / 实施第一步取证）

1. **真实 Connection RPC 网络往返**：本仓库只能做协议级往返（真实构建产物 + 契约信封）；`requestRejection`（Host/Origin/token）与真实页面↔宿主跳转需写 profile 并重启，未验证（ADR-005 `:88-98`，状态仍 `提议`）。A 的探针只能证明“宿主内注册发生”，不能证明网络可用。
2. **浏览器真实渲染**：无 DOM 环境测试；面板在真实 GUI 的渲染/键盘仍待档 1（ADR-004 仍 `提议`）。
3. **`ctx.storageDomain.open` 是否接受裸 spec**（§5.2）：未确认；若必须 `defineDomain` 包装，需在 ADR-007 修订里选择替代，不得引入裸 specifier。
4. **`tsc -b` 对 core 源导出引用的解析**（§5.3）：未确认；可能出现 TS6305/TS6059，修法已给。
5. **`workspaceRegistry` 精确返回形状/lifecycle**（§5.4）：ADR-003 只给了方法名与部分实测；`get`/`list` 返回值字段需实现时核对。
6. **cordis 生命周期钩子**（关闭 domain/注销通道）：未确认；A 先按进程级生命周期，记录局限。
7. **connection 服务相对 apply 的到达时机**：可能晚于 apply；已按 `internal/service` 重试+重发信号设计，但真实顺序需探针观察（快照里的 `boardChannelRegistered` 可能先 false 后 true，探针必须等最终态）。
8. **同一次状态+排序的两写**：core 对 `setTaskStatus({toIndex})` 先写列偏好再写状态（`planning.ts:1300-1315`）；若第二步失败，卡片位置偏好已变但状态未变。A 按 core 现状映射（失败报 `save-failed`，正式状态不变）；产品可接受性已由 F02-R04 的“保存失败保留正式原状态与顺序”约束（但两者不同写，需在验证时如实记录该边界）。
9. **切片 A 无项目选择 UI**：A 的界面只能显示选择空态；若评审要求“A 可演示 S1 闭环”，需把 B 的 `project/list` 前移——本规格按任务书“A 固定 4 端点”执行，不擅自扩大。

## 9. 切片 B 扩展清单（归属：B；A 不实现）

### 9.1 wire（`wire.ts`）

| 项 | 内容 |
| --- | --- |
| 端点 | `BOARD_ENDPOINTS` 增 `projectList:'project/list'`、`taskCreate:'task/create'`、`taskFieldsUpdate:'task/fields.update'`、`activityRead:'activity/read'`（`:96-101`） |
| payload/value | `ProjectListPayload {}` → `{projects:[{projectId,title,path}]}`；`CreateTaskPayload {projectId,requestId,title,goal?,initialStatus?,blockedReason?}` → outcome 值（含 `keptInput`）；`UpdateFieldsPayload {taskId,requestId,expectedFieldsVersion,expectedStatusVersion,title?,goal?}` → outcome；`ActivityPayload {scopeKind,scopeId,limit?}` → `{entries:[…]}` |
| 解析器 | 与现有 `parse*` 同风格（`:454-540`），全部先校验再进适配器 |
| 失败码 | 增 `invalid-input`（§6.3） |

### 9.2 host 侧（`board-channel.ts` + 适配器）

`HostBoardPort`（或并列的 `HostManagementPort`）增：`listProjects()`, `createTask(input)`, `updateTaskFields(input)`, `readActivity(input)`；handler 同样四段式（parse → 校验 → port → 映射失败，永不全抛），pattern 照 `:145-212`。

core 映射：

| 方法 | core（行号） | 关键映射 |
| --- | --- | --- |
| `listProjects` | 宿主 `workspaceRegistry.list()`（ADR-003 W1）；core `listProjects()` `planning.ts:928` 只用于“已登记”补充 | 列表来自宿主；每项 `projectId=workspace.id`、`title`、`path`；**不写选择** |
| `createTask` | `planning.ts:451`；`types.ts:482-504`、`:507-510` | `requestId`=UI 铸的 operationId；先按 §3.1 确保项目已登记；`keptInput` 原样回给 UI；`already-created` 返回既有任务（REC-02） |
| `updateTaskFields` | `planning.ts:620`；`types.ts:525-566` | `expected:{fieldsRevision,statusRevision}`；`title?/goal?`；`saved/no-change/already-applied/baseline-changed/rejected/failed` → wire 码（baseline→stale，unknown-task→not-found，invalid-title→invalid-input，failed→save-failed） |
| `readActivity` | `planning.ts:1176`；`types.ts:235-243` | scopeKind `task`/`project` 直通；`details` 的 `Record<string,string>` 原样（wire 传输 JSON） |

### 9.3 浏览器侧

`BoardSource` 增四个方法（`source.ts:153-172` 后面追加，保持端口分组）；`channel-source` 对应四端点；`controller` 增：`loadProjects()`、`createTask()`、`updateTaskFields()`、`loadActivity()`、选择状态机（`selection-required` → 选择 → `ready`）；`board.tsx` 增：项目选择器（含路径辨识）、新建任务表单（`keptInput` 就地回显）、详情内联编辑（失败留草稿，暂不接字段草稿槽也可，按 F01-R05 最低集）、活动历史区。**选择不持久化**（§2）。

### 9.4 B 的测试

扩 `board-adapter.test.ts`（四端点成功/失败/幂等/`keptInput`/基线/活动排序）、`controller.test.ts`（选择流程、创建/编辑/历史状态机）、`model.test.ts`（表单/选择器视图模型）、`wire.test.ts`（新 payload 校验）；`channel-roundtrip.test.ts` 扩协议往返；`probe-host.mjs` 只需已有的注册断言（B 不新增宿主依赖）。

### 9.5 B 完成判据

在 A-G1…G5 基础上：新增四端点的集成/协议测试全绿；F01 的 AT-02/AT-107/AT-108 等**仍未执行**，等 `verification.md` 的档 1 证据；B 完成不等于 F01 验收通过。

## 10. 参考

- 产品规则：[F01 PRD](../prd/features/F01-project-and-tasks/prd.md)、[F02 PRD](../prd/features/F02-task-status-and-cards/prd.md)；现状盘点：[F01 implementation](../prd/features/F01-project-and-tasks/implementation.md)、[F02 implementation](../prd/features/F02-task-status-and-cards/implementation.md)
- core 契约：[packages/core/README.md](../../packages/core/README.md)（F01 契约 `:177`、F02 契约 `:276`、PRD 对照 `:338-353`）
- 通道与宿主：[ADR-005](decisions/ADR-005-浏览器半与宿主半的数据通道.md)、[ADR-003](decisions/ADR-003-project-mapping-and-context-injection.md)、[宿主能力合同](host-capabilities.md)
- 决策与状态：[ADR-007](decisions/ADR-007-s1-wiring-and-current-project.md)、[交付状态](../delivery/status.md)、[验收执行规则](acceptance-execution.md)
