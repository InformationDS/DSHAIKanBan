# 回收代码盘点（2026-10-19）

> **证据边界**：本文是 2026-10-19 对**回收代码**的**模块级现状盘点**，不是实现记录，也不是验收记录。**没有执行任何 AT 场景；F01—F20 的验收状态全部仍是「待执行」。** 盘点依据是 `packages/` 源码与测试文件的实际内容（分支 `s1-recover`，代码自 `bd16535` 逐字节复原、仅追加一处 3 行空值守卫）。本机没有 `node_modules`，未重新运行测试：测试文件数与用例数为源码静态统计；[S0 复核记录](s0-reverification-20261019.md) 报告 149 个用例在隔离工作区通过，属工具级证据，不构成产品验收。

## 1. 包规模与目录

| 包 | 角色 | 文件数 | 源码/脚本 | 测试 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `packages/core` | 数据模型（domain 层） | 28 | 9 个 `src/*.ts` | 11 个测试文件＋2 个 harness，66 用例 | 成对确认单写、只增版本链、草稿/基线/待核对、适用性、F01 字段与 F02 状态机 |
| `packages/plugin` | host 半（DSH 插件） | 20 | `src/index.ts`、`src/board-channel.ts`、`src/client.tsx`、probe 脚本 | 3 个测试文件，38 用例 | 加载链骨架＋诊断工具＋board 通道 handler；**未做 core 适配、未注册通道** |
| `packages/plugin-client` | 浏览器半（看板 UI 库） | 15 | 8 个 `src/*.ts(x)` | 3 个测试文件，45 用例 | 看板渲染、交互控制器、视图模型、线协议、slots 注册 |
| 合计 | — | **63** | 27 个源码文件（约 1.5 万行含测试） | **17 个测试文件 / 149 用例** | 与根 `README.md` 的「63 文件」一致 |

包内分工（按依赖方向）：`core`（无 DSH 依赖）→ `plugin`（host 半，零 `@deepseek-ai/*` 运行时 import）→ `plugin-client`（浏览器半，独立 UI 库；`packages/plugin/src/client.tsx` 只是 loader 入口，把 UI 库打进单份 client bundle）。

## 2. `packages/core`（domain 层）

### 2.1 模块

| 文件 | 行数 | 职责 | 关键符号 |
| --- | --- | --- | --- |
| `src/core.ts` | 1315 | 成对确认单写、版本链、基线/幂等、草稿、待核对、适用性修正、恢复、读取 | `createKanbanCore:574`、`confirmPaired:695`、`evaluate:289`、`checkBaseline:882`、`amendApplicability:1153`、`restoreAsNewVersion:1164`、`readRecheck:1218`、`clearRecheck:1224`、`readPair:1240`、`history:1250`、`linkConversation:976`、`linkOutcomeTask:1027`、`saveDraft:1084` |
| `src/planning.ts` | 1525 | F01 项目管理/任务字段/活动历史＋F02 状态机/列顺序/撤销 | `createPlanningApi:250`、`createTask:451`、`lookupCreate:600`、`updateTaskFields:620`、`registerProject:862`、`observeWorkScope:938`、`saveBoardPosition:1012`、`readBoard:1059`、`setTaskStatus:1184`、`reorderTask:1353`、`undoStatusChange:1414`、`layoutOf:170`、`writeColumnPreference:352` |
| `src/scopeRecord.ts` | 278 | scope head 结构、规范化、待核对计算、活动历史追加 | `emptyScope:61`、`normalizeScope:90`、`computeRecheck:183`、`appendActivity:231`、`markRecheck:251`、`isConfirmableDraftState:46` |
| `src/domainSpec.ts` | 288 | 域规格、记录键、schema 校验 | `buildDomainSpec:274`、`isScopeStateRecord:212`、`isDraftRecord:239`、`scopeKey:45`、`draftKey:50`、`versionIdOf:55` |
| `src/port.ts` | 329 | 持久化端口契约、真实 adapter、内存 port（journal/故障注入） | `createStorageDomainPort:304`、`createMemoryStoragePort:121`、`createMemoryMedium:101` |
| `src/taskModel.ts` | 156 | F02 状态词表/列、F01 标题/目标纯函数、进度行、排序 | `TASK_STATUSES:22`、`BOARD_COLUMNS:37`、`isTaskStatus:50`、`normalizeTaskTitle:84`、`isValidTaskTitle:89`、`taskIdOf:114`、`progressLineOf:131`、`compareTasks:152` |
| `src/types.ts` | 1139 | 全部类型定义（含 `TaskView:368`、`BoardReadResult:441`、`ProjectView:419`） | — |
| `src/keys.ts` / `src/index.ts` | 64 / 78 | 键转义、规范化 JSON、fingerprint；公开出口 | `encodeKey:15`、`canonicalJson:32`、`fingerprint:42` |

