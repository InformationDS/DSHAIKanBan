# 联合验收计划与证据入口

本页保留全部原 106 个 AT 场景的责任入口；可执行操作与判断见主要功能 PRD 的验收节，原通过标准完整保存在 [验收映射](../prd/mapping/acceptance.csv)。当前全部为待执行，不代表产品已通过。

## 验证层次

1. 功能验收：直接依赖就绪后按当前 PRD 执行，记录实际结果和证据。
2. 阶段联合验收：S1—S5 按 [roadmap](../prd/roadmap.md) 闭环演示，检查实际发送正文、版本和来源而非仅按钮可点击。
3. 完整首版：全部 P0 和原 AT、真实自用及目标用户试用满足；阻断项为零。结构校验通过不能替代以上任何一层。

每个 AT 有一个主要责任功能，协同候选按原 FR 来源推导，具体协同以实际场景和 PRD 为准；它们不全部构成直接前置。跨功能验收不可因一个文件完成就报通过。

## AT 责任清单

| AT | 主要功能 | 原场景 | 当前状态 |
| --- | --- | --- | --- |
| AT-01 | [F01](../prd/features/F01-project-and-tasks/prd.md) | 空项目创建仅有标题的任务，AI 不可用 | 待执行 |
| AT-02 | [F01](../prd/features/F01-project-and-tasks/prd.md) | 两项目切换并各自确认记录 | 待执行 |
| AT-03 | [F02](../prd/features/F02-task-status-and-cards/prd.md) | 拖入阻塞，取消后再次填写；失败后撤销 | 待执行 |
| AT-04 | [F02](../prd/features/F02-task-status-and-cards/prd.md) | AI 阶段结束、任务记录确认、项目记录保存 | 待执行 |
| AT-05 | [F02](../prd/features/F02-task-status-and-cards/prd.md) | 无概况、有正式概况及有草稿时查看卡片 | 待执行 |
| AT-06 | [F16](../prd/features/F16-search-filter-sort/prd.md) | 搜索当前记录内容，再查看历史页面 | 待执行 |
| AT-07 | [F17](../prd/features/F17-archive-and-delete/prd.md) | 归档恢复进行中任务，有已有项目成果 | 待执行 |
| AT-08 | [F17](../prd/features/F17-archive-and-delete/prd.md) | 永久删除归档任务 | 待执行 |
| AT-09 | [F04](../prd/features/F04-conversation-entry/prd.md) | 任务内新建对话，快速重复点击 | 待执行 |
| AT-10 | [F04](../prd/features/F04-conversation-entry/prd.md) | 创建成功但归属或准备失败后重试 | 待执行 |
| AT-11 | [F11](../prd/features/F11-context-preparation-and-sync/prd.md) | 新对话准备好后不发送 | 待执行 |
| AT-12 | [F04](../prd/features/F04-conversation-entry/prd.md) | 多对话中继续某条并重复打开 | 待执行 |
| AT-13 | [F05](../prd/features/F05-conversation-binding/prd.md) | 未关联或已关联对话重启 | 待执行 |
| AT-14 | [F05](../prd/features/F05-conversation-binding/prd.md) | 尝试把已绑定 A 的对话关联到 B | 待执行 |
| AT-15 | [F04](../prd/features/F04-conversation-entry/prd.md) | 来源对话不能打开 | 待执行 |
| AT-16 | [F08](../prd/features/F08-concurrent-confirmation/prd.md) | 同任务两条对话同时推进并形成记录 | 待执行 |
| AT-17 | [F08](../prd/features/F08-concurrent-confirmation/prd.md) | A 先确认，B 随后确认其已编辑草稿 | 待执行 |
| AT-18 | [F08](../prd/features/F08-concurrent-confirmation/prd.md) | A/B 提出矛盾方案或不同验证结果 | 待执行 |
| AT-19 | [F06](../prd/features/F06-task-record-workflow/prd.md) | 某项测试未执行，某方案只是候选 | 待执行 |
| AT-20 | [F06](../prd/features/F06-task-record-workflow/prd.md) | 同对话形成记录后继续工作，再次形成 | 待执行 |
| AT-21 | [F06](../prd/features/F06-task-record-workflow/prd.md) | 放弃整理后重新形成记录 | 待执行 |
| AT-22 | [F06](../prd/features/F06-task-record-workflow/prd.md) | 对话工作结束后形成记录，成果仍有未验证部分 | 待执行 |
| AT-23 | [F07](../prd/features/F07-edited-record-reconciliation/prd.md) | 编辑/拒绝记录某分区，离开再返回 | 待执行 |
| AT-24 | [F06](../prd/features/F06-task-record-workflow/prd.md) | 确认中出现保存失败并重试 | 待执行 |
| AT-25 | [F06](../prd/features/F06-task-record-workflow/prd.md) | 无变化或仅一个对象实质变化 | 待执行 |
| AT-26 | [F03](../prd/features/F03-manual-summaries/prd.md) | 无对话时手动填任务概况，后续有对话记录 | 待执行 |
| AT-27 | [F09](../prd/features/F09-conclusion-applicability/prd.md) | 用户手动改概况或总览，AI 后续提出相反结论 | 待执行 |
| AT-28 | [F08](../prd/features/F08-concurrent-confirmation/prd.md) | 本条记录基础被改，与其他对话仅改概况分别测试 | 待执行 |
| AT-29 | [F08](../prd/features/F08-concurrent-confirmation/prd.md) | 任务目标或状态在审核期间被用户修改 | 待执行 |
| AT-30 | [F10](../prd/features/F10-record-history/prd.md) | 恢复任务记录或项目记录的历史版本 | 待执行 |
| AT-31 | [F11](../prd/features/F11-context-preparation-and-sync/prd.md) | 只增加历史规模，保持当前正式正文相同后新建对话 | 待执行 |
| AT-32 | [F12](../prd/features/F12-record-retrieval-and-copy/prd.md) | 新对话需要某项验证详情 | 待执行 |
| AT-33 | [F12](../prd/features/F12-record-retrieval-and-copy/prd.md) | 明确要求比较两个指定历史版本 | 待执行 |
| AT-34 | [F11](../prd/features/F11-context-preparation-and-sync/prd.md) | 展开历史列表/正文，再新建对话 | 待执行 |
| AT-35 | [F12](../prd/features/F12-record-retrieval-and-copy/prd.md) | 概况/总览过长需要精简 | 待执行 |
| AT-36 | [F11](../prd/features/F11-context-preparation-and-sync/prd.md) | 原对话已有相同背景，或背景有更新且正忙 | 待执行 |
| AT-37 | [F11](../prd/features/F11-context-preparation-and-sync/prd.md) | 取消未使用准备，再尝试取消实际已读内容 | 待执行 |
| AT-38 | [F13](../prd/features/F13-project-record-workflow/prd.md) | 用户标记完成并生成项目记录 | 待执行 |
| AT-39 | [F13](../prd/features/F13-project-record-workflow/prd.md) | 标记完成时对话仍运行或记录不齐 | 待执行 |
| AT-40 | [F13](../prd/features/F13-project-record-workflow/prd.md) | 选择按现有正式内容生成，部分成果尚未记录 | 待执行 |
| AT-41 | [F14](../prd/features/F14-project-record-lifecycle/prd.md) | 已有项目成果的任务重新打开，记录随后更新 | 待执行 |
| AT-42 | [F14](../prd/features/F14-project-record-lifecycle/prd.md) | 同任务再次完成并重新生成项目记录 | 待执行 |
| AT-43 | [F08](../prd/features/F08-concurrent-confirmation/prd.md) | 不同任务同时生成项目记录，先后确认 | 待执行 |
| AT-44 | [F03](../prd/features/F03-manual-summaries/prd.md) | 首个任务完成前手动初始化项目总览 | 待执行 |
| AT-45 | [F10](../prd/features/F10-record-history/prd.md) | 手动纠正已有项目成果或直接修正总览 | 待执行 |
| AT-46 | [F15](../prd/features/F15-pending-updates/prd.md) | 一组成对更新从详情和待确认列表处理 | 待执行 |
| AT-47 | [F18](../prd/features/F18-recovery-and-offline/prd.md) | 重启后打开项目并新建对话 | 待执行 |
| AT-48 | [F18](../prd/features/F18-recovery-and-offline/prd.md) | 数据读取失败、草稿恢复失败、中断状态未知 | 待执行 |
| AT-49 | [F18](../prd/features/F18-recovery-and-offline/prd.md) | AI 不可用时手动修改记录与汇总 | 待执行 |
| AT-50 | [F19](../prd/features/F19-desktop-accessibility/prd.md) | 中英切换、窄窗口、放大及只用键盘 | 待执行 |
| AT-51 | [F11](../prd/features/F11-context-preparation-and-sync/prd.md) | 临时补充或额外材料读取 | 待执行 |
| AT-52 | [F20](../prd/features/F20-chat-task-management/prd.md) | 聊天说阶段结束、明确完成任务、明确生成项目记录 | 待执行 |
| AT-53 | [F12](../prd/features/F12-record-retrieval-and-copy/prd.md) | 复制当前背景或复制失败 | 待执行 |
| AT-54 | [F08](../prd/features/F08-concurrent-confirmation/prd.md) | 两窗口确认同一更新或竞争修改汇总 | 待执行 |
| AT-55 | [F10](../prd/features/F10-record-history/prd.md) | 用户手动编辑已有对话记录 | 待执行 |
| AT-56 | [F14](../prd/features/F14-project-record-lifecycle/prd.md) | 项目草稿生成中源内容更新或任务重开 | 待执行 |
| AT-57 | [F04](../prd/features/F04-conversation-entry/prd.md) | 项目内新建未关联对话，并发送、暂停、继续 | 待执行 |
| AT-58 | [F05](../prd/features/F05-conversation-binding/prd.md) | 从任务详情搜索并关联项目已有未关联对话 | 待执行 |
| AT-59 | [F05](../prd/features/F05-conversation-binding/prd.md) | 未关联对话正在执行时建立归属，之后使用任务背景 | 待执行 |
| AT-60 | [F05](../prd/features/F05-conversation-binding/prd.md) | 未关联对话点击形成任务记录，选择/创建任务，中途取消或关联失败 | 待执行 |
| AT-61 | [F06](../prd/features/F06-task-record-workflow/prd.md) | 已有对话首次形成记录，关联前包含相关工作及闲聊 | 待执行 |
| AT-62 | [F17](../prd/features/F17-archive-and-delete/prd.md) | 已绑定对话的任务被删除，尝试关联另一个任务 | 待执行 |
| AT-63 | [F05](../prd/features/F05-conversation-binding/prd.md) | 重启后查询从未关联及已绑定任务的对话 | 待执行 |
| AT-64 | [F09](../prd/features/F09-conclusion-applicability/prd.md) | 记录最新版内方案 A 已被 B 替代，读取验证细节 | 待执行 |
| AT-65 | [F16](../prd/features/F16-search-filter-sort/prd.md) | 搜索命中已否定、已替代片段或待确认结论 | 待执行 |
| AT-66 | [F09](../prd/features/F09-conclusion-applicability/prd.md) | 已有项目成果引用后来被否定的任务结论，再读取或生成成果 | 待执行 |
| AT-67 | [F09](../prd/features/F09-conclusion-applicability/prd.md) | 先仅删除摘要一句，再明确否定来源结论并确认 | 待执行 |
| AT-68 | [F09](../prd/features/F09-conclusion-applicability/prd.md) | 本任务改变结论，同项目其他任务有同名方案；另有未裁定分歧 | 待执行 |
| AT-69 | [F10](../prd/features/F10-record-history/prd.md) | 恢复包含已否定结论的历史正文 | 待执行 |
| AT-70 | [F09](../prd/features/F09-conclusion-applicability/prd.md) | AI 再次整理最新保存记录中失效片段，或重启后读取 | 待执行 |
| AT-71 | [F11](../prd/features/F11-context-preparation-and-sync/prd.md) | 已有对话曾读 A，后来明确替代，再次查证该片段 | 待执行 |
| AT-72 | [F06](../prd/features/F06-task-record-workflow/prd.md) | 对话含重复问答、闲聊、已放弃方案与最终成果 | 待执行 |
| AT-73 | [F06](../prd/features/F06-task-record-workflow/prd.md) | 生成文件但未执行验证，另有失败测试 | 待执行 |
| AT-74 | [F06](../prd/features/F06-task-record-workflow/prd.md) | 保存记录后继续同一对话，再次形成记录 | 待执行 |
| AT-75 | [F09](../prd/features/F09-conclusion-applicability/prd.md) | 用户删除无关噪音并修正结论，随后再次整理 | 待执行 |
| AT-76 | [F11](../prd/features/F11-context-preparation-and-sync/prd.md) | 项目大量记录和历史，新建任务对话 | 待执行 |
| AT-77 | [F12](../prd/features/F12-record-retrieval-and-copy/prd.md) | 当前问题需要一个决策细节 | 待执行 |
| AT-78 | [F12](../prd/features/F12-record-retrieval-and-copy/prd.md) | 相关成果不足，需要同项目其他任务细节 | 待执行 |
| AT-79 | [F12](../prd/features/F12-record-retrieval-and-copy/prd.md) | 同一对话再次查同一未变化记录，随后记录更新 | 待执行 |
| AT-80 | [F12](../prd/features/F12-record-retrieval-and-copy/prd.md) | 正式记录不足，AI 需查其他对话原文或历史 | 待执行 |
| AT-81 | [F07](../prd/features/F07-edited-record-reconciliation/prd.md) | 用户将记录中验证通过改为尚未验证 | 待执行 |
| AT-82 | [F07](../prd/features/F07-edited-record-reconciliation/prd.md) | 仅删除重复描述且概况无需变化 | 待执行 |
| AT-83 | [F07](../prd/features/F07-edited-record-reconciliation/prd.md) | 概况已被用户编辑，再请求更新建议 | 待执行 |
| AT-84 | [F07](../prd/features/F07-edited-record-reconciliation/prd.md) | 更新建议失败，或概况/总览待核对时尝试正式保存 | 待执行 |
| AT-85 | [F07](../prd/features/F07-edited-record-reconciliation/prd.md) | 核对完成后再次实质修改记录，或概况基线更新 | 待执行 |
| AT-86 | [F06](../prd/features/F06-task-record-workflow/prd.md) | 从任务详情或对话点击形成任务记录 | 待执行 |
| AT-87 | [F06](../prd/features/F06-task-record-workflow/prd.md) | 已结束工作发起整理，重复点击 | 待执行 |
| AT-88 | [F06](../prd/features/F06-task-record-workflow/prd.md) | 已有多轮整理消息，再次形成任务记录 | 待执行 |
| AT-89 | [F13](../prd/features/F13-project-record-workflow/prd.md) | 完成任务后点击生成项目记录 | 待执行 |
| AT-90 | [F13](../prd/features/F13-project-record-workflow/prd.md) | 项目整理失败重试、编辑后更新建议、保存后新一轮生成 | 待执行 |
| AT-91 | [F06](../prd/features/F06-task-record-workflow/prd.md) | Agent 收到记录或汇总整理要求 | 待执行 |
| AT-92 | [F06](../prd/features/F06-task-record-workflow/prd.md) | 再次整理新增重复解释，无实质更新 | 待执行 |
| AT-93 | [F06](../prd/features/F06-task-record-workflow/prd.md) | 新内容产生更新草稿，随后保存成功、失败、取消或放弃 | 待执行 |
| AT-94 | [F06](../prd/features/F06-task-record-workflow/prd.md) | 完成处理后 Agent 输出整理回复，随后用户新增实际交流 | 待执行 |
| AT-95 | [F17](../prd/features/F17-archive-and-delete/prd.md) | 永久删除任务后打开其原对话并继续聊天 | 待执行 |
| AT-96 | [F17](../prd/features/F17-archive-and-delete/prd.md) | 已删除来源对话尝试形成记录、返回任务或改绑 | 待执行 |
| AT-97 | [F17](../prd/features/F17-archive-and-delete/prd.md) | 删除后在项目列表筛选及重启查询 | 待执行 |
| AT-98 | [F07](../prd/features/F07-edited-record-reconciliation/prd.md) | 记录与概况均保留未定方案或适用性分歧 | 待执行 |
| AT-99 | [F07](../prd/features/F07-edited-record-reconciliation/prd.md) | 同时存在待确认结论与概况一致性待核对 | 待执行 |
| AT-100 | [F05](../prd/features/F05-conversation-binding/prd.md) | 关联已有对话或任务内新建对话 | 待执行 |
| AT-101 | [F11](../prd/features/F11-context-preparation-and-sync/prd.md) | B 更新概况后，A 打开并发送新要求 | 待执行 |
| AT-102 | [F11](../prd/features/F11-context-preparation-and-sync/prd.md) | 概况跨多个版本更新，总览未变 | 待执行 |
| AT-103 | [F11](../prd/features/F11-context-preparation-and-sync/prd.md) | 旧对话无可靠使用基线，或首次绑定任务后发送 | 待执行 |
| AT-104 | [F11](../prd/features/F11-context-preparation-and-sync/prd.md) | 背景同步失败或发送结果未知，再重试 | 待执行 |
| AT-105 | [F11](../prd/features/F11-context-preparation-and-sync/prd.md) | 同一背景连续发送，或快照发送后背景更新 | 待执行 |
| AT-106 | [F11](../prd/features/F11-context-preparation-and-sync/prd.md) | 记录正文版本不变，但相关结论后来被否定 | 待执行 |

