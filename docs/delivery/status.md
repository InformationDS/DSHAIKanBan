# 交付状态

更新日期：2026-10-14。此页是工程实现与验证进度唯一入口。**S0 开发准备已成形**：插件骨架可构建、可测试，并已在隔离宿主中取得真实加载证据；**F01—F20 均未实现，产品用例未执行**。

## 当前工作

- 文档拆分：已形成 20 份小 PRD、5 份公共规则、基线迁移、阶段路线和逐条映射。
- 文档验证：已通过链接、编号、依赖、基线哈希、原需求/交互/验收映射检查；扫描范围仅限项目文档（排除 vendor 与构建产物）。产品验收未执行。
- **S0 开发准备（本次）**：
  - 形态决定为 **DSH 插件包**（host 半 + 浏览器半），源码 `packages/`；真实命令见根 [README](../../README.md) 与 [tools/COMMANDS.md](../../tools/COMMANDS.md)。
  - 四项技术决策已记录：[ADR-001 会话派发与整理执行载体](../engineering/decisions/ADR-001-session-dispatch-and-consolidation-carrier.md)、[ADR-002 成对确认单写模型](../engineering/decisions/ADR-002-paired-confirmation-single-write.md)、[ADR-003 项目映射与背景注入](../engineering/decisions/ADR-003-project-mapping-and-context-injection.md)、[ADR-004 界面挂载点与看板形态](../engineering/decisions/ADR-004-界面挂载点与看板形态.md)。四份均为**提议**状态。
  - 宿主能力 HOST-01—HOST-10 已逐条填写接入路径与核对结果，未覆盖项明确标「未验证」，见[宿主能力合同](../engineering/host-capabilities.md)。
  - 依据：S0-W2 以真实存储包做故障注入/并发/重启实验（25/25 检查）；S0-W3 在隔离宿主中以真实进程验证派发、幂等、子代理边界、注入恰好一次与全部 8 项项目映射行为（20/20 步骤）。
- 下一步工程工作：**S1 实现中**。F01 核心（`packages/core`）已完成并经复核：新增 20 个 F01 用例，`packages/core` 由 35 增至 **55 用例通过**；全仓 `typecheck` EXIT 0、`pnpm -r` 测试 **88 用例通过**（core 55 + plugin 26 + plugin-client 7）、`verify-host-import.mjs` OK、`check_docs.py` PASS。**尚缺**：board 侧接线（看板界面与 host 半工具）、F01 的 `verification.md` 功能验收证据，故 F01 整体仍为进行中。
- 本会话新增技术决策 [ADR-005 浏览器半与宿主半的数据通道](../engineering/decisions/ADR-005-浏览器半与宿主半的数据通道.md)：原采纳的 `host.call` 经复核**被否决**（只存在于动态 Cordis 包沙箱，普通 Loader 插件无法注册），改用 `ctx.connection.rpc`——已鉴权、随插件 fiber 卸载、无需自建路由或令牌。状态 `提议`，待真实 profile 观察到一次成功调用后方可转 `采用`。
- OQ-01 运行中整理反馈仍需局部决定，不阻止无关功能。

## 内部构建门（S1 起生效）

每次功能交付必须同时满足，缺一不可，且须记录实际输出：

1. `pnpm run typecheck`（`tsc -b`）EXIT 0；
2. `pnpm run build` 成功；
3. `pnpm -r --if-present run test` 全绿；
4. `node tools\verify-host-import.mjs` 通过（宿主导入图无 bare specifier）；
5. `node tools\probe-host.mjs` PROBE OK（隔离宿主，不触碰正在运行的 GUI）；
6. `python docs/engineering/tools/check_docs.py` PASS；
7. **不得**用 `pnpm --filter`（本机同步盘上会无限挂起）。

此门是**工程内部校验**，不等于产品验收；功能验收另建 `verification.md` 并记录真实操作证据。

## S0 尚未验证（必须随实现补齐，不得记为已验证）

| 项 | 现状 | 缺什么 |
| --- | --- | --- |
| 真实模型产生的 `assistant/message` | 读取路径已验证（三条读通道对同一日志一致）；**live 未验证** | 隔离 home 刻意不含真实凭据（用户决定），故无人真实模型的回复 |
| 真实多步（工具调用驱动的 step 2） | 注入恰好一次已验证；**genuine 多步未验证** | 同上，需真实 provider |
| 装到真实 profile 并生效 | **未执行** | 需写 `~/.dsh` 并重启该 profile 进程；安装目标待用户确认（当前 GUI 实际运行 `desktop` profile，不是 `web`） |
| 客户端半渲染与交互 | **未验证** | 需实际打开 GUI 观察 `main` 面板与 `sidebar.panellist` 座位 |
| HOST-02/03/07/08/10 的完整语义 | **部分接入** | 逐条见宿主能力合同 |

## 功能状态

