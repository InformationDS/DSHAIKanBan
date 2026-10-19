> 复原说明：本页为 2026-10-14 S0 记录的原文复原（来源提交 bd16535）。2026-10-19 已在 DSH 44.7.0 上做部分复核，结论见 [S0 复核记录](s0-reverification-20261019.md)；未复核部分仍是「提议」，不得当作已验证。

# AIKanBan 所需宿主能力合同

本页由产品 v1.17 第 3.3 章、FR-08—16、21—22、25、29—32 提取最小能力边界；定义需实现的结果，不假设 Deepseek Harness 已具备，不选接口/框架，也不扩大产品范围。

「核对结果」列由 S0-W3 宿主集成 spike 以**隔离宿主中的真实运行证据**填写（见
[ADR-001](decisions/ADR-001-session-dispatch-and-consolidation-carrier.md) 与
[ADR-003](decisions/ADR-003-project-mapping-and-context-injection.md) 的「验证证据」与「尚未验证」两节）。
本列只写本次实际观察到的行为；**未覆盖的行明确写「未验证」**，不以「应该可以」代替。

| 编号 | 所需能力 | 最早消费 | 核对结果 |
| --- | --- | --- | --- |
| HOST-01 | 明确项目标识、项目名称及工作范围；范围失效可辨识 | F01 | **接入**：`ctx.workspaceRegistry`（`create`/`get`/`list`/`resolveByPath`/`status`），`SessionHeader.cwd` 的规范化路径为归属键，`workspace.id` 为持久标识，`title` 仅显示。已验证：重复 `create` 同路径返回同一 id 且不改标题；不同路径可同名；不存在路径 `resolveByPath` reject（`ENOENT`）；目录消失时 `status()='missing-dir'`、记录仍列出、`list()` 仍返回。未验证：软链/跨盘符拼写的归属一致性。 |
| HOST-02 | 创建/打开独立工作对话，真实标题、持久标识、最近实际使用信息；不复制别的聊天 | F04 | **部分接入**：`sessionController.create({workspaceId})` 设置 `cwd` 并挂载项目（已验证 `headerCwd` = 项目路径、`attachedToWorkspace=true`、`agentPreset='standard'`）。**未验证**：真实标题写入与「最近实际使用」；仅观察到 `session/title`、`session/title-llm-request` 事件存在于序列中。 |
| HOST-03 | 发送用户明确要求、实际运行/等待/停止/失败结果；运行状态与任务状态分开 | F04/F11 | **部分接入**：`prompt`（`queue`）→ `{accepted:true}` 并落库可见 `user/message`；`inspect` 可读回 `turn/start`…`turn/end` 与失败 `reason`（已验证）。**未验证**：等待/停止（`cancel`）行为，以及运行状态与任务状态分离的完整语义。 |
| HOST-04 | 发送前准备可核对背景快照、送达结果及实际使用标记；失败保留输入、不盲目重派 | F11 | **接入**：背景快照经 `{prepend:true}` 的 `agent/pre-step` 注入，带 `source.kind='plugin'`，在持久日志中恰好一条（两个独立计数交叉验证）；「实际使用」证据 = 该事件 `seq`（已验证）。送达结果 = `rpcId` 对应 `user/message` 的落库 `seq`，与 `{accepted:true}` 分开判定（已验证）；`requestId` 幂等使重试不产生第二次投递（已验证）。**未验证**：失败保留输入的具体交互。 |
| HOST-05 | 在正确来源工作对话发送可见整理要求，返回结构可编辑的记录/概况候选；仅整理不开发 | F06/F07 | **接入**：`prompt(mode:'queue')` 在指定会话发送**可见**消息（已验证：落库 `user/message`，文本逐字节匹配）。「返回可编辑候选」属本插件自有逻辑，非宿主缺口。**产品语义约束（必须遵守）**：派发消息落库为 `source.kind='user'`，因此客户端把它渲染为人工提问并计入 `turnOutline`；见 [ADR-001](decisions/ADR-001-session-dispatch-and-consolidation-carrier.md) 第 6 节。 |
| HOST-06 | 同项目正式记录的简短索引和按范围读出，附适用状态、修正及实际读取证据 | F06最低必要读取/F12完整检索 | **接入**：按范围读出 = `workspace.sessionIds`（按规范化 `cwd` 过滤的派生视图）。正式记录的索引与版本属本插件（见 [ADR-002](decisions/ADR-002-paired-confirmation-single-write.md)）。**约束**：`sessionIds` 是派生视图而非历史，不能用来断言「曾属于本项目的全部对话」；历史隔离需另建显式归属。 |
| HOST-07 | 系统创建整理对话、保留本次过程、草稿与结果核对，区别工作来源和生成过程 | F13 | **部分接入**：`create({workspaceId})` 可创建独立会话（已验证）。**未验证**：「保留本次过程」的读取路径，以及工作来源与生成过程的区分表达。 |
| HOST-08 | 账号/模型可用状态与真实设置入口；执行权限审批与内容确认分开 | F04及全部AI入口 | **部分接入**：AI 不可用有稳定信号——实测本轮 `turn/end` 的 `reason.error.code='MISSING_CREDENTIAL'`，可据此表达「AI 不可用」而不误报为任务失败；权限/审批与内容确认是**各自独立**的事件（实测 `seq=0 permission/preset`、`seq=1 sandbox/mode`、`seq=2 approval/policy`，与内容消息分离）。**未验证**：真实设置入口（模型/账号页）与其可写性。 |
| HOST-09 | 本地可靠保存、版本和草稿、竞争修改核对、失败结果及重启恢复 | F01起各功能 | **接入**：`ctx.storageDomain`（见 [ADR-002](decisions/ADR-002-paired-confirmation-single-write.md)，由 S0-W2 以故障注入/并发/重启测试验证）。本次宿主集成 spike **未覆盖，未验证**。 |
| HOST-10 | 应用主题/字体/语言、可预测焦点导航、键盘与本地剪贴板结果 | 各组件/F19 | 客户端半（`packages/plugin-client`），本次宿主集成 spike **未覆盖，未验证**。 |

