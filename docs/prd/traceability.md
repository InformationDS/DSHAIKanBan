# 原始需求追溯与覆盖

本次拆分保持 v1.17 业务语义，只调整组织、阅读量与开发顺序。原文件逐字迁入 baseline，SHA-256 为 `4c53cdf3182c5fbe23ac2b07ef9681bdda32759a0651619b74da1a3bf51477a3`。

## 追溯方式

- [条款映射](mapping/requirements.csv)：每个 FR 下的非空正文、列表项和内容表格行一个稳定 C 编号，含原始行号、主要负责功能、公共规则及 90 字以内定位摘要。表头也作为结构条目保留；表格分隔线和小标题不作为行为条款。原行号以冻结基线为准。
- [验收映射](mapping/acceptance.csv)：完整 106 个 AT 的原场景、原通过标准、主要验收功能、原 FR 与按来源推导的协同候选。一个场景只有一个主要责任方，可需多个功能联合验收；协同候选不强制全部成为直接依赖。
- [交互规则映射](mapping/interaction.csv)：UX-01—16 的原规则、行号与主要责任功能；共享行为从组件首次实现有效。
- 列表中的 owner 表示主维护/验收责任，不表示其他引用方免于遵守。公共规则与小 PRD 中相关实现规则仍是有效正文；映射不替代它们。
- FR-27 明确 excluded；运行中整理的未决分支记录 pending-boundary/OQ-01，均没有通过拆分变成默认开发功能。混合 P0/P1/P2 条款须读有效 PRD 明确范围，不整行升级候选。
- 基线第 1—7、13—17 章及附录含全局背景/约束，按下表整体映射；其中 FR 的细条款和全部 AT 另有逐行索引。

## 原文整体归属

| 基线章节 | 有效归属 |
| --- | --- |
| 1—3 产品、问题、用户、边界 | [overview](overview.md)、宿主能力（实施阶段确定） |
| 4 原则、UX-01—16、动作 | [对象状态](common/objects-and-states.md)、[确认版本](common/confirmation-and-versions.md)、相关功能 PRD |
| 5 页面职责 | overview 及 F02/F04/F05/F13/F15 |
| 6 对象、状态、来源 | 全部 common，尤其 OBJ 与 CTX |
| 7 用户流程 | S1—S4 功能与 [路线](roadmap.md)；保存流程见 REC |
| 8—12 FR-01—32 | 下表及逐条 CSV；FR-27 排除 |
| 13 异常与文案 | 各功能异常节、REC、SAVE、CTX |
| 14 范围及约束 | overview、roadmap、common、open-questions |
| 15.1 AT-01—106 | acceptance.csv、[验收映射](mapping/acceptance.csv)、各主要功能验收节 |
| 15.2—15.3 自用与阻断 | acceptance.csv、overview |
| 16 指标与验证 | overview、acceptance.csv；无已达成指标 |
| 17 确定决定与评审 | common、相关功能、[未决](open-questions.md) |
| 附录 A 动作边界 | OBJ-10、CTX、SAVE、各功能规则 |

## FR 条款主责任分布

