# F02 implementation（回收代码现状盘点）

> **证据边界**：本文是 2026-10-19 对**回收代码**（分支 `s1-recover`，代码自 `bd16535` 逐字节复原、仅追加一处 3 行空值守卫）的**现状盘点**，不是本次新写的实现记录，也不是验收记录。**没有执行任何 AT 场景；F02 的验收状态仍为「待执行」**。判定只依据 `packages/` 源码与测试文件的实际内容；本机没有 `node_modules`，未重跑测试，用例数为源码静态统计。[S0 复核记录](../../../engineering/s0-reverification-20261019.md) 报告 149 个用例在隔离工作区通过，属工具级证据，不构成产品验收。

## 1. 范围、依赖与判定口径

- 需求依据：[F02 prd.md](prd.md)（规则 F02-R01…R07、§6 九行验收）。
- 代码落点：`packages/core`（状态词表、状态机、列内顺序、撤销：`planning.ts` + `taskModel.ts`）；`packages/plugin-client`（看板渲染、交互状态机、视图模型、线协议）；`packages/plugin`（host 半的通道 handler，**未注册、无 core 适配**，见 §4）。
- 依赖：F01 的任务字段/项目隔离（已回收实现）；F03 概况、F04 对话、F06 记录、F13/F14 成果均未实现，相关提示与来源在本仓库不可达。
- 判定口径同 F01：`已实现`／`部分实现`／`未实现`／`不在本层`；端到端接线单独在 §4 说明。
- 记录关系：进度与验收状态只在[交付状态](../../../delivery/status.md)维护。

## 2. 逐条规则覆盖

