# F01 implementation（回收代码现状盘点）

> **证据边界**：本文是 2026-10-19 对**回收代码**（分支 `s1-recover`，代码自 `bd16535` 逐字节复原、仅追加一处 3 行空值守卫）的**现状盘点**，不是本次新写的实现记录，也不是验收记录。**没有执行任何 AT 场景；F01 的验收状态仍为「待执行」**。规则覆盖判定只依据 `packages/` 源码与测试文件的实际内容；本机没有 `node_modules`，未重新运行测试，用例数为源码静态统计。[S0 复核记录](../../../engineering/s0-reverification-20261019.md) 报告 149 个用例在隔离工作区通过，那是工具级证据，不构成本功能的产品验收。

## 1. 范围、依赖与判定口径

- 需求依据：[F01 prd.md](prd.md)（规则 F01-R01…R07、§6 七行验收）。
- 本功能代码落点：`packages/core`（F01 领域层全部规则，契约见 [packages/core/README.md](../../../../packages/core/README.md) 的「F01 契约」一节，L177 起）；`packages/plugin-client`（看板展示端对项目隔离的两条约束）；`packages/plugin`（仅通道骨架，**未接线**，见 §4）。
- 宿主依赖：`workspace.id`、`workspace.path`、`workspace.status()` 由宿主提供。本仓库只有结构化类型与调用约定，**未确认**真实宿主的注入与观测结果（S0 复核记录亦把「装到真实 profile 并生效」列为未复核项）。
- 判定口径：`已实现`＝该规则在本功能应有的层全部有落点且有单测；`部分实现`＝关键层有落点、但端到端链路或 UI 入口缺失；`未实现`＝没有可判定的代码落点；`不在本层`＝由宿主或其他功能负责。
- 记录关系：本文只登记「代码里已经有什么」；进度与验收状态只在[交付状态](../../../delivery/status.md)维护。

## 2. 逐条规则覆盖