## 必须记录的证据

每次验证记录环境/应用版本、输入数据、前置对象版本、实际操作、看到的正式/草稿变化、实际发送正文及范围、失败/重试结果。仅有界面版本标签不证明材料实际送达；只有可核对结果才算已使用。

每功能 verification.md 汇总相关 AT；全局状态仍只更新 status.md。新增联合证据放本页所在目录并链接，不上传聊天、记录或代码全文作为默认体验统计。

## 真实自用验证

至少 3 个真实任务，每任务至少 2 条独立对话，涵盖：

- 形成记录一次确认同步概况，下一对话不复制全文即可继续；同对话多次更新保留历史、不累计默认历史正文。
- 并行记录竞争汇总，保留贡献和分歧；至少一次概况/总览人工修正未被 AI 静默覆盖。
- 记录不齐仍可完成并按明确范围生成项目成果；重开、再次完成更新同一条目且可查历史。
- 成对保存失败、中断草稿恢复、重启后新对话，不重复建对象/执行。
- 先未关联交流、后任务内关联及整条提炼；另一次在未关联对话选择/创建任务后继续整理，无消息区间选择。

实际核对目标、约束、进展、风险、下一步和发送范围。至少观察 10 次接力，建议 9 次无需复制旧聊天能正确继续；小样本不推断普遍成功率。

## 目标用户与使用假设

至少 5 位目标用户试用，至少 4 位能区分阶段记录/任务完成/项目成果。观察成对预览负担、编辑核对成本、同步正文准确度和生成/审核时继续原对话的频率；若整理期间无新增工作的假设不成立，回到 OQ-01 及相关需求讨论，不能擅扩首版。

## 上线阻断项

未确认内容作事实、默认历史全文注入、覆盖其他贡献/人工修正、半生效、准备自行执行、错误项目/任务归属、失败伪成功、重复版本/成果、删除波及聊天/代码、损坏读取/恢复清数据。发生任何一项就记录失败并修复，不能用其他通过项抵销。

## 本轮文档核验

只验证基线完整性、需求/AT 定位覆盖、链接、规则/功能编号、依赖无环与人工语义复核。结果记录在 [status](status.md)，不修改上表产品用例待执行状态。
