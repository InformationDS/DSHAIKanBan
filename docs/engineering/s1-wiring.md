# S1 接线设计与实施规格（切片 A / 切片 B）

> **本文是实施前置规格，不是实现记录，也不是验收记录。** 切片 A **尚未开工**：本页只把「已有代码 → 可运行的 S1 接线」的接口、映射、改动面、测试与证据判据写到可直接实施的程度。决策依据是 [ADR-007](decisions/ADR-007-s1-wiring-and-current-project.md)（**已定**：设计经用户确认、工程证据待取证）；用户已拍板 **Q1＝B（当前项目每次显式选择、不持久化）**、**Q2＝A（扩展 wire/BoardController 契约，不在适配层弱化 F02-R04/SAVE-05）**。本文回应独立评审指出的接线类前置条件（B1/B2/H1/H2）；评审原文不在仓库，本文只按任务书转述的范围落规格，不替评审定义编号含义。
>
> **证据边界**：所有代码引用均来自当前工作区（`main`，HEAD `392e693` 起点）的真实文件，行号已逐条核对；未能用仓库内材料证实的点标「**未确认**」。**AT 全部仍是「待执行」**：本文与未来切片 A/B 的单元/集成测试都不能当作 F01/F02 的验收证据；验收按[验收执行规则](acceptance-execution.md)与各功能 `verification.md` 执行。

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
| A2 | `packages/plugin/src/index.ts` | `HostContext` 补 `storageDomain`/`workspaceRegistry`/`connection`；`apply()` 中同步探测并注册通道；`ActivationSnapshot` 补通道/数据层字段；**同步扩 `createStatusTool` 的 output schema**（`additionalProperties:false` 下新字段必须进 `properties`，且 `required` **含全部字段**；nullable 只影响值 schema 用 `oneOf`，`packages/plugin/src/index.ts:226-246`）；新增 `aikanban:board-channel` 诊断事件；再导出适配器 | `HostContext:167-172`；`ActivationSnapshot:102-121`；`apply():305`；通道再导出 `:406-418` |
| A3 | `packages/plugin/src/board-channel.ts` | 按新契约改 payload 提示文案/校验（端点集合不变）；**`ver1:` 基线由 handler 前置校验**（`BoardRpcResult.error.code` 是 `string`，可返回 `invalid-payload`；`HostWriteFailure.code` 仍是 8 个浏览器码、适配器不返回该码，§4.2/§6.2）；`registerBoardChannel` 的 `rpc.handle` 包 try/catch，失败返回 `{ok:false, reason:'register-failed'}`（扩展 `BoardChannelRegistration` 的 reason 联合 `'no-connection' \| 'register-failed'`，`:244-246`）；**不改** `HostReadSuccess/HostWriteSuccess.snapshot` 的非空类型（`:67`、`:83`）；handler 永不全抛 | `createBoardChannelHandler:145-212`；`registerBoardChannel:256-275` |
| A4 | `packages/plugin/package.json` / `tsconfig.json` / `pnpm-lock.yaml` | 加 `@aikanban/core` 依赖（`devDependencies`）与 project reference；**新增依赖后必须在同步盘之外的构建沙盒跑非 frozen 的 `pnpm install`（只执行 COMMANDS `:57` 那一条，绝不执行 `:56` 的 `cd` 行——那是同步盘主仓库），把生成的 `pnpm-lock.yaml` 复制回主仓库并提交**；此后 `--frozen-lockfile` 基线才成立（正确命令原文见 §7.3 A-G0） | `packages/plugin/package.json:56-58`；`packages/plugin/tsconfig.json:13`；[tools/COMMANDS.md](../../tools/COMMANDS.md) §10.2 `:196-217`、§2 安装命令 `:56-57` |
| A5 | `packages/plugin-client/src/wire.ts` | `projectId` 必填；写 payload 携带编码后的基线；读快照补 `undoTarget`/版本字段；解析器收紧（`parseReadBoardPayload` 必须拒绝缺省，`:447-460` 的旧注释删除） | `ReadBoardPayload:113-117`（注释“Absent means the current project”必须改）；写 payload `:119-146`；快照 `:153-162` |
| A6 | `packages/plugin-client/src/source.ts` | `BoardSource.readBoard(projectId)`；写输入补 `expectedStatusVersion` 必填与 `appliedUpdateId`；`UndoToken` 语义；**`readBoard` 旧注释（`:161` “for the current project”）要改** | `BoardSource:153-172`；输入 `:36-68`；旧注释 `:161` |
| A7 | `packages/plugin-client/src/channel-source.ts` | **唯一签名**：`BoardSource.readBoard(projectId: string)` 每次传参（source 构造不再接收 `projectId`）；payload 每次组装；无选择由 controller 拦截、source 不接受空 id；**未知结果文案不得写“后重试”**（`channel-source.ts:170` 改为“请先核对当前正式状态，不要重复提交”） | 旧构造选项 `:114-120`；`readBoard:136-155`；写 `:195-223`；未知结果文案 `:170` |
| A8 | `packages/plugin-client/src/controller.ts` | 新增 `selection-required` 读状态与 `resetSelection()`；**`load()`**（无参，由 state 的选择驱动）语义；状态/排序/撤销发送基线；`UndoToken` 带 `{statusVersion, appliedUpdateId}` 且**只从写后快照取**；**写后失败（`unknown-result` **与**写后 `read-failed`）一律不保留写重试意图，改 `retry:{kind:'read'}`**（§4.4 第 8/9 条）；删除 `BoardState.selectedProjectId` 旧注释与 `BoardControllerOptions.projectId`（选择唯一真相源＝state） | 读状态联合 `:94-117`；`BoardState.selectedProjectId:148-149`；`BoardControllerOptions.projectId:223`；`load:542-598`；变更输入 `:521-527`、`:684-691`；撤销 `:731-740`；token `:80-83`；重试意图 `:72-77`、`retryPending:709-729` |
| A9 | `packages/plugin-client/src/model.ts` / `board.tsx` | 模型补 `statusVersion`/`undoTarget`；`BoardPanel` 挂载时先 `controller.resetSelection()` 再决定是否 load（无选择不读）；面板渲染选择空态、按 `undoTarget` 显示撤销；**`retry.kind==='read'` 的按钮文案为「重新读取」**（未知结果只允许重读，不自动重发写） | `model.ts:119-146`；`board.tsx:403-483`；`BoardPanel` 挂载 `:492-505`；重试按钮 `:373-381` |
| A10 | `packages/plugin-client/src/runtime.ts` / `index.tsx` | 选择**不持久化**且**唯一真相源＝`BoardController.state`**：删除 `runtime.selectedProjectId` 与 `setSelectedProject`；`getBoardController()` 以无选择状态创建；每次面板挂载由 `resetSelection()` 归零；`apply()` 装配 source 时不需要项目 | `runtime.ts:28-30`、`:52-61`、`:68-71`；`index.tsx:199-214` |
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
- 浏览器半当前没有任何持久化：全 `packages/plugin-client/src` 无 `localStorage`/`sessionStorage`/`cookie`/`indexedDB`（已 grep 核对，`NONE`）；`runtime.ts:30` 现在还有一份 `selectedProjectId` 内存副本，**A10 会删除它**（见 §2.2 的唯一真相源规则）。这符合 Q1=B，不需要“移除旧持久化”。
- **`workspace.status()` 的真实形状**（安装包声明，已确证）：`status(): Promise<'ok' | 'missing-dir'>`——**只有两个值、且返回 Promise**。证据：`~/.dsh/profiles/node_modules/@deepseek-ai/dsh-workspace/lib/types/entity.d.ts:73`、`~/.dsh/profiles/node_modules/@deepseek-ai/dsh-workspace/lib/types/types.d.ts:98`；实现 `lib/index.js:154-160` 的 `async status()` 返回 `'ok'|'missing-dir'`。ADR-003 W6（`:32`）只记录了“目录缺失时返回 `'missing-dir'`、记录仍保留”的语义，**没有记录 Promise 形状，也没有 `unknown` 值**。本规格中“未观测”是**我们自己的展示状态**（映射到 core 的 `WorkScopeAvailability.unknown`），不是宿主返回值。
- **不得**把选择塞进已有的位置保存：core 的 `saveBoardPosition`（`planning.ts:1012`）与 `ProjectFields.position`（`types.ts:312-316`、`:341-358`）是**每个项目自己的看板内位置**，不是“哪一个项目处于打开状态”；`readBoard` 的 `boardToken` 也把 position 计入（`planning.ts:1098`）。把选择写进去会让“进入即恢复上次项目”，直接违反 Q1=B。