| 规则 | 代码落点（文件:符号/行） | 测试证据（文件＋静态用例数） | 状态 | 说明与缺口 |
| --- | --- | --- | --- | --- |
| F02-R01 状态集合和控制权 | `taskModel.ts:22` `TASK_STATUSES`（五状态，归档不在内）；`taskModel.ts:37` `BOARD_COLUMNS`（已取消 `collapsedByDefault:true`、已完成仍可见）；`planning.ts:1184` `setTaskStatus` 是唯一状态写入；`core.ts:695` `confirmPaired` 不写 `task.status`；词表经 wire 传给 UI（`model.ts:42` 起不另声明枚举） | `f02-status-and-order.test.ts`（11）：「the transition set, blocked reasons, unblocking and reopening」「only the explicit status entry changes status — confirmations and field edits never do」「the board token tracks status and order, and the five columns stay the vocabulary」；`model.test.ts`（19）「does not turn archive into a status」「uses the data layer labels rather than recomputing them」 | 已实现（core＋UI 逻辑） | 词表唯一来源与「状态只由用户操作改变」有单测；端到端未接线（§4），故产品级行为尚未可观察 |
| F02-R02 状态流转和阻塞 | `planning.ts:1184` `setTaskStatus`（进入 blocked 原因必填：L1220-1229；离开 blocked 清当前提示、旧原因入 `task-unblocked` 历史；`toIndex` 先写列偏好再写状态）；`controller.ts:474` `requestStatusChange` 单一入口；`controller.ts:638` `dropTask`；`board.tsx:127` 原生 `<select>` 菜单、`board.tsx:220-221` 拖拽 drop；`board.tsx:241` 阻塞原因对话框 | `f02-status-and-order.test.ts`：「an invalid blocked reason changes nothing; cancelling keeps the original column and state」「F02-R01/R02/R03: the transition set, blocked reasons, unblocking and reopening」；`controller.test.ts`：「sends the same request whether the user used the menu or dropped the card」「refuses to enter blocked without a reason」「confirms a blocked transition once a reason is typed, and keeps the reason on cancel」 | 已实现（core＋UI 逻辑） | 菜单/拖拽/键盘共用同一 controller 入口，阻塞与取消规则有单测；**无 DOM/键盘事件级测试**，「键盘可用」依赖原生控件（F19 负责全面验收） |
| F02-R03 完成、取消和重新打开 | `planning.ts:1184` `setTaskStatus`（`change.reopened`、不生成项目记录/不归档/不停止对话、不动草稿）；`taskModel.ts:60` `isTerminalStatus`；`model.ts:59` `isReopenable` | `f02-status-and-order.test.ts`：「F02-R01/R02/R03: …unblocking and reopening」「F02-R03/R05: completing keeps records and history, and generates no project outcome」；`model.test.ts`「recognises only the ids the product rules attach to」 | 部分实现 | 完成/取消/重开与「不自动生成成果、不停对话」有单测；「仍运行/未记录提示」「前次完成范围」分别依赖 F04/F06 与 F14，未实现 |
| F02-R04 顺序与撤销 | `planning.ts:170` `layoutOf`（列顺序＝项目 head 偏好列表）；`planning.ts:352` `writeColumnPreference`（整列一次写）；`planning.ts:1353` `reorderTask`；`planning.ts:1414` `undoStatusChange`（`statusRevision`＋`appliedUpdateId` 判定，竞争返回 `superseded`＋当前值）；`controller.ts:731` `undoLastChange`、`controller.ts:367` `runWrite`（失败不乐观呈现） | `f02-status-and-order.test.ts`（11）中：「a manual column order is saved as ONE atomic project write and read back reliably」「undo restores the previous status and its applicable fields」「an undo that lost the race fails explicitly and shows the current value」「repeated and concurrent status submissions produce exactly one result」「a failed status or order write leaves the official status AND order untouched」；`controller.test.ts`：「shows the formal status again and offers a retry when the write fails」「keeps the order and shows the failure when a reorder fails」「refuses to overwrite later changes and shows the actual current value」「does not offer undo when the data layer says the change is no longer undoable」 | 已实现（core＋UI 逻辑） | 一次写、撤销竞争、失败不半生效均有单测；端到端未接线 |
| F02-R05 卡片内容来源 | `taskModel.ts:131` `progressLineOf`（正式概况首行、截断）；`planning.ts:268` `toTaskView` 计算 `summaryProgress`；`model.ts:225` `deriveCardProgress`（summary → goal → 显式「暂无」，**不读取草稿/末条记录**）；`board.tsx:109` `renderCard`（文字显示状态与阻塞原因） | `model.test.ts`（19）：「uses the official summary line when there is one」「falls back to the goal when there is no summary, and says so」「shows an explicit none text when neither exists」「marks a summary that needs re-checking, keeping the summary text」「never consults a draft or a last record, even when one is smuggled in」「collapses multi-line content into one card line」 | 部分实现 | 回退链与「草稿不冒充」由类型结构＋单测保证；真实正式概况需 F03 写入，当前 S1 数据只会走 goal/暂无 |
| F02-R06 行动提示 | `model.ts:155` `BoardActionHint`（注释明确「S1 为空」「UI 不自行合成」）；`board.tsx:123-125` 渲染 hint | 无数据层提示实现可测；`model.test.ts`「carries hints only when the data layer supplied them」仅验证渲染契约 | 未实现 | core 的 `TaskView` 没有 hints 字段；对话运行/待确认记录/背景失败/待生成成果等来源（F04/F06/F13）均未实现；当前只能渲染空 |
| F02-R07 详情职责与字段一致性 | `model.ts:399` `deriveTaskDetail`；`model.ts:387` `DETAIL_PLACEHOLDERS`（F04/F06/F13 明示「未实现」，不可点击）；`board.tsx:285` `renderDetail`（目标、手动状态、正式概况、待核对、阻塞原因、占位）；`controller.ts:622` `openDetail`/`628` `closeDetail`；`core.ts:695` `confirmPaired` 不写字段 | `controller.test.ts`：「opens the detail of a rendered task and closes it without losing the board」「ignores a detail request for a task that is not rendered」；`model.test.ts`：「shows the goal independently and 暂无-style nulls, never fabricated content」「shows a blocked reason only while the task is blocked」 | 部分实现 | 详情骨架、字段独立呈现、占位诚实有单测；「改进展/下一步进入 F03」入口未实现，「更多操作」中归档/删除属 F17 未实现 |

小结：**F02 的 core 状态机与 UI 交互逻辑（R01、R02、R04）已有完整落点与单测；R03/R05/R07 受 F03/F04/F06/F13/F14 前置限制为部分实现；R06 只有渲染契约、无数据层来源**。端到端未接线（§4）。

## 3. 与 PRD §6 验收的关系（只报机制，不报通过）

F02 §6 共 **9 行验收（8 个 AT 编号，AT-03 出现两行）**。覆盖＝单测覆盖该行机制，不是 AT 已执行或通过：