### 2.2 对公共规则的覆盖

| 公共规则 | 覆盖判定 | 落点/依据 |
| --- | --- | --- |
| SAVE-01/03 草稿 | 已实现 | `saveDraft:1084`、`draftIdFor:1074`、`setDraftState:1134`；`drafts-and-recheck.test.ts` 槽位粒度用例 |
| SAVE-02/06 成对确认与幂等 | 已实现 | `confirmPaired:695`、`evaluate:289`（幂等 L296）；`paired-confirmation.test.ts`（8）、`concurrency.test.ts`（6） |
| SAVE-04/05 基线与待核对门槛 | 已实现 | `computeRecheck:183`、`checkBaseline:882`、`core.ts:427` 保存门槛；`drafts-and-recheck.test.ts`、`concurrency.test.ts` |
| SAVE-08/09/10 版本、恢复、无需更新 | 已实现 | 版本链 `types.ts:85`、`history:1250`、`restoreAsNewVersion:1164`；`version-chain.test.ts`（3） |
| APP-01…07 适用性 | 已实现（core 层） | `effectiveConclusions:133`、`amendApplicability:1153`；`applicability.test.ts`（5）、`version-chain.test.ts` 恢复不复活用例 |
| OBJ-01/02/03/05/06/07/08 | 已实现（domain） | 项目/任务 scope head、五状态词表、固定归属（`linkConversation:976` 拒绝改绑）、四类 objectKind、`DraftState`/`ConclusionState`/`RecheckFlag` 分离、草稿槽位（`draftSlotOf:1286`）、卡片进度只取正式概况 |
| OBJ-04 系统整理对话 | 未实现 | 域内没有对话/整理执行模型 |
| OBJ-09 删除来源 | 未实现 | 属 F17；core 无 archive/delete 流程 |
| OBJ-10 管理动作与执行权限 | 部分实现 | 读取/确认/草稿分离成立；AI 派发与执行权限层不在本仓库 |
| REC-01/02/03/04/05 | 已实现（core 层） | 一次写原子性（`port.ts` 契约＋journal 断言）、幂等、重启（`restart.test.ts` 4）、竞争（`concurrency.test.ts`）、损坏拒绝（`isScopeStateRecord:212`、schema 用例） |
| REC-06/07 | 不在本层 | AI 降级与界面离开/取消属 UI/宿主层；REC-07 的整理提示见 F06-R09（PRD 层） |

### 2.3 对功能规则的覆盖

- **F01-R01…R07：已实现（core 层）**，逐条证据见 [F01 implementation](../prd/features/F01-project-and-tasks/implementation.md)；测试 `f01-project-isolation.test.ts`（6）、`f01-task-create-edit.test.ts`（12）、`f01-activity.test.ts`（2）。
- **F02-R01…R05、R07 的 domain 支撑：已实现**（状态机/顺序/撤销/卡片进度字段/详情字段来源），证据见 [F02 implementation](../prd/features/F02-task-status-and-cards/implementation.md)；测试 `f02-status-and-order.test.ts`（11）。
- **F06/F07/F08/F09/F10 的通用机制：部分实现**——core 提供成对确认、草稿、待核对、适用性、并发幂等与恢复这些**通用能力**（`paired-confirmation` 8、`concurrency` 6、`applicability` 5、`drafts-and-recheck` 4），但各功能的**入口流程**（整理派发、编辑核对交互、历史列表 UI、项目成果生成）不在本仓库。
- **明确未覆盖**：F03（手动概况编辑流程）、F04/F05（对话与关联）、F11/F12（背景准备/检索）、F13/F14（项目成果）、F15（集中待确认）、F16（搜索筛选排序）、F17（归档删除）、F18（跨流程恢复）、F19（语言/键盘完整验收）、F20（聊天任务管理）；以及 AI 调用、整理命令派发、项目成果生成的任何代码。

## 3. `packages/plugin`（host 半）