### 2.2 规则

1. **每次进入看板都必须显式选择项目**：面板挂载时初始 `read` 状态为 `selection-required`（新增状态，见 §4.4），**不发 `board/read`**；选择来自 B 的 `project/list` UI。
2. **选择只存在本次页面会话的内存，唯一真相源＝`BoardController.state.selectedProjectId`**；`runtime` 不得再保存第二份（A10 删除 `runtime.selectedProjectId`/`setSelectedProject`）。刷新、重开页面、重进座位一律回到 `selection-required`：`BoardPanel` 每次挂载先调 `controller.resetSelection()`（清空选择/旧视图，不读 source），然后等待用户显式选择（B 的选择器）或测试调用 `selectProject(id)`。不写 profile、不写 core、不写浏览器存储、不记忆“上次选择”。
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
2. **唯一最终签名：`BoardSource.readBoard(projectId: string)` 每次传参**。删除“`createChannelBoardSource` 构造参数必填”的方案（二选一已收敛为此方案）：source 的构造只接收 channel/transport，不再持有“当前项目”；`channel-source` 每次 `readBoard` 时组装 `{ projectId }`。`apply()` 装配 source 时尚无项目可选是**正常状态**（source 存在、尚无读取）；任何读取都必须由用户选择后经 controller 传 id，缺 id 属编程错误，host 侧以 `invalid-payload` 拒绝（不猜项目）。
3. controller 的 `selection-required` 状态发生在调用 source **之前**；`load()` 在没有选择时只切状态，不发请求。
4. 该改动是**破坏性契约变更**：会改到的既有测试见 §4.5；旧语义清理清单见 §2.4。

### 2.4 旧语义清理清单（实施 A8/A10 时逐条删除或改写）

| 位置 | 现状（旧语义） | A 后 |
| --- | --- | --- |
| `packages/plugin-client/src/controller.ts:148-149` | `BoardState.selectedProjectId` 注释「null means the data layer's current one」 | 改为「null＝尚未选择（selection-required）」；这是**唯一真相源** |
| `packages/plugin-client/src/controller.ts:223` | `BoardControllerOptions.projectId`：「null/absent asks the data layer for its current project」 | **删除该选项**（面板每次挂载归零；测试改用 `selectProject`） |
| `packages/plugin-client/src/runtime.ts:52-61` | `setSelectedProject` + `selectedProjectId`：「The host resolves the current project when this is null」 | 删除函数与变量；runtime 只持有 source/controller |
| `packages/plugin-client/src/wire.ts:447-449` | `parseReadBoardPayload` JSDoc：「An omitted payload is legal (the host resolves the current project)」 | 改为：payload 必须带非空 `projectId`，缺省/空串返回 `null`（host → `invalid-payload`） |
| `packages/plugin-client/src/wire.ts:113-117` | `ReadBoardPayload.projectId` 注释「Absent means "the current project"」 | 改为必填字段；删除“current project”语义 |
| `packages/plugin-client/src/source.ts:161` | `BoardSource.readBoard` 注释「Read the whole board for the current project.」 | 改为「Read the whole board for the **explicitly selected** project.」；无选择时 controller 不调用 |
| `packages/plugin-client/src/controller.ts:85-93` | `BoardReadState` 注释只列 idle/loading/ready/failed/unknown-project，无 `selection-required` | 在注释中补 `selection-required`（未选择、不读 source、与 failed/unknown-project 的区别） |

### 2.5 对切片 A 的直接后果

A 没有 `project/list`，所以 A 的面板只能停在 §2.2 的第 4 条空态；**A 的集成测试显式传 `projectId` 驱动 handler**，不通过 UI 选择。演示“选择项目 → 看板”必须等 B。这是评审 B1 里“切片顺序”的硬约束，不得在 A 里提前造一个假的列表或默认项目。

## 3. 协议字段映射（host 适配层；A1 的准绳）

### 3.1 `board/read` 三态与项目解析

core `readBoard` 三态：`ok`/`unknown-project`/`failed`（`types.ts:441-463`；实现 `planning.ts:1059-1121`）。适配流程（每次 `board/read`）：

1. `projectId` 来自 payload（必填）；禁止任何 fallback。
2. 用宿主 `ctx.workspaceRegistry.get(projectId)` 解析 workspace（ADR-003 W1）；取不到 → 返回 `HostReadFailure{code:'unknown-project', message:'项目不存在或尚未在此工作区登记'}`（**不是空看板**）。
3. `workspace.path` 为空 → `unknown-project`（core `registerProject` 拒绝空 path，`planning.ts:867-871`）。
4. 调 `core.registerProject({projectId: workspace.id, title: workspace.title, path: workspace.path})`（`planning.ts:862`）：`registered`/`refreshed`/`unchanged` 继续；`rejected` → `unknown-project`（invalid-input）或 `read-failed`（其余）。
5. 调 `core.readBoard({projectId, workScope: hint})`（`types.ts:574-577`）。`hint` 必须来自**真实观测**：`await workspace.status()` 返回 `Promise<'ok'|'missing-dir'>`（§2.1 已确证），把 `'ok'→ok`、`'missing-dir'→missing-dir` 写入 `hint.availability`；**只有拿不到观测时**（workspaceRegistry 服务缺失，或 `status()` 调用 reject/超时）才用 core 的第三值 `unknown` 表达「未观测」——这是本适配层的显示状态，**不是宿主返回值**，不得写成“宿主返回 unknown”。**只作为本次展示提示，不落库、不调用 `observeWorkScope`**（读取不写；`planning.ts:389-390` 已支持 display hint）。
6. `ok` → 映射快照（§3.2）；`unknown-project` → 同码失败；`failed` → `read-failed`。

### 3.2 快照字段映射（core → `BoardSnapshotValue`）

宿主侧参照：`ProjectView`（`types.ts:419-429`）、`TaskView`（`:368-405`）、`BoardColumnView`（`:432-438`）、`BoardReadResult`（`:441-463`）；wire 侧目标：`BoardSnapshotValue`（`wire.ts:153-162`）、`BoardProjectView`（`model.ts:165-173`）、`BoardTask`（`model.ts:119-146`）。

| wire 字段 | 来源 | 规则 |
| --- | --- | --- |
| `project.projectId` / `title` | `ProjectView.projectId/title` | 原样 |
| `project.path` | `ProjectView.path` | 原样（项目路径，非“范围可用性”） |
| `project.workScopeAvailability` | 适配层从 `await workspace.status()` 推导后传入 core，再读 `ProjectView.workScope.availability`（core 三值 `types.ts:408-416`） | `'ok'→ok`、`'missing-dir'→missing-dir`；观测失败才用 `unknown`（**未观测**，非宿主值）；`unknown` 不得当“无范围” |
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