| FR | 定位条目数 | 主要责任方 |
| --- | --- | --- |
| FR-01 | 8 | [F01](features/F01-project-and-tasks/prd.md) |
| FR-02 | 8 | [F01](features/F01-project-and-tasks/prd.md) |
| FR-03 | 16 | [F01](features/F01-project-and-tasks/prd.md)、[F02](features/F02-task-status-and-cards/prd.md)、[F03](features/F03-manual-summaries/prd.md)、[F06](features/F06-task-record-workflow/prd.md) |
| FR-04 | 10 | [F02](features/F02-task-status-and-cards/prd.md) |
| FR-05 | 8 | [F02](features/F02-task-status-and-cards/prd.md)、[F15](features/F15-pending-updates/prd.md) |
| FR-06 | 10 | [F16](features/F16-search-filter-sort/prd.md) |
| FR-07 | 14 | [F17](features/F17-archive-and-delete/prd.md) |
| FR-08 | 16 | [F04](features/F04-conversation-entry/prd.md)、[F11](features/F11-context-preparation-and-sync/prd.md) |
| FR-09 | 7 | [F04](features/F04-conversation-entry/prd.md)、[F11](features/F11-context-preparation-and-sync/prd.md) |
| FR-10 | 9 | [F05](features/F05-conversation-binding/prd.md) |
| FR-11 | 7 | [F04](features/F04-conversation-entry/prd.md)、[F06](features/F06-task-record-workflow/prd.md) |
| FR-12 | 8 | [F08](features/F08-concurrent-confirmation/prd.md) |
| FR-13 | 42 | [F06](features/F06-task-record-workflow/prd.md)、[F09](features/F09-conclusion-applicability/prd.md) |
| FR-14 | 22 | [F05](features/F05-conversation-binding/prd.md)、[F06](features/F06-task-record-workflow/prd.md)、[OQ-01](open-questions.md) |
| FR-15 | 20 | [F03](features/F03-manual-summaries/prd.md)、[F06](features/F06-task-record-workflow/prd.md)、[F08](features/F08-concurrent-confirmation/prd.md) |
| FR-16 | 23 | [F06](features/F06-task-record-workflow/prd.md)、[F07](features/F07-edited-record-reconciliation/prd.md) |
| FR-17 | 9 | [F02](features/F02-task-status-and-cards/prd.md)、[F03](features/F03-manual-summaries/prd.md)、[F08](features/F08-concurrent-confirmation/prd.md)、[F09](features/F09-conclusion-applicability/prd.md) |
| FR-18 | 10 | [F06](features/F06-task-record-workflow/prd.md) |
| FR-19 | 9 | [F08](features/F08-concurrent-confirmation/prd.md) |
| FR-20 | 11 | [F10](features/F10-record-history/prd.md) |
| FR-21 | 42 | [F11](features/F11-context-preparation-and-sync/prd.md)、[F12](features/F12-record-retrieval-and-copy/prd.md) |
| FR-22 | 14 | [F11](features/F11-context-preparation-and-sync/prd.md) |
| FR-23 | 7 | [F12](features/F12-record-retrieval-and-copy/prd.md) |
| FR-24 | 13 | [F03](features/F03-manual-summaries/prd.md)、[F09](features/F09-conclusion-applicability/prd.md)、[F11](features/F11-context-preparation-and-sync/prd.md)、[F13](features/F13-project-record-workflow/prd.md) |
| FR-25 | 22 | [F13](features/F13-project-record-workflow/prd.md)、[F14](features/F14-project-record-lifecycle/prd.md) |
| FR-26 | 9 | [F15](features/F15-pending-updates/prd.md) |
| FR-27 | 1 | [OQ-02](open-questions.md) |
| FR-28 | 9 | [F18](features/F18-recovery-and-offline/prd.md) |
| FR-29 | 8 | [F18](features/F18-recovery-and-offline/prd.md) |
| FR-30 | 9 | [F19](features/F19-desktop-accessibility/prd.md) |
| FR-31 | 10 | [F11](features/F11-context-preparation-and-sync/prd.md)、[F12](features/F12-record-retrieval-and-copy/prd.md)、[F18](features/F18-recovery-and-offline/prd.md) |
| FR-32 | 11 | [F20](features/F20-chat-task-management/prd.md) |

## 后续变更

保留基线和 C 编号原始来源不变。新业务规则在有效 PRD 中分配 Fxx-Rnn，新增验收可使用新增编号并写明来源日期；不要伪装成原 106 个 AT。更新映射中的实现归属和协同记录时保留原行号与场景文本。

`docs/tools/build_baseline_maps.py` 只用于从冻结基线重建初始映射；默认拒绝覆盖已有文件，并校验基线哈希。需要重建时先保存人工修订，再显式使用 `--overwrite-initial-maps` 并重新合并差异。日常维护不要重建，校验使用 `docs/tools/check_docs.py`。
