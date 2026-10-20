# 交付状态

更新日期：2026-10-20。本页是实现与验收**汇总状态**的唯一入口（功能级两列）；**逐条 AT 的结论**在各功能 `verification.md`，口径见[验收执行规则](../engineering/acceptance-execution.md)。其他文档只引用本页，不重复维护状态。

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
| 验收 | **引用** [验收执行规则](../engineering/acceptance-execution.md) 第 1.1 节的唯一词表：`待执行` / `通过（真实操作）` / `通过（含故障注入）` / `部分执行` / `失败` / `结果需核对`（本页不另立词表） | **功能级汇总口径**：该功能**所有已执行 AT 均为 `通过（真实操作）` 时才在功能级写 `通过（真实操作）`**；存在任何 `通过（含故障注入）` 时写 `部分执行` 并注明含注入，不得简写成不带限定的通过；存在未执行项时写 `待执行`；若**所有 AT 均已执行、每条为两种「通过」之一且至少一条依赖注入**，功能级写 `通过（真实操作，含注入分支）`（见验收执行规则 1.1.1，不得简写） |
| 记录 | 指向实际文件与证据 | 记录须指向真实的 implementation / verification 文件与命令输出 |

规则：记录必须指向实际文件与证据，不写预期结果；**PRD 文档存在不能把实现列为已实现**；未执行的 AT 不得写 `通过（真实操作）` 或 `通过（含故障注入）`；部分场景未就绪时写「结果需核对」或「待执行」，不伪报结果。功能级「验收」列只是**汇总**，逐条 AT 结论以各功能 `verification.md` 为准。

### 「进行中」的判定门槛（M3）

- **记「进行中」**：本功能**专属**实现已有落点（领域层、协议层或界面层任一），能指出具体模块/文件与至少一条测试或证据，但**端到端链路未接通**或本功能验收尚未执行。
- **仍记「未开始」**：只有公共通用机制或上游依赖的代码，**没有本功能专属实现与入口**（复用基础设施不算本功能实现）。
- **记「已实现」**：本功能端到端用户行为可运行，且**所有 AT 均已执行**、每条结论为 `通过（真实操作）` 或 `通过（含故障注入）`（不存在 `待执行`/`部分执行`/`失败`/`结果需核对`）；含注入分支时须在状态描述里保留该限定；未验收不得写「已实现」。
- 这样判定的理由与实例：**F01/F02 记「进行中」**，因为 `packages/core` 有 F01 项目隔离/任务字段与 F02 状态机/列顺序的专属实现、`packages/plugin-client` 有 F02 看板 UI，但端到端接线（core ↔ host ↔ 浏览器通道）未完成、验收未执行；**F06—F10 记「未开始」**，因为 core 里只有它们复用的通用机制（成对确认、版本链、草稿、适用性），各功能的入口流程（整理派发、编辑后核对交互、历史列表、项目成果生成）没有专属实现。
- 本贴合判定的证据与缺口见[回收代码盘点](../engineering/code-inventory-20261019.md)；AT 执行与证据口径见[验收执行规则](../engineering/acceptance-execution.md)，逐 AT 记录格式见[verification 模板](../prd/templates/verification.md)。

## 功能状态

阶段取自 [feature-catalog.json](../prd/feature-catalog.json)，与[实施路线](../prd/roadmap.md)一致。

| 功能 | 阶段 | 实现 | 验收 | 记录 |
| --- | --- | --- | --- | --- |
| [F01 项目隔离与任务创建编辑](../prd/features/F01-project-and-tasks/prd.md) | S1 | 进行中 | 待执行 | [implementation.md](../prd/features/F01-project-and-tasks/implementation.md)（现状盘点）、[s1-wiring.md](../engineering/s1-wiring.md)（切片 A/B 接线规格，依据 [ADR-007](../engineering/decisions/ADR-007-s1-wiring-and-current-project.md)）；verification 尚无 |
| [F02 任务状态、卡片与详情](../prd/features/F02-task-status-and-cards/prd.md) | S1 | 进行中 | 待执行 | [implementation.md](../prd/features/F02-task-status-and-cards/implementation.md)（现状盘点）、[s1-wiring.md](../engineering/s1-wiring.md)（切片 A/B 接线规格，依据 [ADR-007](../engineering/decisions/ADR-007-s1-wiring-and-current-project.md)）；verification 尚无 |
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