| 文件 | 行数 | 内容 |
| --- | --- | --- |
| `src/index.ts` | 418 | cordis 插件骨架：`apply():305`、`inject:280`（空，故意不声明硬依赖）、`aikanban_status` 诊断工具 `createStatusTool:211`、`systemPrompt` 段、激活信号 `publishActivationSignal:81`；**L396-404 明确「board channel 尚未在 apply() 注册」** |
| `src/board-channel.ts` | 279 | 一条 Connection RPC 通道的 handler：`createBoardChannelHandler:145`、`registerBoardChannel:256`；端点 `board/read`、`task/status.set`、`task/reorder`、`task/status.undo`（端点名定义在 plugin-client 的 `wire.ts:96`）；`HostBoardPort` 接口 `:109`；payload 校验、阻塞原因在 wire 边界再查（`:165-169`）、错误码映射（`:25-37`），**永不抛异常** |
| `src/client.tsx` | 96 | 浏览器半 loader 入口，再导出 `@aikanban/plugin-client` |
| `src/probe/**` | — | S0 一次性宿主集成探针（`prepare.mjs` 等）与证据 JSON，不属于产品代码 |

覆盖：F02 的**协议层**（读/改状态/排序/撤销的请求校验与错误码映射）、`unknown-project`/`read-failed` 三态直通、写入结果未知按 `unknown-result`、撤销能力标记 `undoable`；覆盖 REC-01/REC-03/REC-05 在 wire 边界的表达。
**明确未覆盖**：core → `HostBoardPort` 适配（全仓库没有 `@aikanban/core` 到 `packages/plugin` 的适配实现）、`apply()` 内的通道注册、任何业务规则判定（按设计委托给数据层）。

## 4. `packages/plugin-client`（浏览器半）

| 文件 | 行数 | 内容 |
| --- | --- | --- |
| `src/board.tsx` | 538 | 看板面板渲染：`renderBoard:403`、`renderCard:109`、`renderColumn:184`（已取消列默认收起、可展开）、`renderStatusDialog:241`（阻塞原因）、`renderDetail:285`（详情骨架＋占位）、`renderFeedback:350`（成功/失败/撤销被拒分型）、`BoardPanel:492` |
| `src/controller.ts` | 751 | 交互状态机：读三态 `load:542`、迟到响应丢弃、`selectProject:604`、单一状态入口 `requestStatusChange:474`、`dropTask:638`（拖拽/菜单等价）、`menuSelectStatus:634`、失败重试同 `operationId` `retryPending:709`、撤销 `undoLastChange:731`、能力门控、对话/详情开关 |
| `src/model.ts` | 415 | 视图模型：`deriveCardProgress:225`（正式概况→目标→暂无）、`buildBoardView:304`、`deriveTaskDetail:399`、`DETAIL_PLACEHOLDERS:387`、阻塞原因校验 `isBlockedReasonValid:89` |
| `src/wire.ts` | 540 | 线协议：通道 `/aikanban`、四端点、payload/响应 schema 与解析（`parseBoardSnapshotValue:375` 等）、失败码表 |
| `src/source.ts` / `src/channel-source.ts` | 218 / 235 | `BoardSource` 端口与意图类型；`createChannelBoardSource:129`（DSH Connection RPC 适配）、无通道时的显式不可用源 |
| `src/runtime.ts` / `src/index.tsx` | 90 / 231 | 运行时持有 controller 与 source；两个 ADR-004 座位注册 `registerSlots:157`、`apply:199`、`inject:184` |

覆盖（UI 逻辑层）：F02-R02（菜单/拖拽同一入口、阻塞对话框）、F02-R04（排序与撤销的前端状态）、F02-R05（卡片进展回退链）、F02-R07（详情骨架与诚实占位）、F02-R01 的列呈现；F01-R01 的「迟到响应丢弃/旧项目不显示」两条约束；REC-01/03/05 的失败不假装成功、未知结果提示、读失败保留旧数据；REC-09 的状态/风险用文字（`board.tsx` 注释与渲染）。
**明确未覆盖**：任务创建/标题目标编辑 UI、项目选择与切换 UI（controller 有 `selectProject`，面板无入口）、活动历史展示、行动提示数据源（S1 恒空）、归档/搜索/筛选/排序 UI、国际化与完整键盘/无障碍验收（F19）。

## 5. 测试资产清单（17 个文件 / 149 用例，静态统计）

