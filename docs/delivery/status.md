# 交付状态

更新日期：2026-10-19。本页是**工程实现与验证进度的唯一入口**；其他文档只引用本页，不重复维护状态。

## 当前范围

本仓库当前含有产品需求、治理载体、S0 工程记录与**回收的 S0/S1 实施代码**（`packages/`；2026-10-19 自 `bd16535` 逐字节复原，仅追加一处 3 行空值守卫）。**F01/F02 的 domain 层与看板 UI 已有回收实现（实现＝进行中），其余 F03—F20 的实现仍未开始；产品验收一条都未执行**——回收代码是 S0/S1 工程资产与起点，功能级实现与验收只以本页状态表为准；需求文档齐全、代码在仓库，都不等于功能已实现或已验收。逐模块资产盘点见[回收代码盘点](../engineering/code-inventory-20261019.md)。

- 需求入口：[文档入口](../README.md) → [产品总览](../prd/overview.md)
- 实施顺序：[分阶段实施路线](../prd/roadmap.md)
- 技术决策落点：[技术决策记录](../engineering/decisions/README.md)
- 代码资产盘点：[回收代码盘点 2026-10-19](../engineering/code-inventory-20261019.md)
- 未决边界：[未决事项](../prd/open-questions.md)（OQ-01 已于 2026-10-19 确定并落为 F06-R09 + AT-129，不再是缺口；S0 工程准备缺口仍见 OQ-03）

## 状态词表

| 维度 | 取值 | 说明 |
| --- | --- | --- |
| 实现 | 未开始 / 进行中 / 已实现 / 受局部阻塞 | 以代码与可运行行为为准；只有真实实现才能记为已实现 |
| 验收 | 待执行 / 部分执行 / 通过 / 失败 / 结果需核对 | 以实际执行记录与证据为准；未执行一律为待执行 |
| 记录 | 指向实际文件与证据 | 记录须指向真实的 implementation / verification 文件与命令输出 |

规则：记录必须指向实际文件与证据，不写预期结果；**PRD 文档存在不能把实现列为已实现**；未执行验收不得写为通过；部分场景未就绪时写「结果需核对」或「待执行」，不伪报通过。

## 功能状态

阶段取自 [feature-catalog.json](../prd/feature-catalog.json)，与[实施路线](../prd/roadmap.md)一致。

| 功能 | 阶段 | 实现 | 验收 | 记录 |
| --- | --- | --- | --- | --- |
| [F01 项目隔离与任务创建编辑](../prd/features/F01-project-and-tasks/prd.md) | S1 | 进行中 | 待执行 | [implementation.md](../prd/features/F01-project-and-tasks/implementation.md)（现状盘点；verification 尚无） |
| [F02 任务状态、卡片与详情](../prd/features/F02-task-status-and-cards/prd.md) | S1 | 进行中 | 待执行 | [implementation.md](../prd/features/F02-task-status-and-cards/implementation.md)（现状盘点；verification 尚无） |
| [F03 手动维护任务概况与项目总览](../prd/features/F03-manual-summaries/prd.md) | S1 | 未开始 | 待执行 | 尚无 implementation/verification |
| [F04 新建、继续与查看工作对话](../prd/features/F04-conversation-entry/prd.md) | S2 | 未开始 | 待执行 | 尚无 implementation/verification |
| [F05 关联已有对话与固定归属](../prd/features/F05-conversation-binding/prd.md) | S2 | 未开始 | 待执行 | 尚无 implementation/verification |
| [F06 形成任务记录与概况并确认](../prd/features/F06-task-record-workflow/prd.md) | S3 | 未开始 | 待执行 | 尚无 implementation/verification |
| [F07 编辑记录后核对汇总](../prd/features/F07-edited-record-reconciliation/prd.md) | S3 | 未开始 | 待执行 | 尚无 implementation/verification |
| [F08 并行记录与竞争汇总核对](../prd/features/F08-concurrent-confirmation/prd.md) | S3 | 未开始 | 待执行 | 尚无 implementation/verification |
| [F09 关键结论适用性与人工修正](../prd/features/F09-conclusion-applicability/prd.md) | S3 | 未开始 | 待执行 | 尚无 implementation/verification |
| [F10 正式记录手动编辑、历史与恢复](../prd/features/F10-record-history/prd.md) | S5 | 未开始 | 待执行 | 尚无 implementation/verification |
| [F11 默认背景准备与发送时自动同步](../prd/features/F11-context-preparation-and-sync/prd.md) | S2 | 未开始 | 待执行 | 尚无 implementation/verification |
| [F12 正式材料按需读取与背景复制](../prd/features/F12-record-retrieval-and-copy/prd.md) | S3 | 未开始 | 待执行 | 尚无 implementation/verification |
| [F13 生成项目记录与总览并确认](../prd/features/F13-project-record-workflow/prd.md) | S4 | 未开始 | 待执行 | 尚无 implementation/verification |
| [F14 任务重开与项目成果更新](../prd/features/F14-project-record-lifecycle/prd.md) | S4 | 未开始 | 待执行 | 尚无 implementation/verification |
| [F15 集中待确认与行动提示](../prd/features/F15-pending-updates/prd.md) | S4 | 未开始 | 待执行 | 尚无 implementation/verification |
| [F16 任务搜索、筛选与排序](../prd/features/F16-search-filter-sort/prd.md) | S5 | 未开始 | 待执行 | 尚无 implementation/verification |
| [F17 归档、恢复与永久删除](../prd/features/F17-archive-and-delete/prd.md) | S5 | 未开始 | 待执行 | 尚无 implementation/verification |
| [F18 中断恢复、保存反馈与 AI 降级](../prd/features/F18-recovery-and-offline/prd.md) | S5 | 未开始 | 待执行 | 尚无 implementation/verification |
| [F19 语言、窗口与键盘体验](../prd/features/F19-desktop-accessibility/prd.md) | S5 | 未开始 | 待执行 | 尚无 implementation/verification |
| [F20 聊天中的明确任务管理](../prd/features/F20-chat-task-management/prd.md) | S5 | 未开始 | 待执行 | 尚无 implementation/verification |

