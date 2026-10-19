# 宿主集成探针（S0-W3 / task-3）

这是一个**一次性可观测探针**，不是要发布的插件代码。它在**隔离宿主**里真实执行三条宿主集成路径，
把结果写成 `evidence/probe-report.json`，供 [ADR-001](../../../../docs/engineering/decisions/ADR-001-session-dispatch-and-consolidation-carrier.md)
与 [ADR-003](../../../../docs/engineering/decisions/ADR-003-project-mapping-and-context-injection.md) 引用。

## 运行

```powershell
pwsh -File packages\plugin\src\probe\harness\run-probe.ps1
```

脚本做三件事：`harness/prepare.mjs` 重建隔离 home → 启动隔离宿主 → 探针自己经 `ctx.appExit(0)` 退出。
没有自动启动，没有常驻服务；删掉 `.probe-home/` 永远安全，脚本会重建。

隔离手段（用户正在使用的 GUI 完全不受影响）：

| 手段 | 作用 |
| --- | --- |
| `DSH_HOME=<workspace>\.probe-home` | `profiles/`、`sessions/`、`storages/`、凭据库全部落在工作区内，不读写 `~/.dsh` |
| `--profile web` | 宿主会话 API、workspace 注册表、`turnOutline` 投影都由 `dsh-web-app` 挂载；`headless` 模板没有这些行 |
| `--port 0` | 由操作系统分配临时端口，绝不占用固定端口（历史记录里的 19387；2026-10-20 起 GUI 为 7420） |
| `--no-open` | 不启动浏览器 |
| `--patch <overlay>` | 只挂载探针与一条遥测禁用项，不改任何 profile |
| 启动器 flag 在前 | 启动器把第一个不认识的 token 交给 app，因此 `--patch` 必须写在 `--port` 之前 |

## 依赖与冲突

**模型凭据（2026-10-20 已复验，见下方补充）**：派发出去的轮次需要真实模型才能产生 `assistant` 回复与工具调用。
隔离 home 需要自己的 `$DSH_HOME/.credentials.yaml`（`dsh-credentials-local` 首次启动时会创建一个**空**的 161 字节存储）。
没有凭据时探针仍然 20/20 全部通过，但 `turn/end` 的 `reason` 是
`{kind:'error', error:{code:'MISSING_CREDENTIAL'}}`。

**2026-10-20 补做复验**：把 `DEEPSEEK_API_KEY` 作为**启动环境变量**注入该隔离进程（不写任何凭据文件）后，`turn/end` 为 `{kind:'completed'}`、`assistantTurns` 两条（step 1 与 step 2）、`multiStepObserved=true` —— 「由真实模型产生的 assistant 回复」与「真实多步轮次」两项均已实测成立。详见 [S0 复核记录](../../../../docs/engineering/s0-reverification-20261019.md) 第 9 节。

**决定：真实凭据不得被物化到本同步工作区目录内**（用户明确拒绝，且本会话的自动审查也会拒绝该读/写）。
所以不要再去申请、复制或写入凭据。要补齐只能由用户本人做两件事之一：
(1) 自己把 key 写进 `<home>/.credentials.yaml`（`version: 1` + `refs.DEEPSEEK_API_KEY` + `records`，仅这三个顶层键）；
(2) 在启动探针宿主时导出 `DEEPSEEK_API_KEY`。
注意顺序：宿主启动时会**打开并重写**该存储，凭据必须先就位再启动；`harness/prepare.mjs` 不碰凭据。

**「机制已验证」与「live 未验证」必须分开表述**：读取路径已被三条独立通道证明能完整读回一轮
（`inspect` / `follow` 快照 / `page` 对同一份 19 事件日志一致）；缺的只是「一条由真实模型产生的 `assistant/message`」，
**不是「读不到 assistant/message」的能力**。细节见两份 ADR 的证据分级表。

**证据必须落在仓库里，运行环境可以丢弃**：报告路径刻意指向
`packages/plugin/src/probe/evidence/probe-report.json`（仓库内），而不是 `$DSH_HOME`。
S0 期间 `.probe-home` 被 `tools/probe-host.mjs` 的 `rmSync` 整目录删除过一次，正因如此证据才没有丢。
不要把夹具、状态或证据放进 `.probe-home`——它是一次性目录。