| 包 | 文件 | 用例数 | 关注点 |
| --- | --- | --- | --- |
| core | `test/f01-project-isolation.test.ts` | 6 | 同名项目不合并、按项目读任务、未登记≠空项目、读失败、位置隔离、工作范围缺失 |
| core | `test/f01-task-create-edit.test.ts` | 12 | 标题校验、无副作用创建、幂等/连点/重试、字段保存与草稿/重启、基线竞争、AT-29 字段保护 |
| core | `test/f01-activity.test.ts` | 2 | 活动历史内容/不含键入、跨项目隔离、重启保留 |
| core | `test/f02-status-and-order.test.ts` | 11 | 状态集合/阻塞/重开、唯一状态入口、失败不半生效、整列一次写、撤销与竞争、boardToken、损坏拒绝 |
| core | `test/paired-confirmation.test.ts` | 8 | 一次确认一次写、失败不半生效、清空=变化、无需更新、成对对象、归属校验 |
| core | `test/concurrency.test.ts` | 6 | 同 updateId 并发/重试、两更新竞争、待核对阻断与核对放行、任务间不互相锁 |
| core | `test/drafts-and-recheck.test.ts` | 4 | 草稿槽粒度、放弃/失败保留、待确认结论 vs 概况待核对、基线预检 |
| core | `test/applicability.test.ts` | 5 | 修正单写、基线含适用性、scope 隔离、未知结论拒绝、修正与正文同次生效 |
| core | `test/version-chain.test.ts` | 3 | 只增链、恢复为新版本不复活结论、无变化/未知版本 |
| core | `test/restart.test.ts` | 4 | 重启保留版本/指针/草稿、待核对跨重启、损坏 head 拒绝、域规格与实测约束 |
| core | `test/port-parity.test.ts` | 5 | 真实 adapter 形状、内存 port 契约、JSON 往返、键安全性、规范化稳定性 |
| plugin | `test/host.test.ts` | 19 | 激活/可选服务竞态/诊断工具/系统提示/诊断通道/宿主规则回归 |
| plugin | `test/channel-roundtrip.test.ts` | 12 | 浏览器半适配器 ↔ host handler 协议往返（读/写/错误/未知端点/不抛异常）；读的是构建产物 `lib/` |
| plugin | `test/client-bundle.test.ts` | 7 | client bundle 存在、单注册、懒加载、座位形状、disposer、可渲染；读 `lib/client.js` |
| plugin-client | `test/controller.test.ts` | 19 | 读三态/迟到响应/项目隔离/单一写入路径/阻塞/重试/撤销/能力门控/详情/折叠列 |
| plugin-client | `test/model.test.ts` | 19 | 卡片进展来源与回退、列构建、排序、状态 id、阻塞原因、详情/占位/提示 |
| plugin-client | `test/slots.test.ts` | 7 | 两个 ADR-004 座位、禁止座位、零参工厂、disposer、只依赖 `slots` |
| 合计 | **17 个测试文件** | **149** | core 66＋plugin 38＋plugin-client 45 |

运行前置：`packages/*/lib` 与 `node_modules` 不在仓库内；`channel-roundtrip.test.ts`、`client-bundle.test.ts` 依赖构建产物，须按 [tools/COMMANDS.md](../../tools/COMMANDS.md) 先安装/构建。其余测试直接跑源码。

## 6. 端到端缺口（后续 agent 最需要知道的部分）

1. **core 与 host 半未接线**：`packages/plugin/src/index.ts:396-404` 明确说明 board channel 未在 `apply()` 注册，因为没有 core 适配层；仓库内也不存在 `HostBoardPort` 的实现（`board-channel.ts:109` 只有接口）。
2. **协议与 core 的字段差**：wire 要求读快照带 `capabilities`（`wire.ts:396-397`），core 的 `BoardReadResult` 没有该字段（`types.ts:441-463`）；F02-R06 的 `hints` 在 core 也没有数据源。
3. **UI 只覆盖看板展示与 F02 交互**：没有任务创建/编辑、项目切换、活动历史、行动提示数据等入口（见 §4）。
4. **宿主侧未验证**：真实 profile 安装与生效、浏览器实际渲染、真实 Connection RPC 路由（Host/Origin/token），均无本仓库内证据（[S0 复核记录](s0-reverification-20261019.md) 的「仍未复核」清单）。真实模型回复与多步轮次已于 2026-10-20 在隔离宿主复验（见同页第 9 节），不再属于未验证项。
5. **原始提交类型错误**：`bd16535` 的 `channel-source.ts:186` 有一处 TS2322；回收时补了 3 行空值守卫（`ed6b151`），因此**当前分支可构建**，但该守卫是本次回收唯一的代码改动。

## 7. 与交付状态的关系

- 本页是**代码资产盘点**，不改变任何验收结论：F01—F20 的产品验收**全部「待执行」**；`packages/` 里的代码是 S0/S1 工程资产与起点。
- 实现状态只在[交付状态](../delivery/status.md)维护：当前 F01/F02 记为「进行中（domain 层与看板 UI 已有回收实现）」，F03—F20 仍为「未开始」。
- 功能级证据见 [F01 implementation](../prd/features/F01-project-and-tasks/implementation.md) 与 [F02 implementation](../prd/features/F02-task-status-and-cards/implementation.md)；两者都只做覆盖盘点，不是验收记录。
