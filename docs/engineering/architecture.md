> 复原说明：本页为 2026-10-14 S0 记录的原文复原（来源提交 bd16535）。2026-10-19 已在 DSH 44.7.0 上做部分复核，结论见 [S0 复核记录](s0-reverification-20261019.md)；未复核部分仍是「提议」，不得当作已验证。

# 架构准备与实现边界

技术栈与宿主接入方式已在 S0 选定并跑出真实证据；本页记录这些工程选择与跨功能合同。
具体决定写在[技术决策](decisions/README.md)里，本页不复制其内容。

## S0 形成的决定

| # | 决定 | 落点 | 状态与证据 |
| --- | --- | --- | --- |
| 1 | **运行目标 = DSH 插件（host 半 + 浏览器半双半包）**；TypeScript 5.9、Node `^22.19 \|\| >=24`、pnpm 11.7、tsdown 0.22 打包、vitest 3.2 测试。host 半产出可直接 `import` 的 ESM（`packages/plugin/lib/index.js`），浏览器半产出 `window.__ModuleLoader__.load` 形态的 bundle（`packages/plugin/lib/client.js`）。真实命令见根 `README.md`。 | 根配置、`packages/plugin`、`packages/plugin-client`、`tools/` | 已选定并可运行（S0-W1）。隔离宿主加载链探针 `tools/probe-host.mjs` 证明包能被 loader 解析、`import` 并 `apply()`。 |
| 2 | **项目 = workspace 实体**：`workspace.id` 为持久标识、`Workspace.title` 仅显示、`SessionHeader.cwd` 的规范化路径为归属键；创建项目对话一律 `sessionController.create({workspaceId})`；范围失效由 `status()='missing-dir'`（记录保留）与 `resolveByPath` reject 两条通道辨识。 | `packages/plugin`（host 半） | 已采用（S0-W3），见 [ADR-003](decisions/ADR-003-project-mapping-and-context-injection.md)。隔离宿主 8 项映射行为全部实测通过。 |
| 3 | **四类正式内容、不可覆盖版本链、草稿与成对确认 = 单次原子写**：一对成员（新版本条目、当前指针、适用性修正）写入同一条 scope head 记录，一次 `put` 提交；幂等靠确认身份 + 基线校验，不用全局锁。 | `packages/core` | 已采用（S0-W2），见 [ADR-002](decisions/ADR-002-paired-confirmation-single-write.md)。故障注入/并发/重启测试通过。 |
| 4 | **并发与重复处理**：同一次确认连点/重试/双窗口只产生一个版本（确认身份 `updateId` + 基线校验）；跨对话派发用新铸 `requestId`，重试复用同一 id，使宿主 `hasPromptRequest` 幂等生效。 | `packages/core` + `packages/plugin` | 已采用，见 ADR-002 与 [ADR-001](decisions/ADR-001-session-dispatch-and-consolidation-carrier.md)。派发幂等已在隔离宿主实测（同 id 二次投递 0 新增消息）。 |
| 5 | **默认背景快照走 `{prepend:true}` 的 `agent/pre-step` 注入 + 一个 `sessionProjections` 单元**，`step === 1` 为闸门，`source.kind='plugin'` 使其不冒充人工提问、不进 `turnOutline`；「实际使用」证据 = 该持久 `user/message` 的 `seq`。`request/header`/`request/context` 不得用作投递内容证据。 | `packages/plugin`（host 半） | 已采用，见 ADR-003。隔离宿主实测：恰好落库一条（两个独立计数一致）、只发生在 step 1、`turnOutline` 不含注入标记。 |
| 6 | **最小宿主能力接入与缺口**：HOST-01/04/05/06 已接入并实测；HOST-02/03/07/08 部分接入（未验证项逐条列出）；HOST-09 归 `packages/core`；HOST-10 属客户端半。 | [宿主能力合同](host-capabilities.md) | 逐行填写了实现路径、模块与验证方法；未覆盖的行明确写「未验证」。 |
| 7 | **源码与测试目录**：`packages/core`（纯逻辑 + 测试）、`packages/plugin`（host 半 + 浏览器半 loader 入口）、`packages/plugin-client`（浏览器半组件）、`tools/`（构建/同步/隔离探针）。功能验证用 vitest 单测 + `tools/probe-host.mjs` 真实加载链探针；宿主集成行为用 S0-W3 的隔离集成探针。 | 全仓库 | 已建成（S0-W1/W2/W3），命令见根 `README.md`。 |

以上实现方式可协商，用户可见行为须符合[产品总览](../prd/overview.md)及公共规则。决定写入[技术决策](decisions/README.md)，不在多个 PRD 中复制具体接口。

## 工程项状态（已定 / 已关闭 / 仍未决）

### 已定（2026-10-20）

- **系统整理对话与工作来源的区分表达**（HOST-07）：已由 [ADR-006](decisions/ADR-006-系统整理对话与工作来源的区分表达.md)（**已定**，2026-10-20 用户确认）确定；按状态词表「已确认、工程证据待取证」，取证前不得写成已验证（实施规格草案见其第 14 节）。
- **S1 接线与当前项目解析（Q1/Q2）**：见 [ADR-007](decisions/ADR-007-s1-wiring-and-current-project.md)（**已定**，2026-10-20 用户确认）。
  - Q1＝B：**当前项目每次显式选择、不持久化**（`board/read` 的 `projectId` 改为必填，不记上次/默认第一个/最近使用）。
  - Q2＝A：**扩展 wire/BoardController 契约**（基线 `expectedStatusVersion` 与撤销凭据 `appliedUpdateId`+`statusRevision` 真正过 wire），**不在适配层弱化 F02-R04/SAVE-05**。
  - 以上两项决策与理由见 `ADR-007`；实施规格入口见 [s1-wiring.md](s1-wiring.md)（工程证据待后补，不得写成已验证）。