- **统一编码**：`statusVersion = 'ver1:' + statusRevision.toString()`，只允许非负整数（例：`ver1:0`、`ver1:7`）。解析用严格正则 `^ver1:(0|[1-9]\d*)$`。
- **校验位置（定稿，F5）**：**host handler 在调用 `HostBoardPort` 之前前置解码/校验**（wire 的 `parse*` 只做 JSON 形状校验）。不合法/缺失的 `expectedStatusVersion` 不是“默认 0”：handler 直接返回 `invalid-payload`（`BoardRpcResult.error.code` 是 `string`，见 `board-channel.ts:121-126` 的 `BoardRpcResult`）——**不能**让适配器返回它，因为 `HostWriteFailure.code` 的类型是 `BoardFailureCodeWire`（只有 8 个浏览器码，`board-channel.ts:89-95`），塞 `invalid-payload` 类型不合法。浏览器侧把不认识的 host 写码按既有规则归为 `save-failed`（`channel-source.ts:173-180`），因此**用户可见结果为 save-failed、正式值不变**；不得新增第 9 个浏览器失败码来区分它。
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
4. **撤销入口与 token 基线来源**：成功横幅撤销保留；详情/卡片在 `task.undoTarget !== null` 时显示撤销（由 `undoTarget` 驱动，刷新后仍可撤销）。**`UndoToken` 只能由写后返回的快照构造**（`snapshot.tasks` 中该任务的 `undoTarget`），不得由写前值或本次输入拼装；快照中没有该任务或 `undoTarget === null` → 不显示撤销。撤销发送 `undoTarget.statusVersion` 与 `undoTarget.appliedUpdateId`；`operationId` 为本次撤销**新铸**（重试复用同一个）。
5. **新增读状态** `selection-required`（§2）：`BoardReadState` 增 `{kind:'selection-required', message}`；新增 `resetSelection()`（清空选择/视图/对话框，置 `selection-required`，**不读 source**）；`load()` 无选择 → 设置该状态并返回；`selectProject(id)` 记录内存选择并读取；`selectProject(null)` 回到该状态。**选择唯一真相源＝`BoardState.selectedProjectId`**。
6. `runtime`：**删除** `selectedProjectId` 与 `setSelectedProject`（旧语义清理见 §2.4）；`getBoardController()` 以无选择状态创建 controller；`setBoardSource` 仍负责丢弃旧 controller（换源＝换世界）。**不得**新增任何持久化。
7. `BoardPanel` 挂载规则：每次挂载先 `controller.resetSelection()`（A9），因此缓存的 controller 也不会沿用上次项目/旧看板；随后若仍无选择就停在 `selection-required`，不自动 load（现有“仅 `read.kind === 'idle'` 时 load”的行为被替换，`board.tsx:502-504`）。B 的选择器负责调用 `selectProject(id)`。
8. **写后失败的重试政策（F9/F10/D6/F5 文案）**：任何写得到 `unknown-result`（含适配器重读失败、传输异常）**或写后 `read-failed`**（`no-change` 重读失败）时，controller **不得保留写重试意图**，而是把 feedback 的 `retry` 设为现有读重试形态 `{kind:'read'}`（与读失败分支同形，`controller.ts:573`）；`retryPending` 的 `read` 分支只执行 `this.load()`（`:709-716`），**不会重发写**；`board.tsx` 在该形态下把按钮文案改为「重新读取」（现为「重试」，`:373-381`），读回后由用户重新发起操作。**这是 A 的代码改动项**：`channel-source.ts:170` 的未知结果文案不得再写“后重试”，改为“请先核对当前正式状态，不要重复提交”（A7）。**reorder 尤其禁止自动重试**：它虽有 `requestId` 与 `statusRevision` 校验（`planning.ts:1355-1357`、`:1376-1383`），但**没有 order 级基线**（§8 第 11 条），并发排序在不改 `statusRevision` 时检测不到，重发可能覆盖别人的顺序。
9. **重读失败的分类与 message 模板（F3，REC-01）**：写成功后的统一重读若失败，按“是否已生效”分类：
   - `saved` / `already-applied`（**已生效**但拿不到快照）→ `unknown-result`（不带 snapshot）；message 必须写“**已保存、视图未刷新**”。
   - `undone`（**撤销已生效**但拿不到快照）→ `unknown-result`；message 必须写“**撤销已生效、视图未刷新**”；**不得**用 `read-failed`（`controller.ts:207-208` 的“未做任何修改”违反 REC-01）。
   - `no-change`（**确实没有正式变化**）→ `read-failed`（保留旧视图+重试是诚实的）；该失败同样**只保留 `{kind:'read'}` 重试意图**（A8/A9）。
   - 三种 message 模板按结果分级，不得对 `saved` 套用“撤销已生效”。

### 4.5 要改的文件与受影响的既有测试

改文件见 §1.1 A5—A10。**计数与红/绿判据（定稿，F12）**：

- **当前门禁下真正会红的 2 个**：`channel-roundtrip.test.ts`（经真实构建产物解析固定快照，`statusRevision` 缺失即解析失败）与 `controller.test.ts`（fake source 直接喂快照、写前取基线时拿不到 `statusRevision`）。
- **类型层必改的 2 个**：`model.test.ts`（`task()` helper 返回 `BoardTask` 字面量，`statusRevision` 改必填后**类型错误**）与 `host.test.ts`（`ActivationSnapshot` 新字段使字面量/快照类型错误，且要**新增** schema 哨兵与通道注册用例）。**测试文件不被 `tsc -b` 检查**（各包 tsconfig 只 include `src/**`），所以当前门禁不会因此变红，但**若未来 CI 把测试纳入 typecheck，必改集合扩到 4**。
- **仅回归确认**：`client-bundle.test.ts`、`slots.test.ts`。
- **回归基线**：`packages/core/test/*`（66 用例，不改 core 语义）。