S0 在 `bd16535` **曾经实施**：插件双半包形态、`packages/core` 数据模型、五项 ADR、HOST-01—10 宿主能力核对，以及构建与探针工具链。该实现已在 `1890318` 从工作区移除；2026-10-19 已把**文档与工具层**复原（[架构准备](../engineering/architecture.md)、[宿主能力合同](../engineering/host-capabilities.md)、[技术决策记录](../engineering/decisions/README.md)〔ADR-001/002/003 采用；ADR-004/005 提议；ADR-006/007 已定〕、[tools/](../../tools/COMMANDS.md)），**`packages/` 已于 2026-10-19 回收（提交 `ed6b151`）并经 DSH 44.7.0 复核，补一处守卫后全门禁转绿**。

2026-10-19 在 **DSH 44.7.0** 上完成一次部分复核（见 [S0 复核记录](../engineering/s0-reverification-20261019.md)）：加载链与测试成立（probe 4/4、verify-host-import 11/11、149 个用例全绿），但 **`typecheck` 在原始提交上失败**——`packages/plugin-client/src/channel-source.ts:186` 一处 TS2322（`parseBoardWriteValue` 的 `snapshot` 合法可为 `null`，却被当作非空返回）；补一处 3 行空值守卫后 typecheck／build／测试／探针全绿。结论：**代码可低成本回收**；2026-10-19 已按此回收（提交 `ed6b151`），仍未复核项见复核记录。

仍未复核：装到真实 profile 并生效、客户端实际渲染、`tools=false` / `systemPrompt=false`（激活时刻未观察到）。2026-10-20 已补做的复验：20 步宿主集成 spike（20/20）与存储原子性 25/25 重跑通过，真实模型路径（真实 `assistant` 回复与真实多步）关闭——均见 [S0 复核记录](../engineering/s0-reverification-20261019.md) 第 8、9 节。工程未决仍见 [OQ-03](../prd/open-questions.md)；OQ-01 的运行中整理最小反馈已确定并落为 F06-R09 + AT-129，不再是缺口。HOST-07 的区分表达由 [ADR-006](../engineering/decisions/ADR-006-系统整理对话与工作来源的区分表达.md)（**已定**，2026-10-20 用户确认）确定；工程证据待取证（其第 11 节），取证前不得写成已验证。

## 维护约定

- 本页是唯一**汇总**状态来源（功能级实现/验收两列）：功能 PRD、路线与入口文档只引用本页，不各自维护另一套汇总状态；逐条 AT 的结论只在各功能 `verification.md`，两者是汇总与明细关系，不冲突、不重复。
- 状态变化时更新对应行并给出实际记录文件与证据；实现记录按功能目录的 `implementation.md`、验收记录按 `verification.md` 命名，文档存在不等于状态推进。**例外（S5 分工）**：跨功能接线（如切片 A）的实现记录写 `docs/engineering/s1-wiring-implementation.md`，不写进功能目录；功能实现仍写各自 `implementation.md`（见[验收执行规则](../engineering/acceptance-execution.md)与 [s1-wiring](../engineering/s1-wiring.md) §7.4）。
- 验收结论须引用 [验收映射](../prd/mapping/acceptance.csv) 中的编号与实际执行结果；跨功能场景未齐备时在「归属」列标注 `待联合验收`（**归属标记，不是结论词**），结论写 `待执行` 或 `部分执行`，不伪报通过类结论；逐 AT 的执行记录与证据档位按[验收执行规则](../engineering/acceptance-execution.md)，记录格式见 [verification 模板](../prd/templates/verification.md)。
