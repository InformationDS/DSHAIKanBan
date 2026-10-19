# 小 PRD 索引

先读 [overview](overview.md) 了解范围，再按 [roadmap](roadmap.md) 选择一个功能；进入对应 prd.md 后，只读取其指定公共规则和依赖合同。每个功能具有稳定编号，目录不随阶段改变。

## 当前有效需求

[产品总览](overview.md) + [公共规则](common/objects-and-states.md)及其他 common 文件 + 本页 20 个功能 PRD 共同构成需求。原 v1.17 仅作为[历史基线](baseline/AIKanBan_桌面版功能PRD_v1.17.md)。当前实现/验收状态见[交付状态](../delivery/status.md)，不在 PRD 内维护，不要把文档存在当功能实现。

## 功能清单

| ID | 小 PRD | 阶段 | 直接依赖 | 原 FR 来源 |
| --- | --- | --- | --- | --- |
| F01 | [项目隔离与任务创建编辑](features/F01-project-and-tasks/prd.md) | S1 | 无功能前置；需 S0 | FR-01、FR-02、FR-03 |
| F02 | [任务状态、卡片与详情](features/F02-task-status-and-cards/prd.md) | S1 | F01 | FR-03、FR-04、FR-05 |
| F03 | [手动维护任务概况与项目总览](features/F03-manual-summaries/prd.md) | S1 | F01 | FR-03、FR-17、FR-20、FR-24、FR-29 |
| F04 | [新建、继续与查看工作对话](features/F04-conversation-entry/prd.md) | S2 | F01、F02、F03 | FR-08、FR-09、FR-11 |
| F05 | [关联已有对话与固定归属](features/F05-conversation-binding/prd.md) | S2 | F04 | FR-10、FR-14 |
| F06 | [形成任务记录与概况并确认](features/F06-task-record-workflow/prd.md) | S3 | F03、F04、F05、F11 | FR-13、FR-14、FR-15、FR-16、FR-18 |
| F07 | [编辑记录后核对汇总](features/F07-edited-record-reconciliation/prd.md) | S3 | F06 | FR-16、FR-17、FR-18、FR-29 |
| F08 | [并行记录与竞争汇总核对](features/F08-concurrent-confirmation/prd.md) | S3 | F06、F07 | FR-12、FR-15、FR-19、FR-28 |
| F09 | [关键结论适用性与人工修正](features/F09-conclusion-applicability/prd.md) | S3 | F03、F06、F07 | FR-13、FR-17、FR-20、FR-24、FR-31 |
| F10 | [正式记录手动编辑、历史与恢复](features/F10-record-history/prd.md) | S5 | F07、F09、F13 | FR-20、FR-29 |
| F11 | [默认背景准备与发送时自动同步](features/F11-context-preparation-and-sync/prd.md) | S2 | F03、F04、F05 | FR-21、FR-22、FR-31 |
| F12 | [正式材料按需读取与背景复制](features/F12-record-retrieval-and-copy/prd.md) | S3 | F06、F09、F11 | FR-21、FR-23、FR-31 |
| F13 | [生成项目记录与总览并确认](features/F13-project-record-workflow/prd.md) | S4 | F02、F06、F07、F08、F09、F12 | FR-24、FR-25 |
| F14 | [任务重开与项目成果更新](features/F14-project-record-lifecycle/prd.md) | S4 | F13 | FR-24、FR-25 |
| F15 | [集中待确认与行动提示](features/F15-pending-updates/prd.md) | S4 | F03、F06、F13、F14 | FR-05、FR-26 |
| F16 | [任务搜索、筛选与排序](features/F16-search-filter-sort/prd.md) | S5 | F02、F09、F14、F15、F17 | FR-06 |
| F17 | [归档、恢复与永久删除](features/F17-archive-and-delete/prd.md) | S5 | F04、F05、F13、F14、F15 | FR-07 |
| F18 | [中断恢复、保存反馈与 AI 降级](features/F18-recovery-and-offline/prd.md) | S5 | F08、F10、F11、F13、F17 | FR-28、FR-29、FR-31 |
| F19 | [语言、窗口与键盘体验](features/F19-desktop-accessibility/prd.md) | S5 | F02、F04、F07、F08、F13、F15、F17 | FR-30 |
| F20 | [聊天中的明确任务管理](features/F20-chat-task-management/prd.md) | S5 | F02、F05、F06、F11、F12、F13、F17、F18 | FR-32 |

## 按需公共规则

| 文件 | 规则编号 | 内容 |
| --- | --- | --- |
| [对象与状态](common/objects-and-states.md) | OBJ-01—10 | 项目、归属、四类内容、状态、草稿计数、删除来源 |
| [确认与版本](common/confirmation-and-versions.md) | SAVE-01—10 | 草稿、成对确认、编辑核对、并发、人工修正、版本恢复 |
| [结论适用性](common/conclusion-applicability.md) | APP-01—08 | 修正片段、范围、当前读取、验证边界、历史恢复 |
| [背景规则](common/context-rules.md) | CTX-01—10 | 默认范围、检索、历史/原文、实际使用、同步、快照、复制 |
| [保存与恢复](common/persistence-and-recovery.md) | REC-01—10 | 失败、重试、中断、损坏保护、离线、桌面基础、备份边界 |

当前小 PRD 是完整行为切片，不要求每份完全无依赖。F06 已包含正常成对确认，F07/F08 扩展编辑和竞争；S2 F04/F05/F11 与 S3 F06—F09/F12 均需阶段联合验收，不能以单文件完成宣称阶段完整。

## 开始编码前

1. 核对 S0 宿主与工程能力、直接依赖的实际实现和验证，缺口记录，不自行假定。
2. 明确本次功能范围与正常/失败闭环，参考 [单功能开发任务](templates/vibecoding-task.md)。
3. OQ-01 未决/待定，仅影响运行中整理局部分支；其余已确定路径可先实现。FR-27 排除首版，不开发。
4. 实现开始才建 implementation.md，验收开始才建 verification.md；进度与验收状态只在[交付状态](../delivery/status.md)维护，不在 PRD 内混写。

需求追溯见 [traceability](traceability.md)，新功能写法见 [模板](templates/feature-prd.md)，未决见 [open-questions](open-questions.md)。
