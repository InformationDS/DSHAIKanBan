# F01 实现记录：项目隔离与任务创建编辑（core 部分）

- 功能：[F01 项目隔离与任务创建编辑](prd.md)
- 范围：**`packages/core/**`（核心业务层）**；`packages/plugin`（AI 工具）与 `packages/plugin-client`（看板 UI）由 peer `board` 接线，不在本记录内
- 阶段：S1；状态：**已实现并有单元测试证据；产品验收（verification.md）尚未执行**（本记录不预填通过结论）
- 验收来源：AT-01、AT-02（项目隔离部分）、AT-29（联合 F06/F08）；完整 AT 结果由 `verification.md` 记录

## 1. 范围和依赖

**本功能实现的行为（core 的职责边界）**

| 规则 | core 落点 |
| --- | --- |
| F01-R01 项目独立管理数据 | 项目键 = `workspace.id`；所有任务读取按 `projectId` 过滤；每个 view 都带自己的 `projectId` |
| F01-R02 任务创建输入 | 标题必填（仅空白无效）、目标选填、默认未开始；已阻塞必须填原因 |
| F01-R03 无副作用创建 | 恰好一次写；不调 AI、不建对话、不生成记录/概况/成果版本；归属在创建时固定 |
| F01-R04 重复与重试 | `taskId` 由 `(projectId, requestId)` 确定性派生；同名不是合并依据 |
| F01-R05 当前用户字段 | 字段独立于正式内容；打开页面/每次键入不算实质更新；目标实质变化标记待核对；普通重命名不废弃成果 |
| F01-R06 字段与来源分离 | `confirmPaired` 不写任务字段；可在确认时携带 `fieldBaseline` 报告过期 |
| F01-R07 工作范围与活动历史 | 范围不可用只拒真实文件系统动作、不改写 `path`、不清数据；重要活动历史（目标/状态/归属/确认），不含键入 |
| OBJ-01 项目边界与空状态 | 未登记项目 ≠ 空项目；读取失败 ≠ 空看板（三态 `BoardReadResult`） |
| OBJ-02 状态由用户决定 | 五种状态 id；`archived` 是可见性属性而非第六种状态 |
| SAVE-05 当前基线与并发 | `updateTaskFields` 的 `expected` 基线（`fieldsRevision` + `statusRevision`）在写槽位内复核 |
| SAVE-08 活动历史 | 与正式版本同一次写发布的重要变化条目 |
| REC-01/02/03/04/05 | 失败保持正式值、连点/重试不重复对象、未知结果先核对、竞争不覆盖、损坏不当空 |

**依赖（已具备，未重复侦察）**

- S0 已交付的 `packages/core` 成对确认模型与 `StoragePort`（[core README](../../../../packages/core/README.md)）。
- [ADR-002 成对确认单写原子性](../../../engineering/decisions/ADR-002-paired-confirmation-single-write.md)：本功能沿用「一条 scope head 记录承载一次动作的全部结果」。
- [ADR-003 项目映射与默认背景注入](../../../engineering/decisions/ADR-003-project-mapping-and-context-injection.md)：项目 = `workspace.id`，工作范围 = `workspace.path`，`status()='missing-dir'` 时管理数据保留。
- 未决项：[OQ-01](../../open-questions.md) 不影响本功能；[ADR-005（浏览器半↔宿主半数据通道）](../../../engineering/decisions/README.md) 未决，但 **core 保持纯逻辑 + `StoragePort`，不引入任何通道代码**。

## 2. 实现计划（实际执行顺序）