| §6 行 | AT | 单测机制证据 | 覆盖判定 |
| --- | --- | --- | --- |
| 1 | AT-03（拖入阻塞→取消→填原因确认） | `f02-status-and-order.test.ts` 前两用例＋`controller.test.ts` 阻塞对话框三用例 | 覆盖 |
| 2 | AT-03（保存失败→撤销） | `f02-status-and-order.test.ts` 失败注入/撤销/竞争用例＋`controller.test.ts` 失败重试与撤销用例 | 覆盖 |
| 3 | AT-05 联合 F03/F06（卡片来源） | `model.test.ts` 回退链 6 用例；F03 无正式概况写入 | 部分覆盖（F03/F06 缺失） |
| 4 | AT-04 联合 F04/F06/F13（三事件不改状态） | `f02-status-and-order.test.ts`「only the explicit status entry changes status」；AI 结束事件与成果保存不在本仓库 | 部分覆盖（事件源缺失） |
| 5 | AT-38 联合 F13（完成与生成分开） | 「F02-R03/R05: completing keeps records and history, and generates no project outcome」；F13 生成入口未实现 | 部分覆盖 |
| 6 | AT-39 联合 F04/F13（运行中允许完成） | 完成/重开按当前状态允许（`f02-status-and-order.test.ts`）；运行与未记录提示依赖 F04/F06 | 部分覆盖 |
| 7 | AT-41 联合 F14（成果任务重开） | 重开与保留记录/历史有单测；前次成果范围提示依赖 F14 | 部分覆盖 |
| 8 | AT-29 联合 F06/F08（审核中改状态再确认） | `f02-status-and-order.test.ts`「confirmations and field edits never do」；`f01-task-create-edit.test.ts` AT-29 用例 | 覆盖 |
| 9 | AT-109（键盘切状态/展开取消列/返回详情） | `controller.test.ts` 菜单与拖拽同路、折叠列、详情开关；无键盘事件级测试 | 部分覆盖（原生控件可用，未测） |

统计：**3/9 行机制有单测覆盖**（两行 AT-03、一行 AT-29）；**6/9 行部分覆盖**（AT-05、AT-04、AT-38、AT-39、AT-41、AT-109）；**0 行完全未覆盖**。全部 AT 执行状态仍为**待执行**。

## 4. 依赖、接线与已知局限

1. **端到端未接通**：`packages/plugin/src/index.ts:396-404` 说明 board channel 未在 `apply()` 注册（缺 core 适配层）；`packages/plugin/src/board-channel.ts:145` 的 handler 依赖 `HostBoardPort`（L109），仓库中没有 `@aikanban/core` → 该端口的实现。浏览器半**没有 connection 时**显示「数据通道未接通」；**有 connection 但路由未注册或适配失败时**表现为 `read-failed` 与数据格式无效提示（`channel-source.ts:136-155`、`board.tsx:433-439`）。两种情况都**不会渲染假数据**。
2. **协议字段缺口**：wire 要求读快照携带 `capabilities`（`wire.ts:396-397`），core 的 `BoardReadResult` 没有该字段（`packages/core/src/types.ts:441-463`）；`hints`（F02-R06）在 core 也没有数据源。适配层须实现映射，否则读到的是「格式无效」。
3. **构建产物与测试前置**：`channel-roundtrip.test.ts` 与 `client-bundle.test.ts` 读取 `packages/plugin/lib/index.js`、`lib/client.js`；仓库不含 `lib/` 与 `node_modules`，须按 [tools/COMMANDS.md](../../../../tools/COMMANDS.md) 先安装构建才能运行这两组测试（`controller.test.ts`/`model.test.ts`/`slots.test.ts`/core 测试无需构建产物）。
4. **依赖功能未实现**：F03（正式概况）、F04（对话）、F06（记录）、F13/F14（成果）、F15（行动提示来源）、F17（归档/删除）、F19（键盘全面验收）——相关规则与 AT 只能等其就绪后联合验收。
5. **未确认项**：真实浏览器渲染、真实键盘交互、真实宿主 Connection RPC 路由（Host/Origin/浏览器 token 校验）均无本仓库内实测证据；ADR-005 仍是「提议」。

## 5. 下一步（按最小闭环）

1. 实现 core → `HostBoardPort` 适配（`readBoard`/`setTaskStatus`/`reorderTask`/`undoStatusChange` 的结果映射、`capabilities` 与 `hints` 合成、三态读结果映射），并在 `apply()` 注册 `/aikanban` 通道。
2. 用真实通道跑通看板读、状态变更、阻塞、排序、撤销、失败重试；补齐项目切换入口（`controller.selectProject`）与任务创建/字段编辑（F01）。
3. 按 §6 逐 AT 执行；跨功能行标注「待联合验收」——在此之前 F02 验收保持「待执行」，不得引用本文或单测作验收证据。