| 规则 | 代码落点（文件:符号/行） | 测试证据（文件＋静态用例数） | 状态 | 说明与缺口 |
| --- | --- | --- | --- | --- |
| F01-R01 项目拥有独立管理数据 | `planning.ts:120` `PROJECT_KEY`/`TASK_KEY`（scope head 键）；`planning.ts:259` `taskHeadsOf` 按 `projectId` 过滤；`planning.ts:862` `registerProject`、`planning.ts:1012` `saveBoardPosition`、`planning.ts:1059` `readBoard` 三态；`controller.ts:542` `load`（迟到响应按 `projectId` 丢弃）、`controller.ts:604` `selectProject`（先清旧项目） | `f01-project-isolation.test.ts`（6）：「ADR-003: two projects may share a title and never merge」「F01-R01: tasks are read per project…」「F01 §3: unregistered project is not an empty project」「F01 flow 7: each project keeps its own board position」；`controller.test.ts`（19）中「drops a response that belongs to another project」「clears the previous project before the new one arrives」 | 部分实现 | core 层按项目隔离读取/保存且有单测；UI 只做迟到响应丢弃，**没有项目选择/切换入口**（有 `selectProject` API，无面板控件）；真实宿主项目标识未确认 |
| F01-R02 任务创建输入 | `taskModel.ts:84` `normalizeTaskTitle`、`taskModel.ts:89` `isValidTaskTitle`、`taskModel.ts:94` `normalizeGoal`；`planning.ts:451` `createTask`（`invalid-title` L472-479、`blocked-reason-required` L480-488、`invalid-status` L469-471，均回显 `keptInput`） | `f01-task-create-edit.test.ts`（12）：「F01-R02: only-whitespace titles are refused in place, the goal survives, and nothing is written」「F01-R02: a blocked-column creation requires a reason; an invalid reason creates no half-made task」 | 部分实现 | 校验与「不写半成品」在 core 完成并有单测；**无任务创建表单 UI**，错误就地提示路径未接入 |
| F01-R03 无副作用创建 | `planning.ts:451` `createTask`：成功路径只有一次 `port.put`（L551-553，字段＋首条活动同一次写）；项目未登记返回 `unknown-project`（L489-498）；归属取 `project.projectId` 而非页面标题 | `f01-task-create-edit.test.ts`（12）：「F01-R03: creation has no side effects — one write, no records/summaries/conversations/AI」「F01-R03: attribution is fixed at creation time even when the board has already switched project」 | 部分实现 | core 层无 AI/无记录/无对话副作用、归属固定，均有单测；无创建 UI，故「操作中切换项目」只能在 core 层验证 |
| F01-R04 重复与重试 | `taskModel.ts:114` `taskIdOf`（`(projectId, requestId)` 确定性派生）；`planning.ts:451` `createTask` 的 `already-created`（L503-512）；`planning.ts:600` `lookupCreate` | `f01-task-create-edit.test.ts`（12）：「F01-R04/REC-02: the same requestId can only ever produce one task — retries and double clicks included」（含 8 次并发点击）「REC-03: a failed creation leaves nothing behind, and lookupCreate + retry recover without a second task」；`f01-project-isolation.test.ts`「identical titles stay independent」 | 部分实现 | 幂等由派生 id 结构性保证，并有连点/重试/故障注入单测；创建 UI 未接，用户可感知的去重路径未验证 |
| F01-R05 当前用户字段 | `planning.ts:620` `updateTaskFields`（实质变化才写；`saved`/`no-change`/`already-applied`/`baseline-changed`/`failed` 分类）；`planning.ts:225` `fieldsDecision`；`planning.ts:1127` `saveFieldDraft`、`planning.ts:1160` `readFieldDraft`、`planning.ts:1165` `discardFieldDraft`；`taskModel.ts:99` `isCosmeticGoalChange` | `f01-task-create-edit.test.ts`（12）：「F01-R05/REC-01: opening and typing never advance the official fields」「SAVE-04: a formatting-only goal edit is 纯排版 — no write, no recheck」「F01-R05/R06: a rename keeps records and drafts; a substantive goal change marks them 待核对」「REC-01/03: a failed field save keeps the official fields and retains the input as a draft that survives a restart」「SAVE-05: a stale field baseline never overwrites a concurrent edit」 | 部分实现 | 字段保存、失败留草稿、重启恢复、基线竞争均有单测；**无标题/目标编辑 UI**（字段草稿槽与正式字段已分离） |
| F01-R06 字段与来源分离 | `core.ts:695` `confirmPaired`（确认路径只写版本链/指针/修正/待核对，不写 `task` 字段，见 `core.ts:209` `fieldsBaselineReport`）；`planning.ts:620` `updateTaskFields` 的 `goal-changed` 待核对标记 | `f01-task-create-edit.test.ts`（12）：「F01-R06/AT-29: a confirmation during a field edit never rolls the new fields back, and reports the stale baseline」；`f02-status-and-order.test.ts`「only the explicit status entry changes status — confirmations and field edits never do」 | 部分实现 | core 不变性成立且有 AT-29 机制级单测；「展示当前目标及需核对提示」由 F02 详情骨架部分呈现（见 [F02 implementation](../F02-task-status-and-cards/implementation.md)），完整接续依赖 F07/F08/F09 |
| F01-R07 工作范围与活动历史 | `planning.ts:938` `observeWorkScope`（永不改写 `path`）、`planning.ts:986` `canUseWorkScope`、`planning.ts:124` `workScopeView`；`scopeRecord.ts:231` `appendActivity`；`planning.ts:1176` `readActivity`（最新在前、按 scope 隔离）；活动码表见 `core.ts`/`README` | `f01-project-isolation.test.ts`（6）：「F01-R07 / ADR-003: a missing work scope keeps management data readable and writable and never rewrites the path」；`f01-activity.test.ts`（2）：「F01-R07: activity records 创建/目标/标题/归属/确认 and the project changes, never keystrokes」「F01-R01: activity is scoped per project」；`restart.test.ts`（4）覆盖重启后持久化 | 部分实现 | 范围观测语义与活动历史均有单测；**UI 无活动历史展示**；真实文件系统动作的拒绝由宿主执行（不在本层） |

小结：**core 层 7/7 规则都有实现落点与单测覆盖；端到端（宿主适配＋看板 UI）0/7 完整接通**——根因见 §4。

## 3. 与 PRD §6 验收的关系（只报机制，不报通过）

F01 §6 共 **7 行验收（5 个 AT 编号）**。下列「覆盖」指**单测覆盖了该行的机制**，不是 AT 已执行，更不是通过：