1. 先把 scope head 的记录辅助函数抽成共享模块，避免 core 与 F01 各写一份（`scopeRecord.ts`），并保持既有 35 个测试不变绿。
2. 定义 F01 纯模型：状态词表/列、标题与目标规范化、`taskId` 派生、卡片进展行、列内排序（`taskModel.ts`）。
3. 在 `types.ts` 增补 F01 类型与 `ScopeStateRecord` 的三个新字段（`activity`/`task`/`project`），并给 `ConfirmInput` 增加可选 `fieldBaseline`。
4. 实现 `planning.ts`（`createPlanningApi`）：项目登记/观测/位置、幂等创建、字段编辑与草稿、活动历史、看板三态读取。
5. 让 `confirmPaired` 的提交在同一次写里追加确认历史条目，并回报任务字段基线是否过期。
6. 域校验器（`domainSpec.ts`）对新字段「存在即严格校验、缺失则兼容」；域版本保持 1。
7. 单元测试（3 个文件，20 个用例）覆盖任务描述列出的每一条，含四类故障注入。
8. `packages/core/README.md` 增加 board 接线契约章节；本记录；最后跑验收命令。

## 3. 实际改动

### 3.1 新增文件

| 文件 | 内容 |
| --- | --- |
| `packages/core/src/scopeRecord.ts` | scope head 的共享辅助：`emptyScope`/`normalizeScope`/`readScopeRecord`/`readAllScopeRecords`/`chainOf`/`currentEntryOf`/`computeRecheck`/`appendActivity`/`markRecheck`/`clearRecheckTarget`（从 `core.ts` 抽出，F01 与成对确认共用同一份语义） |
| `packages/core/src/taskModel.ts` | `TASK_STATUSES`/`TASK_STATUS_LABELS`/`BOARD_COLUMNS`、`isTaskStatus`/`statusRank`/`isTerminalStatus`、标题与目标规范化、`isCosmeticGoalChange`、`taskIdOf`、`progressLineOf`、`compareTasks` |
| `packages/core/src/planning.ts` | `createPlanningApi({port, now})`：F01 的全部服务方法（见 README 契约） |
| `packages/core/test/f01Harness.ts` | F01 测试夹具（两个**同名**项目、窄化辅助） |
| `packages/core/test/f01-project-isolation.test.ts` | 6 个用例：同名项目不合并、任务不跨项目、未登记/读取失败三态、位置各自保留、工作范围不可用仍可读写、五列契约 |
| `packages/core/test/f01-task-create-edit.test.ts` | 12 个用例：空白标题、无副作用创建、连点/重试幂等、故障注入与结果核对、阻塞原因、归属固定、键入 vs 实质保存、纯排版、重命名 vs 目标变化、保存失败与重启恢复、基线过期、F01-R06 字段不被回滚 |
| `packages/core/test/f01-activity.test.ts` | 2 个用例：活动历史内容（含不含键入、最新在前、限制条数、重启保留）、按项目/任务隔离 |

### 3.2 修改文件

| 文件 | 改动 |
| --- | --- |
| `packages/core/src/types.ts` | 新增 F01 类型（`TaskStatus`/`ActivityEntry`/`TaskFields`/`ProjectFields`/`TaskView`/`ProjectView`/`BoardReadResult`/各类 outcome）；`ScopeStateRecord` 增 `activity`/`task`/`project`；`RecheckReason.code` 增 `'goal-changed'`；`ConfirmInput.fieldBaseline?`；committed 结果增 `fieldsChangedSinceBaseline`/`fieldsBaseline`；`KanbanCore` 增 15 个方法 |
| `packages/core/src/core.ts` | 删除本地重复辅助（改用 `scopeRecord.ts`）；所有写槽位先 `normalizeScope`；提交时在同一次写追加 `pair-confirmed` 活动条目；提交结果回报任务字段基线是否过期 |
| `packages/core/src/domainSpec.ts` | `isScopeStateRecord` 增加 `activity`/`task`/`project` 的可选严格校验（缺失兼容 S0 文档） |
| `packages/core/src/index.ts` | 从包根导出 `taskModel`/`scopeRecord`/`planning` 的公共面（`isConfirmableDraftState` 改由 `scopeRecord` 导出） |
| `packages/core/README.md` | 新增「F01 契约：项目隔离与任务字段（board 接线用）」章节；更新命令测试数、记录形状与 PRD 对应表 |

### 3.3 关键设计（为什么这样做）

