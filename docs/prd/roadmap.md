# 分阶段实施路线

所有 F01—F20 均为首版 P0。阶段是实施和内部试用顺序，不降低最终标准。完整首版需要 S1—S5 全部功能及 106 个 AT、真实自用和目标用户试用；文档拆分完成不等于代码、宿主或产品验收完成。

## S0 开发准备

输出架构决定、宿主能力落实计划、源码/测试目录和真实运行命令；架构决定记入[技术决策记录](../engineering/decisions/README.md)（ADR 目录），实施与验证进展只登记到[交付状态](../delivery/status.md)。不能假设项目/对话/模型设置已实现；未定义的大桌面 Agent 能力不扩入看板 PRD。S0 的工程未决与宿主能力缺口见 [OQ-03](open-questions.md)。

进入 S1 的门槛：明确对象与保存合同、项目隔离、持久标识、版本/草稿保护、键盘/失败反馈基础；记录技术选择并建立可运行项目。当前 S0 尚未实施。

## 阶段闭环与门槛

| 阶段 | 功能 | 必须可演示与核对的结果 |
| --- | --- | --- |
| S1 本地任务管理 | F01 → F02/F03 | 空项目无示例；标题建卡、状态/阻塞、手动概况/总览、来源版本、失败留稿及重启保存；无 AI 可用 |
| S2 任务与对话连接 | F04 → F05 → F11 | 项目未关联和任务归属两入口、继续/固定关联、默认范围和下次发送自动同步；不发送不执行、重试不重复 |
| S3 跨对话接力 | F06 → F07 → F08/F09 → F12 | A 形成精简记录并成对确认，B 从正式当前背景继续；编辑核对、并发贡献、人工修正、检索片段与复制，旧结论不当事实 |
| S4 项目成果 | F13 → F14 → F15 | 完成后系统整理对话生成成果与总览、一次确认；缺来源透明、重开更新同一条目、待确认与行动提示分开 |
| S5 完整首版 | F10、F17 → F18；F17 → F16/F19；F18 → F20 | 四类历史/恢复、搜索归档删除、连续保存恢复/离线、桌面可达、聊天管理；全 AT、真实使用与阻断项核验 |

S1/S2 可内部试用，但不能作为删减成果闭环的正式首版。失败保留、幂等、成对保存、版本、适用性读取和键盘等公共规则从对应组件首次实现即有效，F18/F19 在 S5 进行完整跨流程核验。

S1 暂无来源记录，手动概况仍保存用户版本和明确修正合同。S2 背景包含有效修正标识；S3 F09 加入具体来源片段修正操作后必须联测 F03/F11/F12。F06 先具备整理必要正式材料读取，F12 扩展完整检索；不能假装不存在能力已可用。

## 直接依赖清单

此表与 [catalog](feature-catalog.json) 对齐；直接依赖是完整功能验收的最低前置，不等于所有跨功能协同。未来集成要求见各 PRD。

| 功能 | 阶段 | 前置功能 |
| --- | --- | --- |
| [F01](features/F01-project-and-tasks/prd.md) | S1 | S0 |
| [F02](features/F02-task-status-and-cards/prd.md) | S1 | F01 |
| [F03](features/F03-manual-summaries/prd.md) | S1 | F01 |
| [F04](features/F04-conversation-entry/prd.md) | S2 | F01、F02、F03 |
| [F05](features/F05-conversation-binding/prd.md) | S2 | F04 |
| [F06](features/F06-task-record-workflow/prd.md) | S3 | F03、F04、F05、F11 |
| [F07](features/F07-edited-record-reconciliation/prd.md) | S3 | F06 |
| [F08](features/F08-concurrent-confirmation/prd.md) | S3 | F06、F07 |
| [F09](features/F09-conclusion-applicability/prd.md) | S3 | F03、F06、F07 |
| [F10](features/F10-record-history/prd.md) | S5 | F07、F09、F13 |
| [F11](features/F11-context-preparation-and-sync/prd.md) | S2 | F03、F04、F05 |
| [F12](features/F12-record-retrieval-and-copy/prd.md) | S3 | F06、F09、F11 |
| [F13](features/F13-project-record-workflow/prd.md) | S4 | F02、F06、F07、F08、F09、F12 |
| [F14](features/F14-project-record-lifecycle/prd.md) | S4 | F13 |
| [F15](features/F15-pending-updates/prd.md) | S4 | F03、F06、F13、F14 |
| [F16](features/F16-search-filter-sort/prd.md) | S5 | F02、F09、F14、F15、F17 |
| [F17](features/F17-archive-and-delete/prd.md) | S5 | F04、F05、F13、F14、F15 |
| [F18](features/F18-recovery-and-offline/prd.md) | S5 | F08、F10、F11、F13、F17 |
| [F19](features/F19-desktop-accessibility/prd.md) | S5 | F02、F04、F07、F08、F13、F15、F17 |
| [F20](features/F20-chat-task-management/prd.md) | S5 | F02、F05、F06、F11、F12、F13、F17、F18 |

## 每次 vibecoding 的交付单元

选择一份小 PRD → 验证直接依赖 → 读最小公共规则 → 写 implementation → 实现可运行行为和错误路径 → 执行本功能验收 → 写 verification，并把实现与验收状态登记到[交付状态](../delivery/status.md) → 条件齐全时联测所属阶段。

若仍过大，优先按一个完整正常闭环加明确规则变体拆子任务，保留功能 PRD 为规则入口，不按纯 UI/纯 API/纯存储分成对用户无可用结果的需求。不要用大段原 PRD 替代当前功能输入。

## 未决与排除首版边界

[OQ-01](open-questions.md) 已于 2026-10-19 由用户决定并落为 F06-R09 与 AT-129：运行中点击整理采用最小提示、不阻断，不新增全项目队列关卡。当前边界只剩 [OQ-02](open-questions.md) 排除首版与 [OQ-03](open-questions.md) 工程未决；备份 FR-27 与 OQ-02 排除首版，P1/P2 候选未进入开发。

阶段调整时保持功能编号与路径，只更新 catalog、路线、状态以及受影响验收，不移动功能目录。不得因调整阶段改变业务规则或优先级。