| §6 行 | AT | 单测机制证据 | 覆盖判定 |
| --- | --- | --- | --- |
| 1 | AT-01 本功能 | 连点/重试只一项、创建无副作用（`f01-task-create-edit.test.ts`）；创建后重启仍可读（同文件 REC-01/03 用例 `harness.restart()`） | 覆盖（重启保留为间接证据，无 AT-01 专门用例） |
| 2 | AT-01 本功能补充 | 空白标题拒绝；同名不同 `requestId` 形成独立任务（同文件、`f01-project-isolation.test.ts`） | 覆盖 |
| 3 | AT-02 S1 验收 | 项目隔离、空项目与未登记区分、各项目位置独立（`f01-project-isolation.test.ts`） | 部分：概况编辑属 F03，未覆盖 |
| 4 | AT-02 联合 F06/F13/F15/F16/F17 | 无（依赖功能均未实现） | 未覆盖 |
| 5 | AT-29 联合 F06/F08 | 确认不覆盖用户字段、报告过期基线（`f01-task-create-edit.test.ts`）；确认不改状态（`f02-status-and-order.test.ts`） | 覆盖 |
| 6 | AT-107 | 工作范围不可用仍可读写、`path` 不被改写（`f01-project-isolation.test.ts`）；位置保存独立（`f01-activity.test.ts`） | 覆盖（真实文件动作由宿主拒绝，不在本层） |
| 7 | AT-108 | 故障注入后 `lookupCreate` + 同 `requestId` 重试（`f01-task-create-edit.test.ts`） | 覆盖 |

统计：**5/7 行机制有单测覆盖**（其中 AT-01 的重启保留为间接证据）；**1/7 行部分**（AT-02/S1，概况属 F03）；**1/7 行未覆盖**（AT-02 联合）。全部 AT 执行状态仍为**待执行**。

## 4. 依赖、接线与已知局限

1. **前后端未接通（最大的现状缺口）**：`packages/plugin` 的 `src/index.ts:396-404` 明确说明看板通道「尚未在 `apply()` 注册」——因为缺少 core 适配层。`packages/plugin/src/board-channel.ts:109` 只定义 `HostBoardPort` 接口；仓库中**没有任何把 `@aikanban/core` 接到该端口的适配实现**（全仓库无 `@aikanban/core` 的 import 到 `packages/plugin`）。
2. **协议字段缺口**：浏览器半的 wire 契约要求读看板快照携带 `capabilities`（`packages/plugin-client/src/wire.ts:396-397`、`packages/plugin-client/src/source.ts:106`），而 core 的 `BoardReadResult` 没有 `capabilities` 字段（`packages/core/src/types.ts:441-463`）。适配层必须合成该字段，否则页面会按「数据格式无效」处理。
3. **UI 缺口**：`packages/plugin-client/src/board.tsx` 只有看板/卡片/详情骨架；`packages/plugin-client/src/controller.ts` 有 `selectProject`（L604）但面板没有项目选择入口，也没有任务创建、标题/目标编辑、字段草稿展示。
4. **依赖其它功能**：概况内容（F03）、记录确认后的字段影响（F07/F08/F09）、对话与成果事件（F04/F06/F13）未实现，AT-02 联合行与 F01-R06 的接续部分无法在本仓库内验证。
5. **未确认项**：真实宿主 `workspace.*` 注入、真实 profile 加载与页面渲染、浏览器键盘交互，均无本仓库内的实测证据。
6. 持久化契约由 `port.ts` 与 `port-parity.test.ts`（5 用例）验证；本机未安装依赖，未重跑。

## 5. 下一步

接线与实施顺序以 [S1 接线规格](../../../engineering/s1-wiring.md) 与 [ADR-007](../../../engineering/decisions/ADR-007-s1-wiring-and-current-project.md) 为准，本文不再另立一套「下一步」：

- 切片 A（core → `HostBoardPort` 适配 + `/aikanban` 注册，范围固定为现有 4 端点）的字段映射以规格 §3.2—§3.5 为准：`capabilities` 由适配层合成；**`hints` 恒省略、不得合成占位提示**（F02-R06 的数据来源要等 F04/F06/F13，A/B 期 `hints` 省略）。
- 切片 B（F01 管理动作：`project/list`、`task/create`、`task/fields.update`、`activity/read` 及对应面板 UI）的端点、控制器与测试清单见规格 §1.2、§9；本文 §4 列出的 UI 缺口在该切片补齐。

按 §6 逐 AT 执行并新建 `verification.md`——**在此之前 F01 验收保持「待执行」，不得引用本文或单测作验收证据**。