| 测试文件 | 类别 | 受影响点 |
| --- | --- | --- |
| `packages/plugin/test/channel-roundtrip.test.ts`（12 用例） | **必改（当前会红）** | 固定快照没有 `statusRevision`/`undoTarget`（fixtures `:51-85`），真实适配器解析会失败；source 构造不再带 `projectId`（`:209`），读取改为每次传 id（`:215`）；写 payload 断言新增必填基线 |
| `packages/plugin-client/test/controller.test.ts`（19 用例） | **必改（当前会红）** | fake source 的 `readBoard` 无参（`:97-100`）、`controllerFor` 传 `projectId` 选项（`:120-127`，选项将删除）；fixture 任务缺 `statusRevision`（`:43-54`）导致写前取基线失败；新增 `selection-required`/挂载重置/撤销凭据/**未知结果只重读**用例 |
| `packages/plugin-client/test/model.test.ts`（19 用例） | **必改（类型层，当前不红）** | `task()` helper 返回 `BoardTask` 字面量（`:40-51`），`statusRevision` 改必填后类型错误；补 `statusRevision`/`undoTarget` 断言 |
| `packages/plugin/test/host.test.ts`（19 用例） | **必改（类型层 + 新增用例）** | `ActivationSnapshot` 新字段使手写字面量需补（`:173-183`、`:255-265`、`:286-297`）；**新增** output schema 哨兵（字段覆盖，§7.1 第 9 条）与通道注册事件用例；既有 `checkSchema` 用例本身不因缺字段而红 |
| `packages/plugin/test/client-bundle.test.ts`（7 用例） | 仅回归确认 | 预期不改逻辑；若 bundle 导出面变化需同步，否则只跑绿 |
| `packages/plugin-client/test/slots.test.ts`（7 用例） | 仅回归确认 | 座位注册不受影响，只跑绿 |
| `packages/core/test/*`（66 用例） | 回归基线 | 不受影响；作为“不改 core 语义”的回归基线 |

**新增测试**（至少）：
- `packages/plugin/test/board-adapter.test.ts`（新）：真实 `createKanbanCore` + `createMemoryStoragePort(createMemoryMedium())`（`packages/core/src/index.ts:16`、`port.ts:101-121`）经真实 `createBoardChannelHandler` 打通四端点；覆盖成功/失败/未知结果/不抛异常（§7.1）。
- `packages/plugin-client/test/wire.test.ts`（新）：`ver1:` 编解码、必填校验、非法基线拒绝、`undoTarget` 解析。
- controller 新用例：无选择不读、选择后读、基线发送、撤销凭据来源、刷新后可撤销。

## 5. 启动链路与依赖边

### 5.1 顺序（apply 同步 + 数据层异步）

1. **`apply(ctx)` 同步阶段**（不得改动现有加载链语义；`verify-host-import.mjs:292-321` 依赖 `apply` 同步发布激活信号）：
   1. 现有：logger 标记（`packages/plugin/src/index.ts:334`）、探测 `tools`/`systemPrompt`（`:337-373`）、`internal/service` 重试（`:379-382`）。
   2. **新增探测**：`connection`、`storageDomain`、`workspaceRegistry`，各自 `ctx.reflect?.get(name,false)`；与现有 `internal/service` 重试同构（不新增 `inject`，避免缺服务把 fiber 卡死——与 `packages/plugin/src/index.ts:280` 及 `packages/plugin-client/src/index.tsx:99-105` 的既有理由一致）。
   3. **`connection` 就绪 → 立即 `registerBoardChannel(connection, port)`**（`board-channel.ts:256-275`）。两条健壮性规则：
      - `registerBoardChannel` 内部的 `connection.rpc.handle(...)` 必须包 **try/catch**；抛错时返回 `{ok:false, reason:'register-failed'}`（A3 扩展 `BoardChannelRegistration` 的 reason 联合 `'no-connection' | 'register-failed'`，`board-channel.ts:244-246`），**不得**让异常冒到 apply。
      - `port` 是**延迟就绪适配器**：数据层未好时每个方法返回显式失败（`unavailable`/`read-failed`），绝不抛；因此通道可以先注册。
   4. 注册结果写入 `ActivationSnapshot.boardChannelRegistered/boardChannel`，并发布 `aikanban:board-channel` 诊断事件（payload reason 只用 `'no-connection'|'register-failed'|null`，§5.5/§7.2）。然后发布激活信号（沿用 `packages/plugin/src/index.ts:384-392`）。
   5. **异步引导**：`void bootstrap().catch(...)`（**必须 catch**：未处理的 Promise rejection 可能杀进程/被宿主当作崩溃）：
      - 已在运行则不重复启动；`storageDomain` 服务**晚到**时在 `internal/service`（`name==='storageDomain'`）上重试启动（与 `tools`/`systemPrompt` 同构，`packages/plugin/src/index.ts:379-382`）。
      - `ctx.storageDomain.open(spec)` → `createKanbanCore({port: createStorageDomainPort(domain)})` → 置 `dataLayerReady=true` 并重发激活信号/事件。
      - 任一失败：记录原因、保持 `dataLayerReady=false`，所有读取返回 `read-failed`（消息含原因）；不得让 apply 抛错、不得伪造空看板。
2. **每个 `board/read` 前的项目登记**：按 §3.1 第 2—4 步 `registerProject`（一次写；同项目后续为 `unchanged` 不写，`planning.ts:874-878`）。
3. **关闭**：宿主卸载时若可取得 disposer，关闭 domain 并注销通道（`registerBoardChannel` 返回的 `dispose`，`board-channel.ts:244-275`）。**cordis 4.0.2 没有 `on('dispose')` 事件**，实际应使用 `ctx.effect(...)` 注册拆除（倾向 `ctx.effect`，其拆除语义**未确认**）；A 先按“进程级生命周期不主动关闭 domain”实现，在探针里观察卸载行为并记录局限。

### 5.2 core 域规格的构造（zod 依赖问题）

- core 要求宿主用**自己的** validator 构造 spec：`buildDomainSpec(zod: ZodLike)`（`domainSpec.ts:249-288`；`DomainSpecLike` `:259-265`），域层实际只调用 `valueSchema.parse`（ADR-002 实验把它写成 `{ parse: value => value }`，`packages/core/experiments/storage-domain-atomicity.mjs:77-78`）。
- host 半**不能** import `zod` 或 `@deepseek-ai/dsh-storage-domain`（裸 specifier 会让 `verify-host-import.mjs:265-276` 失败）。注意措辞：**源码层** `board-channel.ts:42-58`（specifier 在 `:58`）import 了 `@aikanban/plugin-client/wire`，只有 tsdown 的 `alwaysBundle`（`tsdown.config.ts:42`）把它内联后，**打包产物 `lib/index.js` 的导入图**才只剩相对路径与 `node:` 内建。门禁检查的是**打包产物**，不是源码。
- **A 的实现选择**：在 host 半内部实现一个**结构校验器 shim**（仅 `custom(check) → { parse(value){ if(!check(value)) throw …; return value } }`）传给 `buildDomainSpec`，再调 `ctx.storageDomain.open(spec)`。core 的校验函数本身已导出（`isScopeStateRecord`/`isDraftRecord`，`domainSpec.ts:212/239`）。
- **spec 形状：已由安装包真实实现佐证（不再是「未确认」，F8）**。`@deepseek-ai/dsh-storage-domain/lib/index.js`：`defineDomain`（`:61-76`）**只做 descriptor 校验/规范化**并原样返回 spec；`open(spec)`（`:355-398`）消费 spec 的 `name/version/layout/tables/global/compatibleVersions`，经 `descriptorOf`（`:82-91`）投影后交给 backend（`:362`），记录校验调用 `tableSpec.valueSchema.parse(raw)`（`:371`）。自家实验的**执行**路径与该实现一致：`singleSpec`/`perRecordSpec` 里的 `defineDomain({...})` 调用在 `packages/core/experiments/storage-domain-atomicity.mjs:132`（`:41` 只是 `import` 行，不是执行路径），随后 `facility.open(spec)`（同文件 `:98`）；实验用只有 `parse` 的鸭子类型 validator（`:77-78`）即可打开真实域。因此 `buildDomainSpec(schemaShim)` 生成的裸 `DomainSpecLike` **按形状可被接受**；host 半不需要 import `defineDomain`。
- **仍保留的未实测项**：真实插件上下文里的 `ctx.storageDomain.open()` 未被实测（服务是否以同一形状暴露 `open`、失败时如何报错）。**取证方式**：切片 A 的隔离探针/集成测试第一步打开域并做一次 `getDraft` 读；若上下文行为不符，不改产品语义，记录为阻塞并在 ADR-007 修订里选替代（例如宿主侧注入 defineDomain 能力），但**不得**静默引入裸 specifier。

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
| `workspaceRegistry?` | `{ get(id): WorkspaceLike \| undefined; list(): readonly WorkspaceLike[] }`；`WorkspaceLike` 至少 `{ id, title, path, status(): Promise<'ok' \| 'missing-dir'> }` | 项目解析/列表 | **新增**；`status()` 的 Promise/两值形状可由安装包声明核对（`dsh-workspace/lib/types/entity.d.ts:73`、`dsh-workspace/lib/types/types.d.ts:98`）；`get(id): Workspace \| undefined` / `list(): Workspace[]` 的**签名**可由 `dsh-workspace/lib/types/index.d.ts:85/:92` 核对，但 `Workspace` 的**运行时字段**与服务生命周期**未验证**——不写成整体已确证 |
| `effect?` | `ctx.effect(callback)` | 注册销毁（关闭 domain/注销通道） | **cordis 4.0.2 没有 `on('dispose')` 事件**；倾向用 `ctx.effect`，其拆除语义**未确认**，按 §5.1 第 3 步处理 |

`HostContext` 当前只有 `logger/reflect/on`（`packages/plugin/src/index.ts:167-172`）；以上全部**可选**，缺失时按失败可见处理，不得让 apply 抛错。

### 5.5 激活快照与诊断事件（供探针断言）

- `ActivationSnapshot`（`packages/plugin/src/index.ts:102-121`）增：`boardChannelRegistered: boolean`、`boardChannel: string | null`、`dataLayerReady: boolean`（数据层异步就绪后更新快照并重发激活信号；现有 `snapshot()` 闭包 `:316-327` 与 `getLastActivation():291` 的模式可复用）。
- **`createStatusTool` 的 output schema 必须同步（F2，因果已校正）**：它的 `output.schema` 是 `additionalProperties:false` 加显式 `required` 数组与 `properties` 表（`packages/plugin/src/index.ts:226-246`）。新增快照字段**必须加入 `properties`，且 `required` 要包含全部字段**（nullable 只影响该字段的**值 schema**：用 `oneOf: [{type:'integer'},{type:'null'}]` / `[{type:'string'},{type:'null'}]`，与现有 `pid` 写法一致，`packages/plugin/src/index.ts:241`；不得用 type 数组。遵守宿主支持的 schema 子集：单 `type` 字符串、`required` 为对象级数组、无 `format`/`examples`）。
  - **注册期**只跑 `assertSupportedJsonSchema`（`@deepseek-ai/dsh-tools/lib/index.js:322-325`，`:325` 抛 `JsonSchemaError`），**不会**检查字段是否覆盖 `ActivationSnapshot`；
  - **`ToolOutputError` 只在工具被调用、输出不满足 schema 时抛**（`dsh-tools/lib/index.js:2454` 定义、`:3418` 在输出校验时抛）——即“注册成功、调用才炸”，这是本地最容易全绿的真实盲区。
  - 因此**不能**指望 `host.test.ts:285` 的 `checkSchema`（只查关键字形状与 `required ⊆ properties`）或 `verify-host-import` 的 check11（`tools/verify-host-import.mjs:323-335` 直接 `execute`，绕过运行时校验）兜住；必须新增**运行时快照为基准的字段覆盖哨兵**（§7.1 第 9 条）。
- 新增诊断事件 `aikanban:board-channel`（常量导出，`node:diagnostics_channel`，与 `ACTIVATION_CHANNEL` `:60` 同风格；命名带 `[aikanban]` 前缀避免遮蔽 DSH 通道）。payload：`{ channel, registered, reason: 'no-connection' | 'register-failed' | null, at }`；`registerBoardChannel` 返回 `{ok:true}` 后发布 `registered:true, reason:null`。**`register-failed` 只存在于该诊断事件与 `BoardChannelRegistration` 的 reason 联合（A3 新增），不是浏览器失败码（F1）**：通道未注册/注册失败时 handler 根本不会被调用，浏览器侧实际表现为——读：传输失败 → `read-failed`（`channel-source.ts:141-150`）；写：传输失败/未知 → `unknown-result`（`:164-180`）。**`unavailable` 有两个来源**：① 浏览器没有 `connection` 服务时的本地空源（`createUnavailableBoardSource`，`source.ts:191-200`、`index.tsx:205`）；② host 延迟端口在**数据层未就绪**时返回该码（§5.1 第 3 步；`HostReadFailure/HostWriteFailure.code` 本就可取 `unavailable`，`board-channel.ts:71-95`）。
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
| `connection` 存在但 `registerBoardChannel` 的 `rpc.handle` 抛错（A3 `register-failed`） | 仅诊断事件，**浏览器不会产生该码**（F1） | `register-failed` 只写进 `aikanban:board-channel` 事件；未注册时 handler 不被调用，浏览器实际表现：读 → `read-failed`（`channel-source.ts:141-150`）、写 → `unknown-result`（`:164-180`） |
| payload 缺 `projectId`/协议违规 | `invalid-payload`（host 码）→ 浏览器 `read-failed` | A5 收紧后这是调用方 bug，仍不猜项目 |

**`unavailable` 的两个来源（F4，统一口径）**：① 浏览器没有 `connection` 服务时使用本地空源（`createUnavailableBoardSource`，`source.ts:191-200`、`index.tsx:205`）；② host 延迟端口在**数据层未就绪**时返回该码（§5.1 第 3 步；`HostReadFailure/HostWriteFailure.code` 允许 `unavailable`，`board-channel.ts:71-95`）。两处都会显式显示“数据层不可用”，绝不显示空看板。

### 6.2 写（`setTaskStatus` / `reorderTask` / `undoStatusChange`）

**统一回读策略（定稿）**：所有写端点成功后，适配器都**重读一次看板快照**再返回；`HostWriteSuccess.snapshot` 是**非空** `BoardSnapshotValue`（`board-channel.ts:83`），因此成功响应不可能返回 `{snapshot:null}`（wire 层的 null 容忍保留给未来宿主，A 不产生；A1/A3 均不改该非空类型）。`undoable` 一律由**写后快照**里该任务的 `undoTarget !== null` 计算（`TaskView.undoTarget` 见 `types.ts:385-391`；推导见 `planning.ts:274/289-292`），不由输入或写前值推断。

**四条定稿规则**（与 §4.4 第 8/9 条一致）：

1. **重读失败的分类与 message 分级（F3）**：`saved`/`already-applied`（已生效）→ `unknown-result`（不带 snapshot），message 写“**已保存、视图未刷新**”；`undone`（撤销已生效）→ `unknown-result`，message 写“**撤销已生效、视图未刷新**”；`no-change`（确实无变化）→ `read-failed`。均不得用 `read-failed` 的“未做任何修改”描述已生效的操作（违反 REC-01）。
2. **写后失败不自动重发（F9/F10/D6，含 `read-failed`）**：`unknown-result` **与写后 `read-failed`** 都不保留写重试意图，controller 只给 `{kind:'read'}`（按钮文案「重新读取」）；读回后由用户重新发起。**reorder 尤其如此**：它有 `requestId` 与 `statusRevision` 校验（`planning.ts:1355-1357`、`:1376-1383`），但没有 order 级基线（§8 第 11 条），重发可能覆盖别人顺序。
3. **基线格式错误由 handler 前置拒绝（F5）**：非法/缺失 `ver1:` **不进入 port**，handler 返回 `invalid-payload`（host 码；`BoardRpcResult.error.code` 是 `string`）；`HostWriteFailure.code` 仍是 8 个浏览器码，适配器不得返回 `invalid-payload`。浏览器按未知写码归 `save-failed`（`channel-source.ts:173-180`）。
4. **`save-failed + current` 的 current 合成（F6）**：core 的 `failed` 变体**不带 current**；适配器在映射 `save-failed` 时必须 `core.readTask(taskId)` 取当前 `status` 与 `statusRevision`，编码 `statusVersion='ver1:<n>'` 后作为 host failure 的 `details.current` 返回（handler 的 `detailsOf` 原样透传，`board-channel.ts:135-137`），否则浏览器只能显示无当前值的失败。

| 端点 | core 结果 | wire 码 / 成功值 |
| --- | --- | --- |
| 全部 | `saved` + 重读成功 | 成功 `{snapshot, undoable}`；`undoable`＝快照中该任务 `undoTarget !== null` |
| 全部 | `saved` + 重读失败 | **`unknown-result`（不带 snapshot）**：写已生效、结果未知，message 写“已保存、视图未刷新”（浏览器透传见 `channel-source.ts:173-180`）；**删除旧 `{snapshot:null}` 行**，禁止自动重发 |
| 全部 | `no-change` + 重读成功（`planning.ts:1240-1241`） | 成功；`undoable`＝快照 `undoTarget !== null`。**不是 false**：core 的撤销目标仍在（`planning.ts:274/289-292`），撤销依然有效 |
| 全部 | `no-change` + 重读失败 | `read-failed`（正式值未变；保留旧视图；**重试意图也只给 `{kind:'read'}`，不重发写**） |
| 全部 | `already-applied`（`planning.ts:1210-1213`） | 成功（同 `no-change` 的 `undoable` 规则）；重读失败 → `unknown-result`（已生效，message 写“已保存、视图未刷新”） |
| 全部 | `baseline-changed` | `stale-baseline` + `details.current:{status,statusVersion}`（`board-channel.ts:135-137`、`source.ts:89-95`） |
| `setTaskStatus` / `reorderTask` | `rejected/unknown-task` | `not-found` |
| `setTaskStatus` / `reorderTask` | `rejected/unknown-project` | `unknown-project` |
| `setTaskStatus` | `rejected/blocked-reason-required` | `invalid-reason`（wire 边界已先拒绝，`board-channel.ts:165-169`；core 仍兜底） |
| `setTaskStatus` | `rejected/invalid-status`、`invalid-input` | `save-failed`（不可映射为产品语义；message 原样带出） |
| `reorderTask` | `rejected/invalid-input`（缺 requestId/toIndex 等，`planning.ts:1355-1361`） | `save-failed` |
| 全部 | `failed/write-failed` | `save-failed` + `current`（正式值未变；**core `failed` 不带 current，必须由适配器 `readTask` 取 status 并编码 `ver1:<n>` 合成**，F6） |
| 全部 | 适配器/传输异常（未确认结果） | `unknown-result`（不重发） |
| 全部 | 非法/缺失 `ver1:` 基线 | **handler 前置校验**：host `invalid-payload`（`RpcResult.error.code` 是 string）→ 浏览器 `save-failed`；不进入 port、无写（F5） |
| `undoStatusChange` | `undone` + 重读成功（`planning.ts:1496` 起） | 成功（`undoable` 取快照；撤销后**恒为 null**，不是“通常”） |
| `undoStatusChange` | `undone` + 重读失败 | **`unknown-result`（不带 snapshot）**：撤销**已落地**但视图未刷新，message **必须**写明“撤销已生效、视图未刷新”；**不得** `read-failed`（F3，否则显示“未做任何修改”） |
| `undoStatusChange` | `cannot-undo/nothing-to-undo`（`planning.ts:1442`） | `stale-baseline` + `current`（UI undo 分支显示当前值，`controller.ts:398-411`） |
| `undoStatusChange` | `cannot-undo/superseded`（`planning.ts:1438-1439`/`:1444`/`:1446`/`:1452`） | 先预检：`task.lastStatusUpdateId === 本撤销 operationId`（撤销成功后写入，`:1484-1485`）→ 视为**已生效**成功；否则竞争 → `stale-baseline` + `current` |
| `undoStatusChange` | `rejected/unknown-task`（`planning.ts:1421-1423`） | `not-found` |
| `undoStatusChange` | `rejected/invalid-input`（`planning.ts:1417-1418`） | `save-failed` |
| `undoStatusChange` | `failed/write-failed` | `save-failed` + `current`（current 同 F6：适配器 `readTask` 取 status 并编码 `ver1:<n>` 合成） |
| `reorderTask` | 任何 `unknown-result` | 政策同上（不自动重发）；**切片 A 禁止自动重试**：只提供「重新读取」，读回后由用户重新拖拽（order 级基线缺失见 §8 第 11 条） |

### 6.3 切片 B 的错误码扩展（B 再定稿）

B 需要区分“输入被拒绝”的一类（标题空白、字段非法），建议**新增 1 个浏览器侧失败码 `invalid-input`**（同时保留 `invalid-reason` 给阻塞原因），并把 `keptInput` 放进成功/失败值结构以支持就地回显（core 已回显：`CreateTaskOutcome` `types.ts:482-504`、`UpdateFieldsOutcome` `:525-566`）。新增码必须同时改 `BOARD_FAILURE_CODES`（`wire.ts:58-67`）、host hander、浏览器映射（`channel-source.ts:173-180`）与测试；不得在 A 里预留半成品。

## 7. 证据与完成判据

### 7.1 集成测试（切片 A 的主要证据，档 2）

新测试 `packages/plugin/test/board-adapter.test.ts`，用**真实** `createKanbanCore({port: createMemoryStoragePort(createMemoryMedium())})`（`packages/core/src/index.ts:14/16`、`port.ts:101-121`；契约说明见 `packages/core/README.md:16-45`、`:81-101`）→ 真实适配器 → 真实 `createBoardChannelHandler`（`board-channel.ts:145`），断言：

1. `board/read` 成功：`capabilities` 三分量、`workScope` 摊平（null→省略）、`hints` 缺省、`statusRevision`/`undoTarget` 在（§3.2/3.3）。
2. `board/read` 未登记项目 → `unknown-project`（不是空看板）；payload 缺 `projectId` → `invalid-payload`，且无任何项目被猜中。
3. `task/status.set`：成功、阻塞无原因被拒（无写）、`baseline-changed` → `stale-baseline`+current、同 operationId 重试 → `already-applied`；**`no-change` → 成功且 `undoable` 取快照 `undoTarget!==null`（不得为 false）**；**非法 `ver1:` → handler 前置 `invalid-payload` → 浏览器 `save-failed`，且 port 未被调用（F5）**；core 的 `rejected/*` 逐条覆盖：`unknown-task`→`not-found`、`unknown-project`→`unknown-project`、`invalid-status`→`save-failed`、`blocked-reason-required`→`invalid-reason`（F7）。
4. `task/reorder`：成功；`status` 与 core 当前列不符 → `stale-baseline`；`rejected/invalid-input`（缺 requestId 等）→ `save-failed`；**未知结果不得自动重发**：模拟 `unknown-result` 时 controller 只提供重新读取、不提供写重试（F9/F10/D6）。
5. `task/status.undo`：用 `undoTarget` 成功；竞争 → `stale-baseline`+current；**同 undoId 重试 → 已生效的成功（预检命中，不误报竞争）**；`nothing-to-undo` → `stale-baseline`+current；`unknown-task` → `not-found`；**`undone` 但重读失败 → `unknown-result`（不得 `read-failed`；F3）**。
6. 故障注入（内存 port 的 `beforeWrite`，选项定义见 `port.ts:82`、注入点 `:185`；属测试代码，不进入正式构建，符合 Q3 政策）：
   - 写失败 → `save-failed` 且正式值不变、**`current` 由适配器 `readTask` 合成 `{status,statusVersion:'ver1:<n>'}`**（F6）；适配器异常 → handler 返回 `unknown-result`，**handler 永不抛**。
   - **重读失败分类（F3）**：`saved` / `already-applied` / `undone` → `unknown-result`（不带 snapshot，message 按结果分级：已保存/撤销已生效）；`no-change` → `read-failed`。
   - **写后失败的重试意图（F5）**：上述 `unknown-result` 与写后 `read-failed` 的 controller feedback 都只给 `{kind:'read'}`，**不保留写重试意图**（见第 11 条）。
7. 未知端点 → `unknown-endpoint`（`board-channel.ts:210`）。
8. 快照读：`readBoard` 返回的 `boardToken` 与 core 一致、迟到响应比较仍成立（controller 侧）。
9. **工具 output schema 字段覆盖哨兵（F2，最终表述；基准必须是运行时快照）**：落点 `packages/plugin/test/host.test.ts`，在 `describe('host half: output schema obeys the host-enforced subset')` 内**新增一个用例**。步骤与断言：
   1. **取运行时快照**：`const host = fakeHost(); apply(host.ctx); const snapshot = getLastActivation()`（复用现有 `fakeHost()`/`apply` 测试设施；断言中不得使用手写的 `ActivationSnapshot` 字面量——见第 3 点）。
   2. 断言 `const schema = createStatusTool(snapshot).output.schema` 的 `properties` 键集：**`Object.keys(schema.properties)` 必须恰好等于 `Object.keys(snapshot)`**（真实运行时对象键集，漏一个/多一个都失败）。
   3. **为什么不用手写字面量**：四个包 tsconfig 只 `include: ['src/**']`，**测试文件不被 `tsc -b` 检查**；手写字面量与 schema 可以一起漂移而键集仍相等，哨兵会空转。以 `apply(fakeHost)` 后 `getLastActivation()` 的实际键集为基准，**未来新增/删除 `ActivationSnapshot` 字段时断言自动跟随**，不需要维护第二份字段清单。
   4. `schema.required` **包含全部字段**（含 `pid`/`boardChannel` 等 nullable 字段）——与现有惯例一致（`required` 已含 `pid`，`packages/plugin/src/index.ts:229-232`）；nullable 只影响该字段的**值 schema**：用 `oneOf: [{type:'integer'},{type:'null'}]` / `[{type:'string'},{type:'null'}]`（同现有 `pid`，`packages/plugin/src/index.ts:241`），不得用 type 数组。
   5. 每个 `required` 名都出现在 `properties` 中（与现有 `checkSchema` 规则一致，可复用）。
   6. **意图**：注册期只跑 `assertSupportedJsonSchema`（关键字形状，违反抛 `JsonSchemaError`，`dsh-tools/lib/index.js:322-325`）；`ToolOutputError` 只在**工具被调用**、输出不满足 schema 时抛（同文件 `:2454` 定义、`:3418` 抛出）。现有 `host.test.ts:285` 的 `checkSchema` 只查关键字与 `required ⊆ properties`、不比对字段覆盖；`tools/verify-host-import.mjs:323-335` 的 check11 直接 `execute` 绕过运行时校验。**只有这条以运行时快照为基准的哨兵能在本地拦住“注册成功、真机调用才炸”。**
10. host 半装配：`connection` 缺失 / `rpc.handle` 抛错（`register-failed`）时 `apply()` 不抛、诊断事件 reason 正确；浏览器侧按 §6.1：读 → `read-failed`、写 → `unknown-result`；**`unavailable` 有两个来源**：无 `connection` 时的本地空源 + 延迟端口在数据层未就绪时返回（§6.1）。
11. **写后失败的客户端强制（F9/F10）**：构造 `unknown-result` **或写后 `read-failed`** 的写失败（含 reorder）时，controller 的 failure feedback 必须 `retry.kind === 'read'`（无写重试意图），面板只渲染「重新读取」；`retryPending()` 只触发 `load()`，**不调用任何 source 写方法**。同时断言 `channel-source.ts:170` 的未知结果文案不含“后重试”（A7 改动项）。

切片 B 再加：`project/list`（不猜、不写）、`task/create` 幂等与 `keptInput`、`task/fields.update` 基线/草稿、`activity/read` 排序与 scope 隔离。

### 7.2 隔离探针新增断言（档 3；当前缺口）

现状：`tools/probe-host.mjs` 只断言 4 件事——合成树含 aikanban 行（`:275-286`）、profile 解析并激活（`:288-333`）、宿主发布 `window.__DSH_BOOT__` 行并服务 client.js（`:343-443`）、宿主进程内发布 `aikanban:activation`（`:445-463`）；**没有任何断言证明 `registerBoardChannel` 被调用**。A 完成后必须新增：

1. `tools/probe-host.mjs` 生成的观察者（`:353-359`）同时订阅 `aikanban:board-channel`，把 payload 写成 `[probe] BOARD-CHANNEL <json>` 行（与 ACTIVATION 同模式）。
2. 第 4 步增加第 5 项检查：等到 `[probe] BOARD-CHANNEL` 行且 `registered===true && channel==='/aikanban'` → `record('host half registered /aikanban via registerBoardChannel', true, …)`；超时/失败 → `false`（不是 SKIP）。
3. 若观察者 preload 被宿主拒绝（现有 `observerUnavailable` 分支 `:456-459`）：写 `observations`「未观察」并保持“不冒充已验证”，不得写 PASS。
4. 现有 4 项检查与退出码语义不变（`:443-489`）；新增检查通过后 README/验收记录引用的是**新增后的探针输出**。

### 7.3 门禁（A 的定义性完成判据，全部要贴原始输出）

**前置（A-G0，缺一则后续门禁无意义，F11）**：A4 新增 `@aikanban/core` 依赖后，必须在**同步盘之外的构建沙盒**（worktree，[tools/COMMANDS.md](../../tools/COMMANDS.md) §10.2 `:196-217`）里跑**非 frozen** 的 `pnpm install`，再把生成的 `pnpm-lock.yaml` **复制回主仓库并提交**；之后基线的 `pnpm install --frozen-lockfile` 才成立。**具体命令（不要照抄 COMMANDS §2 整段——它的第一行 `cd` 会回到同步盘主仓库）**：

1. `git -C "D:\BaiduSyncdisk\dsh-plugin\AIKanBan" worktree add --detach $BOX <分支/提交>`（COMMANDS `:208`；`$BOX` 必须在同步盘之外，例如 `C:\Users\InformationDS\aikanban-build`）。
2. 切到沙盒目录后**只执行 COMMANDS `:57` 这一条**：
   ```powershell
   # 当前目录 = $BOX（盘外沙盒）；$NODE/$PNPM 定义见 COMMANDS :203-204
   & $NODE $PNPM install
   ```
   **绝对不要执行 COMMANDS §2 的 `:56`：`cd D:\BaiduSyncdisk\dsh-plugin\AIKanBan`**——那会切回同步盘主仓库，照抄就会在明令禁止的位置 install（§10.2 `:196-216`）。install 后沙盒里的 `pnpm-lock.yaml` 被更新。
3. **lockfile 回迁到主仓库**（沙盒是 detached worktree、不接主分支，**不在沙盒内提交**）：
   ```powershell
   # 在主仓库侧执行；-Force 覆盖主仓库的旧 lockfile
   Copy-Item "$BOX\pnpm-lock.yaml" "D:\BaiduSyncdisk\dsh-plugin\AIKanBan\pnpm-lock.yaml" -Force
   git -C "D:\BaiduSyncdisk\dsh-plugin\AIKanBan" add pnpm-lock.yaml
   git -C "D:\BaiduSyncdisk\dsh-plugin\AIKanBan" commit -m "chore: add @aikanban/core dependency and refresh pnpm-lock.yaml"
   ```
4. 回沙盒 `& $NODE $PNPM install --frozen-lockfile`（COMMANDS `:221`）验证可复现。

结论：COMMANDS §2 的 install 命令本身没错，错的是整段的 `cd` 行；正确做法是**只取 `:57` 一条、在盘外沙盒的 cwd 下执行**，再把 lockfile 带回主仓库提交。

| # | 判据 | 命令/方式 |
| --- | --- | --- |
| A-G0 | lockfile 已更新并提交；沙盒 `--frozen-lockfile` 可复现 | 盘外 worktree（`:208`）里**只执行 COMMANDS `:57` 的 install（不执行 `:56` 的 `cd`）** → `Copy-Item` lockfile 回主仓库 → 主仓库 `git add`/commit → 沙盒 `pnpm install --frozen-lockfile`（`:221`）成功（§10.2 `:196-217`） |
| A-G1 | typecheck/build 通过 | 沙盒内 `pnpm run typecheck`、`pnpm run build`（根 README 命令） |
| A-G2 | 测试全绿且新增集成测试在列；含工具 output schema **字段覆盖哨兵**（§7.1 第 9 条） | `pnpm -r --if-present run test`；记录 core/plugin/plugin-client 用例数（当前 66/38/45=149，更新后据实） |
| A-G3 | `verify-host-import` **11/11 不退化** | `node tools/verify-host-import.mjs`（`:225-335`） |
| A-G4 | 探针新增断言通过 | `node tools/probe-host.mjs`（§7.2；输出含新检查 PASS） |
| A-G5 | 代码事实核对与记录分工 | `git status` 只含本切片改动；**未改 `docs/prd/**`、未改产品语义**；切片 A 的实施记录按 §7.4 写 `docs/engineering/s1-wiring-implementation.md`（不写进 features 目录） |

**A 完成 ≠ F01/F02 验收**：AT 全部「待执行」；`implementation.md`/`verification.md` 的更新与 AT 执行按[验收执行规则](acceptance-execution.md)另做。A 的测试/探针只能作为档 2/档 3 辅助证据。

### 7.4 S5 分工与实施记录（与 M6 的明确边界）

- 切片 A **不实现任何功能规则**（只做 core→host→browser 的接线）：它的实施记录**不写进 `docs/prd/features/**`**，而是新建 **`docs/engineering/s1-wiring-implementation.md`** 作为工程实施记录；按 [M6 规则](../prd/templates/vibecoding-task.md)（`implementation.md` 首次创建、后续追加章节并注明**日期 + 提交号**）维护。**本规格不创建该文件**，只定规则。
- 功能自身的实现仍按 M6 写各自 `docs/prd/features/Fxx-slug/implementation.md`；跨功能接线与功能实现的记录地点不同，不互相替代（同 [验收执行规则 §6](acceptance-execution.md) 的 S5 分工）。
- A-G5 的「未改 `docs/prd/**`」保持不变：这是该分工的直接结果——A 期间不往功能目录写实施记录，也不改 PRD。

## 8. 未定与风险（需真实 profile / 实施第一步取证）

1. **真实 Connection RPC 网络往返**：本仓库只能做协议级往返（真实构建产物 + 契约信封）；`requestRejection`（Host/Origin/token）与真实页面↔宿主跳转需写 profile 并重启，未验证（ADR-005 `:88-98`，状态仍 `提议`）。A 的探针只能证明“宿主内注册发生”，不能证明网络可用。
2. **浏览器真实渲染**：无 DOM 环境测试；面板在真实 GUI 的渲染/键盘仍待档 1（ADR-004 仍 `提议`）。
3. **`ctx.storageDomain.open` 的真实插件上下文行为**（§5.2）：spec 形状已由**安装包真实实现**佐证（`@deepseek-ai/dsh-storage-domain/lib/index.js`：`defineDomain` 只做校验 `:61-76`、`descriptorOf` `:82-91`、`open` `:355-398`、`valueSchema.parse` `:371`），**不再是“裸 spec 是否可接受”的未确认**；仍需实测的是：真实插件上下文里该服务是否以同一形状暴露 `open`、失败时的错误形状。
4. **`tsc -b` 对 core 源导出引用的解析**（§5.3）：未确认；可能出现 TS6305/TS6059，修法已给。
5. **`workspaceRegistry` 服务生命周期与运行时字段**（§5.4）：`status(): Promise<'ok'|'missing-dir'>` 与 `get(id): Workspace | undefined` / `list(): Workspace[]` 的**签名**可由安装包声明核对（`dsh-workspace/lib/types/entity.d.ts:73`、`dsh-workspace/lib/types/types.d.ts:98`、`dsh-workspace/lib/types/index.d.ts:85/92`）；但 `Workspace` 的**运行时字段**、服务绑定时机/生命周期**未验证**——不得写成整体已确证。
6. **cordis 生命周期**（关闭 domain/注销通道）：cordis 4.0.2 **无 `on('dispose')` 事件**；倾向 `ctx.effect`，其拆除语义**未确认**，A 先按进程级生命周期，记录局限。
7. **connection / storageDomain 服务相对 apply 的到达时机**：都可能晚于 apply；已按 `internal/service` 重试 + 重发信号设计（含 `storageDomain` 晚到重试与 `void bootstrap().catch(...)`），但真实顺序需探针观察（快照里的 `boardChannelRegistered`/`dataLayerReady` 可能先 false 后 true，探针必须等最终态）。
8. **同一次状态+排序的两写**：core 对 `setTaskStatus({toIndex})` 先写列偏好再写状态（`planning.ts:1300-1315`）；若第二步失败，卡片位置偏好已变但状态未变。A 按 core 现状映射（失败报 `save-failed`，正式状态不变）；产品可接受性已由 F02-R04 的“保存失败保留正式原状态与顺序”约束（但两者不同写，需在验证时如实记录该边界）。
9. **切片 A 无项目选择 UI**：A 的界面只能显示选择空态；若评审要求“A 可演示 S1 闭环”，需把 B 的 `project/list` 前移——本规格按任务书“A 固定 4 端点”执行，不擅自扩大。
10. **工具 output schema 的宿主硬约束（F2 校正）**：注册期只做 `assertSupportedJsonSchema`（关键字形状，违反抛 `JsonSchemaError`；`dsh-tools/lib/index.js:322-325`，`:325` 抛出）；`ToolOutputError` 只在**工具被调用**、输出不满足 schema 时抛（同文件 `:2454`/`:3418`）。所以“漏字段”不会在注册期失败、而是真机调用才炸；本地唯一防线是 §7.1 第 9 条的**以运行时快照为基准的字段覆盖哨兵**（`host.test.ts:285` 的 `checkSchema` 与 `verify-host-import:323-335` 都兜不住）。真实宿主对 schema 错误的完整报错形状仍属未验证。
11. **order 级基线缺失（D6，已知缺口）**：`reorderTask` 有 `requestId`（`planning.ts:1355-1357`）与 `statusRevision` 基线校验（`:1376-1383`），但**没有 order 级基线**——两次并发排序都不改 `statusRevision` 时检测不到，后写覆盖先写。切片 A 的缓解：reorder 的 `unknown-result` **禁止自动重试**（§4.4 第 8 条），只提供「重新读取」，由用户重拖；**根治候选**：把 `orderRevision`（core `ProjectFields.orderRevision`）作为写前基线加入 reorder 契约（切片 B 或独立契约扩展，需 core 侧配合返回/校验），在完成前不得声称并发排序安全。

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
- 构建/安装沙盒：[tools/COMMANDS.md](../../tools/COMMANDS.md) §10.2（盘外 worktree、`--frozen-lockfile`）
- 决策与状态：[ADR-007](decisions/ADR-007-s1-wiring-and-current-project.md)、[交付状态](../delivery/status.md)、[验收执行规则](acceptance-execution.md)