1. **F01 字段放进 scope head，而不是新建一张 `tasks` 表。** 这样「改字段 + 写活动历史 + 标记待核对」是**一次 `put`**：不存在「字段保存成功但待核对标记没写」的中间态（与 ADR-002 的单写理由同源）。域与表数量不变，既有测试 `restart.test.ts` 对表清单的断言也无需放宽。
2. **任务 id 派生自 `(projectId, requestId)`。** REC-02 要求「同一次提交连点/超时重试只产生一个任务」；把身份做进 id 使这一条**由结构保证**，而不是靠去重检查。摘要（digest）只是为了 id 短，身份另有 `task.projectId`/`task.requestId` 字段校验，碰撞会被 `request-id-collision` 拒绝而**不会合并**。
3. **「实质更新」的判定放在显式入口。** 读取、打开页面、`saveFieldDraft` 都不动 `updatedAt`/`fieldsRevision`；只有 `updateTaskFields` 成功才推进。测试用写次数（0 次 vs 1 次）与时间戳同时证明。
4. **目标变化的标记与目标写在同一次 `put`。** 目标实质变化 → `recheck.taskSummary` 置 `goal-changed`；未核对前 `confirmPaired` 以 `recheck-pending` 阻断（SAVE-04），核对后（同一确认里更新概况或 `confirmUnchanged`）解除。
5. **工作范围是三态观测，不是布尔。** `unknown`（尚未观测）与 `missing-dir`（确认不可用）分开；只有后者拒绝真实文件系统动作，两者都不影响管理数据读写，且 `path` 永不被改写。
6. **域版本保持 1 + 可选字段。** 若 bump 到 2，S0 写入的同一文档会 open 失败即等于数据损失；改为「缺失则回填、存在则严格校验」，兼容与 fail-loud 兼得（`single` 布局下损坏仍然 open 报错）。

## 4. 技术决定链接

- [ADR-002 成对确认的单写原子性](../../../engineering/decisions/ADR-002-paired-confirmation-single-write.md)（复用，未修改）
- [ADR-003 项目映射与默认背景注入](../../../engineering/decisions/ADR-003-project-mapping-and-context-injection.md)（项目键/工作范围/失效表达）
- 对外契约：[packages/core/README.md § F01 契约](../../../../packages/core/README.md)

**本阶段未新增 ADR 的理由**：F01 的技术选择都是既有两个 ADR 的直接推论（单写载体、项目键、范围失效表达），没有引入新的可选方案；因此按 [决策目录规则](../../../engineering/decisions/README.md) 不写重复记录。

## 5. 歧义与判断（按「选择满足不变量的一种读法并记录」处理）

| # | 歧义 | 采用读法 | 依据 |
| --- | --- | --- | --- |
| A1 | 「位置保留」（第 3 节流程 7 / AT-02）指什么 | 持久化每项目 `{selectedTaskId, view}`；滚动条与展开状态属于 UI 本地，不入库 | 需要「切换后恢复另一项目自身位置」的可核对证据；把逐像素滚动写进 core 会制造第二套状态 |
| A2 | 目标仅空白差异 是否算变化 | 算**纯排版**：`no-change`、0 次写、不标记待核对；正式值保持 | SAVE-04「纯排版无需核对」+ F01-R05「成功的实质修改才更新时间」；若照样写入，就会出现「没有实质修改却更新了时间」 |
| A3 | 概况存在但正文为空（明确清空）时卡片进展 | `summaryProgress: null` ⇒ 卡片回退显示任务目标 | OBJ-08「无概况用目标」；空概况没有可显示的整体进展，但要靠 `hasSummary` 让 UI 知道「有概况且被清空」 |
| A4 | 创建任务时项目未登记 | 以 `unknown-project` 拒绝（不猜测位置），宿主须先 `registerProject` | REC-05「目标项目/工作范围不确定不写入猜测位置」 |
| A5 | 确认时任务字段基线过期是否阻断保存 | **只报告**（`fieldsChangedSinceBaseline: true`），提交仍生效，字段不被回滚 | AT-29 的预期是「确认记录后当前字段仍是修改后的值、相关范围需核对」；阻断会让该 AT 场景无法完成 |
| A6 | 「结果未知」如何表达 | 写失败返回 `failed` + `taskId`/`requestId`，并要求先 `lookupCreate`；同 `requestId` 重试安全 | REC-03「先核对实际结果，不猜完成、不盲目重发」 |
| A7 | 状态流转是否属于 F01 | **不**。F01 只在创建时接受 `initialStatus`（阻塞必填原因）；流转/重排/撤销留给 F02（task-7） | PRD 第 1 节「状态流转与卡片详情呈现由 F02 实现」 |