S0 对每项写明自行实现或接入的路径、负责人/模块及验证办法，供后续功能引用。只出现空壳或模拟成功不能写为完成。AI 故障模拟可以验错误路径，但正式验收还需真实执行与发送范围证据。

## 本次验证的环境与边界

全部结论来自**隔离宿主**的一次真实运行（`DSH_HOME` 位于工作区内；`--profile web --port 0 --no-open`；
探针经 `ctx.appExit(0)` 自行退出，退出码 0，无残留进程）。用户正在使用的 GUI 进程未被触碰，`~/.dsh` 未被读写。
复现命令见 `packages/plugin/src/probe/harness/run-probe.ps1`，原始证据见
`packages/plugin/src/probe/evidence/probe-report.json`。

**已知限制（S0 阶段永久延期）**：隔离 home **刻意不放入真实模型凭据**——真实凭据不得被物化到同步工作区目录内
（该写入被用户本人拒绝，本会话的自动审查亦拒绝）。因此本轮在 step 1 即以 `MISSING_CREDENTIAL` 结束，
「由真实模型产生的 assistant 回复内容」与「真实多步（含工具调用）」两项**未验证**，两份 ADR 的「证据分级」与「尚未验证」两节逐条列出。

需要区分的两点：**读取路径本身已验证**（`inspect` / `follow` / `page` 三条独立通道对同一份 19 事件日志一致，
含闭合的 `turn/end`）；缺的只是「一条由真实模型产生的 `assistant/message`」。
而**注入机制本身已验证**（`seq=11` 恰好一条、两个独立计数一致、只发生在 step 1）；缺的只是真实工具调用驱动出的 step 2。

## 安装目标的一处事实更正（工程决定，不是产品决定）

用户当前 GUI（`http://127.0.0.1:19387`）运行的是 **`desktop` profile**，不是 `web` profile。证据：
(1) 该端口的监听进程 argv 为 `… dsh-desktop-host/lib/index.js … C:\Users\InformationDS\.dsh\profiles\desktop …`；
(2) 会话环境变量 `DSH_PROFILE=desktop`、`DSH_PROFILE_DIR=C:\Users\InformationDS\.dsh\profiles\desktop`；
(3) 该进程的实时插件树含 `@deepseek-ai/dsh-host-product-telemetry-otel`、`office-to-pdf`、`workspace-changes` 等 desktop 专属行，
且**不含** `@omdsh-dev/dsh-genui`、`@dsh-external/dsh-visualize` 或 `aikanban` insert 条目。

因此 `profiles/web` 中的 `insert: aikanban` 与 `file:` 依赖当前**完全不生效**（陈旧配置）。
`desktop` profile 由 Electron 应用独占管理，`dsh --profile desktop` 会被启动器直接拒绝，
所以把插件装进当前 GUI 必须写 `profiles/desktop`，且需要重启进程——**不属于本次可自动完成的步骤**，
必须由用户确认后再执行。安装目标尚未决定，见 [架构准备与实现边界](architecture.md)。

文件读写、终端、具体审批和产物并发冲突处理归桌面 Agent 能力定义。看板不引入文件锁、任务产物调度、差异合并功能，不能把此合同当整套 Harness 的完整 PRD。