| 功能 | 阶段 | 需求 | 实现 | 功能验收 | 记录 |
| --- | --- | --- | --- | --- | --- |
| [F01 项目隔离与任务创建编辑](../prd/features/F01-project-and-tasks/prd.md) | S1 | 已拆分 | 未开始 | 待执行 | 尚无 implementation/verification |
| [F02 任务状态、卡片与详情](../prd/features/F02-task-status-and-cards/prd.md) | S1 | 已拆分 | 未开始 | 待执行 | 尚无 implementation/verification |
| [F03 手动维护任务概况与项目总览](../prd/features/F03-manual-summaries/prd.md) | S1 | 已拆分 | 未开始 | 待执行 | 尚无 implementation/verification |
| [F04 新建、继续与查看工作对话](../prd/features/F04-conversation-entry/prd.md) | S2 | 已拆分 | 未开始 | 待执行 | 尚无 implementation/verification |
| [F05 关联已有对话与固定归属](../prd/features/F05-conversation-binding/prd.md) | S2 | 已拆分 | 未开始 | 待执行 | 尚无 implementation/verification |
| [F06 形成任务记录与概况并确认](../prd/features/F06-task-record-workflow/prd.md) | S3 | 已拆分 | 未开始 | 待执行 | 尚无 implementation/verification |
| [F07 编辑记录后核对汇总](../prd/features/F07-edited-record-reconciliation/prd.md) | S3 | 已拆分 | 未开始 | 待执行 | 尚无 implementation/verification |
| [F08 并行记录与竞争汇总核对](../prd/features/F08-concurrent-confirmation/prd.md) | S3 | 已拆分 | 未开始 | 待执行 | 尚无 implementation/verification |
| [F09 关键结论适用性与人工修正](../prd/features/F09-conclusion-applicability/prd.md) | S3 | 已拆分 | 未开始 | 待执行 | 尚无 implementation/verification |
| [F10 正式记录手动编辑、历史与恢复](../prd/features/F10-record-history/prd.md) | S5 | 已拆分 | 未开始 | 待执行 | 尚无 implementation/verification |
| [F11 默认背景准备与发送时自动同步](../prd/features/F11-context-preparation-and-sync/prd.md) | S2 | 已拆分 | 未开始 | 待执行 | 尚无 implementation/verification |
| [F12 正式材料按需读取与背景复制](../prd/features/F12-record-retrieval-and-copy/prd.md) | S3 | 已拆分 | 未开始 | 待执行 | 尚无 implementation/verification |
| [F13 生成项目记录与总览并确认](../prd/features/F13-project-record-workflow/prd.md) | S4 | 已拆分 | 未开始 | 待执行 | 尚无 implementation/verification |
| [F14 任务重开与项目成果更新](../prd/features/F14-project-record-lifecycle/prd.md) | S4 | 已拆分 | 未开始 | 待执行 | 尚无 implementation/verification |
| [F15 集中待确认与行动提示](../prd/features/F15-pending-updates/prd.md) | S4 | 已拆分 | 未开始 | 待执行 | 尚无 implementation/verification |
| [F16 任务搜索、筛选与排序](../prd/features/F16-search-filter-sort/prd.md) | S5 | 已拆分 | 未开始 | 待执行 | 尚无 implementation/verification |
| [F17 归档、恢复与永久删除](../prd/features/F17-archive-and-delete/prd.md) | S5 | 已拆分 | 未开始 | 待执行 | 尚无 implementation/verification |
| [F18 中断恢复、保存反馈与 AI 降级](../prd/features/F18-recovery-and-offline/prd.md) | S5 | 已拆分 | 未开始 | 待执行 | 尚无 implementation/verification |
| [F19 语言、窗口与键盘体验](../prd/features/F19-desktop-accessibility/prd.md) | S5 | 已拆分 | 未开始 | 待执行 | 尚无 implementation/verification |
| [F20 聊天中的明确任务管理](../prd/features/F20-chat-task-management/prd.md) | S5 | 已拆分 | 未开始 | 待执行 | 尚无 implementation/verification |

## 状态更新约定

实现使用未开始/进行中/已实现/受局部阻塞，验收使用待执行/部分执行/通过/失败/结果需核对；记录指向实际文件和证据。PRD 文档存在不能把实现列改为已实现。部分 AT 跨功能前置未齐全，明确等待联合验收。

## 完成记录

| 日期 | 交付 | 实际核验与局限 |
| --- | --- | --- |
| 2026-10-14 | 20 份功能 PRD、5 份公共规则、基线迁移、开发路线与维护入口 | SHA-256 一致；422 个 FR 定位条目、16 个 UX、106 个 AT 映射完整；链接与依赖检查通过，交叉语义复核已修正。详细证据见[复核记录](document-review-20261014.md)，产品验收未执行 |
| 2026-10-14 | S0 开发准备：插件骨架、数据模型核心、四项 ADR、宿主能力逐条核对、真实命令 | 本机实际执行：`typecheck` exit 0；`build` 产出 host 半与 client 半；全部测试 10 文件 / **68 用例通过**；`verify-host-import.mjs` 11/11；隔离宿主 `probe-host.mjs` **PROBE OK 4/4**（组合含插件行、host 半从 profile 解析并激活、宿主发布浏览器行并服务 client.js、`apply()` 在宿主进程内执行）；存储原子性实验 **25/25**；宿主集成探针 **20/20**；`check_docs.py` PASS。**未执行**：装到真实 profile、客户端半渲染、真实模型的 assistant 回复与真实多步（原因见上表）。**F01—F20 均未实现** |