- **Q3 允许 test-only 故障注入且承认其证据**：已定，政策见[验收执行规则](acceptance-execution.md) 第 3 节（不进入正式构建、默认关闭、登记范围仅限进入产品构建或隔离探针的开关/钩子、证据注明注入方式）。
- 实施规格入口：S1 接线见 [s1-wiring.md](s1-wiring.md)；验收执行与证据档位见 [acceptance-execution.md](acceptance-execution.md)、记录格式见 [verification 模板](../prd/templates/verification.md)。

### 已关闭（2026-10-20 复验）

**模型凭据下的端到端验证**：**2026-10-20 已复验**。方法：把 `DEEPSEEK_API_KEY` 作为**启动环境变量**注入**那一个隔离探针进程**（`DSH_HOME=<隔离目录>`、`--profile web --port 0 --no-open`、DSH 44.7.0），未写任何凭据文件，事后全工作区扫描该 key 字符串 **0 命中**。结果：20 步宿主集成探针 **20/20 `[ok]`**；`readback.turnEnd` 以 `completed` 结束并含两条 `assistant/message`（`assistantTurns=[{seq:17,turn:1,step:1},{seq:22,turn:1,step:2}]`，`lastAssistantText` 经 pwsh 工具调用得到）；`multiStepObserved=true`、`injectedCallCount=1`。因此「真实模型 `assistant` 回复」与「真实多步（含工具调用）」两项成立，[ADR-001](decisions/ADR-001-session-dispatch-and-consolidation-carrier.md)/[ADR-003](decisions/ADR-003-project-mapping-and-context-injection.md) 的「证据分级」与「尚未验证」两节已按此收紧（其余未验证项保留，见[复核记录](s0-reverification-20261019.md)第 9 节）。

### 仍未决

1. **插件安装目标 profile（执行待用户确认，不是设计未定）**。用户当前 GUI（**端口每次启动由系统分配（本机先后观察到 `19387` / `7420` / `8748`），文档与脚本均不得写死**）运行的是 **`desktop` profile**，不是
   `profiles/web`：监听进程 argv 指向 `profiles\desktop`，会话环境为 `DSH_PROFILE=desktop` /
   `DSH_PROFILE_DIR=C:\Users\InformationDS\.dsh\profiles\desktop`，且其实时插件树含 desktop 专属行而**不含**
   `profiles/web` 里的 `insert: aikanban` 与 `file:` 依赖。`desktop` profile 由 Electron 应用独占管理
   （`dsh --profile desktop` 被启动器拒绝），安装进当前 GUI 必须写该 profile 并重启进程。
   因此：**装到哪个 profile、何时重启，需用户确认后执行**；`tools/sync-to-profile.mjs` 按 profile 参数化，**默认 `desktop`**（脚本的 `--profile` 说明与实现均为 desktop）。
2. **界面挂载点与看板形态**（[ADR-004](decisions/ADR-004-界面挂载点与看板形态.md)，提议）：缺**客户端实际渲染证据**，取证前不得写成已验证。
3. **浏览器半 ↔ 宿主半数据通道**（[ADR-005](decisions/ADR-005-浏览器半与宿主半的数据通道.md)，提议）：缺**真实 Connection RPC 路由证据**，取证前不得写成已验证。

## 建议职责边界

| 职责 | 负责的结果 |
| --- | --- |
| 项目任务管理 | 隔离、任务字段、状态、可见性、搜索偏好 |
| 对话与归属 | 创建打开、固定关系、系统整理载体、实际运行 |
| 正式内容与审核 | 记录/汇总草稿、编辑核对、版本、适用修正、一致确认 |
| 背景与检索 | 默认精简材料、实际快照、净同步、当前片段读取、用途证据 |
| 持久化与恢复 | 已保存内容保护、幂等处理、竞争核对、结果未知恢复 |
| 桌面呈现 | 看板/详情/侧栏/总览/待确认、文字状态、键盘、语言、焦点 |

这是职责划分建议，不规定前后端、数据库或实际目录。每份小 PRD 实现可横跨职责以完成用户行为，不以先做全部界面/再做全部存储作为交付切片。

## 阶段集成合同

S1 手动汇总已有不可覆盖版本、用户来源、失败保留，并预留明确结论修正标识；S2 背景消费当前正式内容及修正，S3 F09 提供来源片段修正操作后必须联合核验；S4 项目成果接入相同保存/修正/读取规则。S5 是扩展管理与跨流程验收，不推迟此前已启用能力的数据保护。

F06 正常记录闭环先实现自身必要读取、预览和一次确认；F07 扩展编辑后核对、F08 扩展并发、F12 扩展检索交互，S3 整体验收完成后才宣称跨对话接力完整。不用未来扩展尚未实现的接口冒充已可用。

## 跨决策的硬约束

1. **派发出去的整理要求看起来像人工提问**。`sessionController.prompt` 落库为 `source.kind='user'`，客户端
   会把它渲染为人工提问并计入 `turnOutline`。这与「背景注入不冒充人工提问」是两套语义，实现时不得混用
   通道：可见的整理要求走 `prompt`，背景走 `agent/pre-step`。见 ADR-001 第 6 节。
2. **`workspace.sessionIds` 是派生视图，不是历史**。它按会话 header 的规范化 `cwd` 过滤，因此不能被当作
   「曾属于本项目的全部对话」的证据；历史隔离需要版本化的显式归属（与 ADR-002 的记录模型同层）。
3. **会话与库存储按 `DSH_HOME` 全局，不按 profile 隔离**。换 profile 不换数据；不得假设「每个 profile 一套数据」。