**与 `tools/probe-host.mjs` 共用 `.probe-home`**：那个工具在开始时会 `rmSync` 整个 home，因此运行它
会删掉本探针的夹具。本探针不依赖 home 的历史状态——`harness/prepare.mjs` 会重建包副本、workspace 夹具
与 overlay，所以被清掉只损失一次 prepare。若要让两者同时稳定存在，给其中一个换 home
（本探针：`prepare.mjs <home>` + 启动时用同一个 `DSH_HOME`；探针工具：`--home <另一目录>`，需同时在
`.gitignore` 中覆盖）。

**停止与清理**：宿主由探针经 `ctx.appExit(0)` 自行退出（退出码 0），不派生常驻子进程、不注册服务。
异常挂起时用 `Stop-Process -Id <report.host.pid>`。`.probe-home/` 已在 `.gitignore` 中，删除永远安全。

## 它验证什么

探针共 18 步，全部断言通过才算通过；每步都先检查前置条件，**不允许空过**（例如「没有重复投递」必须在
「首次投递确实落库」的前提下才算证据）。

- **派发**：`sessionController.prompt({requestId,sessionId,mode:'queue',content}, signal)` → `{accepted:true}`，
  并读回落库的 `user/message`（`seq`、逐字节文本比对）。
- **读取**：`inspect(sessionId).events` 取回完整事件序列（`turn/start` → `step/start` → `user/message` →
  `assistant/attempt` → `step/end` → `turn/end`）。
- **幂等**：同一 `requestId` 二次投递返回 `{accepted:true}` 但不投递，且第二段载荷不出现在日志中。
- **子会话边界**：断言确切的 `code='session/agent-busy'` 与 `owned by subagent routing` 文案，而不是「抛错即通过」。
- **每轮注入**：`{prepend:true}` 的 `agent/pre-step` + 一个 `sessionProjections` 单元；注入块在持久日志中
  **恰好一条**，由**两个互相独立**的计数交叉验证（原始日志扫描 + 投影折叠），且只发生在 `step === 1`。
- **导航语义**：`turnOutline` 含派发文本、不含注入标记。
- **项目映射**：`workspaceRegistry` 的 8 项行为（路径规范化幂等、同名不同路径、不存在路径 reject、
  目录消失 `missing-dir`、`create({workspaceId})` 设 `cwd` 并挂载、`attachSession` 两条拒绝路径）。

## 它不验证什么

- **模型回复**：若隔离 home 没有模型凭据（见上「依赖与冲突」），本轮 `turn/end` 的 `reason` 是
  `{kind:'error', error:{code:'MISSING_CREDENTIAL'}}`。此时「取回 assistant 回复并与投递内容对上」只完成了
  读回通道（`inspect` / `follow` 快照 / `page` 三条通道一致），回复内容**未验证**。
- **真实多步**：本轮在 step 1 就因缺凭据结束，没有工具调用，因此「多步只注入一次」只在 `step === 1` 闸门
  与 step 1 实测上成立，没有真实多步事件序列。
- 运行中 `queue` 排队、`steer` 会取消当前轮、冷会话 resume 与 `session/writer-held`：均未实测。

未验证项的完整清单写在两份 ADR 的「尚未验证」一节。

## 文件

| 路径 | 作用 |
| --- | --- |
| `index.js` | 探针插件本体（host 半，纯 ESM，无构建步骤，可被宿主直接 `import`） |
| `package.json` | 可挂载包声明（`@aikanban/probe`） |
| `harness/prepare.mjs` | 重建隔离 home：workspace 夹具、探针包副本、生成的 `--patch` overlay |
| `harness/run-probe.ps1` | 一条命令跑完（prepare + boot） |
| `harness/verify-docs.py` | 便利脚本：以「排除 vendor 目录」的方式运行真正的 `docs/engineering/tools/check_docs.py`。**权威是那个检查器本身**（已修复为排除 `node_modules`/`.probe-home`/`dist` 等），本包装器只是早期它未修复时的临时手段，可以不用。 |
| `evidence/probe-report.json` | 最近一次运行的真实报告（探测步骤、断言数据、原始事件序列） |

探针包用**副本**而非 junction 挂进隔离 home：Node 按 realpath 解析 ESM 说明符，junction 会让探针从本仓库
解析 `@deepseek-ai/*`，而那里没有 `node_modules`。