**已知局限（未在 S1 解决，已如实记录）**

1. **并发创建的 `order` 可能相同**：两个不同 `requestId` 在同一写槽位前读到同一个 `max(order)` 时会得到相同序号。排序仍确定（`order` → `createdAt` → `taskId`），F02 的手动重排会改写 `order` 使其恢复唯一；单窗口 UI 下不可达。
2. **活动历史无上限**：条目只在重要变化时追加（不记录键入），但长期使用会缓慢增长，且 `single` 布局下随 head 一起重写（ADR-002 第 6 节已记录写放大代价）。若后续成为问题，应把历史链拆到第二个域（ADR-002 的缓解路径），而不是改变语义。
3. **`createTask` 需要项目已登记**：这是刻意的（A4），但要求宿主在激活/切换项目时先 `registerProject`；未登记时创建会以明确错误被拒绝，而不是静默落到「猜测的项目」。
4. **本阶段无 UI**：`packages/plugin`/`packages/plugin-client` 的接线与视觉呈现由 `board` 完成；core 只保证数据与语义。

## 6. 证据（本记录只写实际跑过的命令与输出）

```text
$ pnpm run typecheck                                  # tsc -b（工作区）
EXIT=0（无输出）

$ pnpm -r --if-present run test
packages/core        Test Files 10 passed (10)   Tests 55 passed (55)
packages/plugin      Test Files  2 passed (2)    Tests 26 passed (26)
packages/plugin-client Test Files 1 passed (1)   Tests  7 passed (7)
EXIT=0

$ python docs/engineering/tools/check_docs.py
PASS: 51 Markdown files; 20 PRDs; 48 common rules; 142 local rules.
PASS: unchanged baseline; 422 FR source units; 16 UX rules; 106 original ATs with primary acceptance references.
PASS: local links; unique IDs; acyclic dependencies; no later-stage dependencies; root documentation boundary.
EXIT=0
```

F01 新增的 20 个用例（`f01-project-isolation` 6 + `f01-task-create-edit` 12 + `f01-activity` 2）全部通过；S0 既有 35 个用例保持通过（**本项目内的测试不构成产品验收**，AT-01/AT-02/AT-29 的实际操作证据留给 `verification.md`）。

## 7. 遗留与交接

- **交接给 `board`（task-5/task-8）**：只经 [core README 的 F01 契约](../../../../packages/core/README.md) 调用；不得在 UI/host 半自建状态机、任务字段或第二套存储访问。缺接口时 `send_message` 给 `platform`，不要自行扩展 core。
- **交接给 F02 core（task-7）**：`TaskFields` 已预留 `statusRevision`/`lastStatusUpdateId`/`order`/`blockedReason`/`archived`；活动历史已有 `task-status-changed`/`task-blocked`/`task-unblocked`/`task-reopened`/`task-order-changed`/`task-undo-refused` 词表待写；撤销竞争判定应使用 `statusRevision`（版本/身份）而非时间戳。
- **交接给 F03 core（task-6）**：手动概况/总览草稿走 `drafts` 表既有槽位，正式保存走 `confirmPaired`；`TaskView.summaryProgress` 只读正式概况，因此手动保存成功后卡片会自动更新。
- **未实现（不在 S1 范围）**：批量创建、AI 拆解目标、跨项目搜索/筛选/排序偏好（F16）、归档与删除（F17/F09）、状态流转 UI（F02）。
- **待执行**：AT-01、AT-02、AT-29 的产品级验收（含 UI 实际操作与故障注入的端到端复现）；`packages/plugin`/`packages/plugin-client` 的座位与工具接线验证。