## S0 开发准备

S0 在 `bd16535` **曾经实施**：插件双半包形态、`packages/core` 数据模型、五项 ADR、HOST-01—10 宿主能力核对，以及构建与探针工具链。该实现已在 `1890318` 从工作区移除；2026-10-19 已把**文档与工具层**复原（[架构准备](../engineering/architecture.md)、[宿主能力合同](../engineering/host-capabilities.md)、[技术决策记录](../engineering/decisions/README.md)〔ADR-001/002/003 采用；ADR-004/005 提议；ADR-006 采用〕、[tools/](../../tools/COMMANDS.md)），**`packages/` 已于 2026-10-19 回收（提交 `ed6b151`）并经 DSH 44.7.0 复核，补一处守卫后全门禁转绿**。

2026-10-19 在 **DSH 44.7.0** 上完成一次部分复核（见 [S0 复核记录](../engineering/s0-reverification-20261019.md)）：加载链与测试成立（probe 4/4、verify-host-import 11/11、149 个用例全绿），但 **`typecheck` 在原始提交上失败**——`packages/plugin-client/src/channel-source.ts:186` 一处 TS2322（`parseBoardWriteValue` 的 `snapshot` 合法可为 `null`，却被当作非空返回）；补一处 3 行空值守卫后 typecheck／build／测试／探针全绿。结论：**代码可低成本回收**；2026-10-19 已按此回收（提交 `ed6b151`），仍未复核项见复核记录。

仍未复核：装到真实 profile 并生效、客户端实际渲染、`tools=false` / `systemPrompt=false`（激活时刻未观察到）。2026-10-20 已补做的复验：20 步宿主集成 spike（20/20）与存储原子性 25/25 重跑通过，真实模型路径（真实 `assistant` 回复与真实多步）关闭——均见 [S0 复核记录](../engineering/s0-reverification-20261019.md) 第 8、9 节。工程未决仍见 [OQ-03](../prd/open-questions.md)；OQ-01 的运行中整理最小反馈已确定并落为 F06-R09 + AT-129，不再是缺口。HOST-07 的区分表达已由 [ADR-006](../engineering/decisions/ADR-006-系统整理对话与工作来源的区分表达.md)（**采用**，2026-10-20 用户确认）确定；工程证据待取证，取证前不得写成已验证。

## 维护约定

- 本页是唯一状态来源：功能 PRD、路线与入口文档只引用本页，不各自维护另一套实现/验收状态。
- 状态变化时更新对应行并给出实际记录文件与证据；实现记录按功能目录的 `implementation.md`、验收记录按 `verification.md` 命名，文档存在不等于状态推进。
- 验收结论须引用 [验收映射](../prd/mapping/acceptance.csv) 中的编号与实际执行结果，跨功能场景未齐备时写待联合验收，不写通过。
