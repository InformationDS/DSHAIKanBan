# 原始需求追溯与覆盖

本次拆分保持 v1.17 业务语义，只调整组织、阅读量与开发顺序。原文件逐字迁入 baseline，SHA-256 为 `4c53cdf3182c5fbe23ac2b07ef9681bdda32759a0651619b74da1a3bf51477a3`。

## 追溯方式

- [条款映射](mapping/requirements.csv)：每个 FR 下的非空正文、列表项和内容表格行一个稳定 C 编号，含原始行号、主要负责功能、公共规则及 90 字以内定位摘要。表头也作为结构条目保留；表格分隔线和小标题不作为行为条款。原行号以冻结基线为准。
- [验收映射](mapping/acceptance.csv)：完整 106 个 AT 的原场景、原通过标准、主要验收功能、原 FR 与按来源推导的协同候选。一个场景只有一个主要责任方，可需多个功能联合验收；协同候选不强制全部成为直接依赖。
- [交互规则映射](mapping/interaction.csv)：UX-01—16 的原规则、行号与主要责任功能；共享行为从组件首次实现有效。
- [新增验收](mapping/acceptance-additions.csv)：功能 PRD §6 中原先没有编号的验收行，按各功能表格内出现顺序编号为 AT-107 起，记录原来源列、主责功能、可执行步骤、预期结果与登记日期 `source_date`。原 106 个 AT 冻结不变，新增项不伪装成原 AT；分工见下文「原始 106 个 AT 与新增验收的分工」。
- 列表中的 owner 表示主维护/验收责任，不表示其他引用方免于遵守。公共规则与小 PRD 中相关实现规则仍是有效正文；映射不替代它们。
- FR-27 明确 excluded；OQ-01 已于 2026-10-19 由用户决定并落为 F06-R09 + AT-129，原 pending-boundary 条款保留原行号与摘录不变（描述基线原状），不再作为开放问题。混合 P0/P1/P2 条款须读有效 PRD 明确范围，不整行升级候选。
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
| 15.1 AT-01—106（基线行 1084—1189） | acceptance.csv、[验收映射](mapping/acceptance.csv)、各主要功能验收节 |
| 15.2 真实自用验证（基线行 1191 起） | 无逐条映射条目；由 [overview](overview.md) 成功判断节散文概述，试用时按基线原文核对 |
| 15.3 上线阻断项（基线行 1208 起） | 无逐条映射条目；由 [overview](overview.md) 成功判断节末段散文概述，任何出现即首版阻断 |
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

## 原始 106 个 AT 与新增验收的分工

- [验收映射](mapping/acceptance.csv) 冻结为基线第 15.1 节的原始 106 个 AT（AT-01—AT-106），不得增删行或改号；其中场景、通过标准与来源 FR 须与基线逐字一致，仅协同功能列可维护。
- 功能 PRD §6 中原先没有编号的验收行，统一登记在 [新增验收](mapping/acceptance-additions.csv)，编号自 AT-107 起按功能与表格顺序连续分配，并逐条写明原来源列（`baseline_source`）、主责功能（`primary_owner` / `owner_path`）与登记日期（`source_date`，本批为 2026-10-19）。
- 新增验收是拆分时补齐的验收条目，不是基线第 15.1 节的原始 AT；引用时须按新增验收文件的编号与 `source_date` 说明来源，不得伪装成原 106 个 AT。
- 两个文件共同构成完整验收索引：acceptance.csv 对应基线原场景，acceptance-additions.csv 对应拆分时补齐的条目；各功能 PRD §6 的编号集合须与其「验收来源」一致，并分别落在上述两个文件中。
- 新增验收的校验由 `docs/tools/check_docs.py` 承担：编号须自 AT-107 起连续、不得复用原 106 个编号、`source_date` 须为日期、`kind` 限于「新增-本功能」与「新增-联合」，且每条须在其主责功能 §6 与「验收来源」中一致出现。该脚本只做文档结构与交叉一致性校验，不判定产品验收是否通过。

## 后续变更

保留基线和 C 编号原始来源不变。新业务规则在有效 PRD 中分配 Fxx-Rnn，新增验收可使用新增编号并写明来源日期；不要伪装成原 106 个 AT。更新映射中的实现归属和协同记录时保留原行号与场景文本。

`docs/tools/build_baseline_maps.py` 只用于从冻结基线重建初始映射；默认拒绝覆盖已有文件，并校验基线哈希。需要重建时先保存人工修订，再显式使用 `--overwrite-initial-maps` 并重新合并差异。日常维护不要重建，校验使用 `docs/tools/check_docs.py`。
