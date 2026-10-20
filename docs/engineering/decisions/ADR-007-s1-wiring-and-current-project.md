# ADR-007：S1 接线设计与当前项目解析

| 信息 | 内容 |
| --- | --- |
| 日期 | 2026-10-20 |
| 状态 | 已定 |
| 定案依据 | 2026-10-20 用户确认的两项设计选择：**Q1＝B（当前项目每次显式选择、不持久化）**、**Q2＝A（扩展 wire/BoardController 契约，不在适配层弱化 F02-R04/SAVE-05）**；**工程证据尚未取得**，见第 11 节 |
| 影响功能 | F01（主）、F02（主）；边界：F03、F04 |
| 被替代关系 | 无 |
| 关系 | [ADR-005](ADR-005-浏览器半与宿主半的数据通道.md) 的落地设计（数据通道与 `/aikanban` 端点采用其结论）；不改 ADR-002（成对确认单写）、ADR-003（项目映射与背景注入）的结论；实施规格见 [s1-wiring.md](../s1-wiring.md)；不改变任何 F02-R04/SAVE-05 产品语义 |

> **状态说明**：本记录于 2026-10-20 经用户确认，按[决策目录状态约定](README.md)（状态表 `:13-16`、`已定` 的说明 `:18`、索引行 `:30`）记 **`已定`**：设计已由用户确认，工程证据尚未取得。`已定` 不是「采用」，也不等于工程已验证——可据此实施，但第 11 节取证前不得把本记录的任何结论写成已验证；取证后按同一词表评估是否转为 `采用`。

## 1. 要解决的问题

F01/F02 的数据层（`packages/core`）与浏览器看板 UI（`packages/plugin-client`）都已有回收实现，但**中间接线不存在**：host 半没有打开 core，`/aikanban` 通道没有注册（`packages/plugin/src/index.ts:396-404` 自述「Registering it inside `apply()` is deliberately NOT done yet」），浏览器半拿不到真实数据。独立评审判定「有条件可以开始开发」，但接线本身需要先定四个工程方向：① 切片边界（core 适配 + 通道注册 vs F01 管理动作）；② 看板「当前项目」从哪里来、是否记忆；③ 写路径的基线/撤销凭据怎么过 wire；④ 错误码与故障语义如何映射。这些决定会决定 F01/F02 的实现顺序与验收方式，必须先落为记录，而不是散在实现里。

## 2. 可核对的事实（文件:行号）

1. **通道与协议已就绪一半**：`createBoardChannelHandler`/`registerBoardChannel` 已实现（`packages/plugin/src/board-channel.ts:145-212`、`:256-275`），但 `apply()` 只做激活/诊断工具/系统提示，**未注册通道**（`packages/plugin/src/index.ts:305-393`，自述 `:396-404`）。
2. **core 已具备 F01/F02 全部规则入口**：`registerProject`/`listProjects`/`createTask`/`updateTaskFields`/`readActivity`/`readBoard`/`setTaskStatus`/`reorderTask`/`undoStatusChange`（`packages/core/src/types.ts:1041-1138`；实现 `packages/core/src/planning.ts:451/620/862/928/1059/1176/1184/1353/1414`）；读板三态见 `types.ts:441-463`。
3. **写路径的基线语义已由 core 要求、但 wire 未携带**：core `setTaskStatus`/`reorderTask` 要 `expected:{statusRevision}`（`types.ts:1114-1131`），`undoStatusChange` 要 `{statusRevision, appliedUpdateId}`（`:1133-1138`）；wire 的三个 payload 有可选 `expectedStatusVersion`（`packages/plugin-client/src/wire.ts:119-146`），但 controller 构造输入时**从不填写**（`controller.ts:521-527`、`:684-691`、`:738`），撤销 token 只有 `{taskId, operationId}`（`:80-83`）——刷新后无法撤销。
4. **`projectId` 的旧语义与 Q1=B 冲突**：`ReadBoardPayload.projectId` 可选、注释为「Absent means the current project」（`wire.ts:113-117`）；`parseReadBoardPayload` 接受省略（`:447-460`）；`channel-source` 无项目时发 `{}`（`:136-137`）。Q1=B 下不存在「当前项目」的隐式解析。
5. **core 的撤销身份是 requestId**：`lastStatusUpdateId: requestId`（`planning.ts:1288`）、撤销以 `appliedUpdateId` 判定（`:1446`）；wire 的 `UndoStatusPayload.operationId` 目前语义是「被撤销那次操作的 id」（`wire.ts:141-146`），而 core 的 `undoId` 是本次撤销的身份（`:1416`）——必须拆成两个字段。
6. **构建约束**：`tools/verify-host-import.mjs` 要求 host 半构建产物的导入图**只有 `node:` 内建、无 bare specifier**（`:265-276`），并断言无服务上下文 `apply()` 仍发布激活（`:292-321`，共 11 项检查 `:225/231/236/243/252/265/278/282/287/292/323`）；tsdown 已内联 `@aikanban/*`（`packages/plugin/tsdown.config.ts:42`）；core 源码无 `node:` 导入（已核对 `packages/core/src/*.ts`：无）。
7. **当前项目不持久化在技术上没有障碍**：浏览器半无任何 `localStorage`/`sessionStorage`/cookie/IndexedDB（已核对 `packages/plugin-client/src`：无）；选择状态现为内存变量（`packages/plugin-client/src/runtime.ts:30`、`:58-71`）；core 的 `saveBoardPosition`/`ProjectFields.position` 是**每个项目自己的看板内位置**（`types.ts:312-316`、`:341-358`；`planning.ts:1012`），不是“打开哪个项目”。
8. **项目列表权威来源是宿主的 `workspaceRegistry`**：`ctx.workspaceRegistry` 的 `get`/`list`/`resolveByPath`/`status`（[ADR-003](ADR-003-project-mapping-and-context-injection.md) W1 `:27`、W2 `:28`、W6 `:32`；`list()` 实测 `:119`）；core 的 `listProjects()` 只列已登记项目（`planning.ts:928`），不是发现来源。
9. **探针目前不证明通道注册**：`tools/probe-host.mjs` 只断言合成树含 aikanban 行（`:275-286`）、profile 解析并激活（`:289-326`）、发布并服务 client.js（`:343-443`）、宿主内发布激活信号（`:445-463`）；ADR-005 早已点名「隔离宿主探针另断言宿主半确实注册了 `/aikanban`」（ADR-005 `:92`），**当前仍缺**。

## 3. 决定摘要

1. **当前项目解析＝每次显式选择、不持久化（Q1=B）**：看板每次进入都不带“当前项目”，必须由用户从项目列表显式选择；选择只存本次页面内存，刷新即丢；不存在默认第一个、最近使用或按标题猜测；`board/read` 的 `projectId` 改为必填。
2. **写路径扩 wire/BoardController 契约（Q2=A）**：基线（`expectedStatusVersion`）与撤销凭据（`appliedUpdateId` + `statusRevision`）真正过 wire 并由 controller 填写；**不在适配层用默认值/跳过核对来弱化** F02-R04 与 SAVE-05。
3. **core 接入方式与构建依赖边**：host 半在 `apply()` 中同步注册通道（延迟就绪端口），异步打开 `aikanban_core` 并创建 core；core 以 workspace 依赖 + tsdown 内联进入 host bundle（保持 `verify-host-import` 无 bare specifier）；provider 用结构化 validator shim，不引入 npm 依赖；每个 `board/read` 前按宿主 `workspaceRegistry` 解析并 `registerProject`。
4. **错误码映射原则**：保持浏览器侧固定的 8 个失败码；core 的结果码按“正式值是否改变/是否未知/是否竞争”归入 `stale-baseline`/`save-failed`/`unknown-result`/`not-found`/`invalid-reason`/`unknown-project`/`read-failed`；无法映射的输入错误归 `save-failed` 并原样带 message；适配器与 handler 永不抛异常；新增产品语义（如 B 的 `invalid-input`）必须同时改两端契约与测试。

落点：实施细节（切片 A 的文件级改动、协议映射、启动顺序、错误码表、测试与判据）见 [s1-wiring.md](../s1-wiring.md)，本 ADR 不复制其表格。

## 4. 决定一：当前项目解析＝每次显式选择、不持久化（Q1=B）

**决定**：看板不维护、不记忆“当前项目”。每次进入看板先显示选择态；项目列表每次现取（B 的 `project/list` 来自宿主 `ctx.workspaceRegistry.list()`）；用户选定后本次页面会话内使用该 `workspace.id`；刷新/重进/切座位回到选择态。`board/read` 的 `projectId` 为必填，缺失一律失败且不猜。

**理由**：

- F01-R01/OBJ-01 要求“切换项目后看板与管理信息明确归属，不出现其他项目的内容”；隐式“当前项目”（上次记忆/默认第一个/最近使用）会让用户在不知情时看到另一个项目的任务，属于同一类串项目风险。显式选择把“看板在看哪个项目”变成用户可观察的决定。
- ADR-003 只把 `workspace.id` 定义为项目标识、`title` 仅显示（ADR-003 `:71`），**没有**定义“当前项目”这一持久概念；core 也没有该字段（`types.ts:341-358` 只有每项目自己的 `position`）。无持久化方案不需要改动 core、不新增存储域/键，也不触碰 OBJ-01 的隔离模型。
- 拒绝“记住上次选择”的替代方案：它需要新增一份“全局 UI 状态”持久化（跨项目、跨会话），与“切换项目一起切换”的归属模型相冲突，还会引入重装/多窗口下的状态漂移；用户明确选择了 B。

**边界**：这不表示每次操作都要重选；一次页面会话内选择一次即可。它也不表示项目列表要轮询：列表在每次进入/显式刷新时读取。`boardToken`/迟到响应丢弃（`controller.ts:578-593`）继续保证切换过程中的串项目保护。

## 5. 决定二：写路径扩 wire/BoardController 契约（Q2=A）

**决定**：把 core 已要求的基线/撤销凭据完整带到浏览器侧，并让 controller 填写：

- `task/status.set`：必填 `expectedStatusVersion` → core `expected.statusRevision`；
- `task/reorder`：必填 `expectedStatusVersion` → core `expected.statusRevision`（并核对当前列）；
- `task/status.undo`：拆成两个身份——本次撤销的 `operationId`（重试幂等）与被撤销的 `appliedUpdateId`（core 判定竞争），同时必填 `expectedStatusVersion`；
- 读快照携带 `statusRevision`（改必填）与 `undoTarget:{statusVersion, appliedUpdateId}`（来自 core `TaskView.undoTarget`，`types.ts:385-391`），使刷新/重读后仍可撤销；
- 版本号过 wire 用统一字符串编码 `ver1:<non-negative int>`（严格解析，非法即协议违规），失败详情里的 `statusVersion` 用同一编码。

**理由**：

- F02-R04 明文要求“后续已发生新修改时，撤销不能覆盖新修改；提示无法直接撤销并展示当前值”，SAVE-05 要求写操作核对基线。若在适配层用“先读后写”或默认 `statusRevision:0` 来凑合，等于把**竞争判定从产品规则**降级为适配层启发式：并发/多窗口/刷新后行为会与 PRD 不一致，且测试再也证明不了 F02-R04。
- core 的判定只认版本与身份（`planning.ts:1376`、`:1446-1456`），不需要时间戳；wire 现有 `expectedStatusVersion?: string` 字段说明契约本来就预留了这条路径（`wire.ts:128/137/145`），只是 controller 没填。扩契约是**补完既定设计**，不是发明新机制。
- 撤销凭据必须来自“当前正式状态”而不是“本窗口刚发出的操作”：`undoTarget` 是 core 给出的唯一合法基线（`types.ts:385-391`），随快照下发才能支持重开/刷新；否则 A 的撤销只在一个内存 token 的生命周期内可用，属于已知的语义缺口。

**代价**：这是破坏性 wire 契约变更（必填字段、payload 形状、快照形状），必须同时改两端与 6 个受影响测试文件（见 [s1-wiring.md](../s1-wiring.md) §4.5），且浏览器与宿主必须同版本发布——本插件两半同包，无跨版本兼容需求。**不得**为了兼容旧客户端而把基线字段继续设为可选。

## 6. 决定三：core 接入方式与构建依赖边

**决定**：

1. host 半在 `apply()` 中**同步探测 `ctx.connection` 并注册 `/aikanban`**；端口是“延迟就绪”的：数据层未就绪时方法返回显式失败（`unavailable`/`read-failed`），不抛异常，从而加载链与激活语义不变。
2. 数据层异步引导：`ctx.storageDomain.open(buildDomainSpec(schemaShim))` → `createKanbanCore({port: createStorageDomainPort(domain)})`；失败保持可见失败状态，不伪造空看板。
3. 每次 `board/read` 前用 `ctx.workspaceRegistry.get(projectId)` 解析项目并 `core.registerProject(...)`（同项目后续为 `unchanged`，不写），再 `core.readBoard({projectId, workScope: 显示提示})`。
4. core 以 workspace `devDependency` + tsconfig project reference 接入，由现有 tsdown `alwaysBundle: @aikanban/*` 内联进 host bundle；**不引入任何 bare specifier**，`verify-host-import` 必须保持 11/11。
5. 不引入 `zod` 依赖：用结构 validator shim（`{custom(check) → {parse}}`）满足 `buildDomainSpec` 的 `ZodLike`（`domainSpec.ts:249-288`），依据是域层只调用 `valueSchema.parse`（ADR-002 实验 `experiments/storage-domain-atomicity.mjs:77-78`）。

**理由**：ADR-005 已选定 `/aikanban` 通道并要求“host 半打开 domain、注册通道”（ADR-005 `:52-76`）；`verify-host-import` 是无宿主环境下唯一能证明加载链不破的门禁，任何“让 profile 自己解析 @deepseek-ai/* / zod”的捷径都会让它退化。延迟端口让“注册通道”不被异步 open 阻塞，同时保持 apply 同步发布激活信号（`verify-host-import.mjs:292-321`）。

**未确认（实施第一步取证）**：`ctx.storageDomain.open` 是否接受未经 DSH `defineDomain()` 包装的 spec；`tsc -b` 能否经 core 的源码导出（`packages/core/package.json:7-10`）完成引用解析；`workspaceRegistry.get/list` 的精确返回形状；cordis 的销毁钩子。任一不成立时的处置见 [s1-wiring.md](../s1-wiring.md) §5.2/§5.3/§8 — 共同底线是**不减 `verify-host-import`、不引裸导入、不猜项目、不伪造数据**。

## 7. 决定四：错误码映射原则

**决定**：

1. 浏览器侧失败码词表保持固定 8 个（`wire.ts:58-67`）；host 侧协议码 `invalid-payload`/`unknown-endpoint` 不外泄为产品码（浏览器按读/写分别归为 `read-failed`/`save-failed`，`channel-source.ts:96-99`、`:173-180`）。
2. 映射按语义而非逐字：**正式值未变**的写失败 → `save-failed`；**结果未知**（异常/传输未确认）→ `unknown-result`，不重发；**版本/身份过期竞争** → `stale-baseline` + `details.current:{status,statusVersion}`；**任务不存在** → `not-found`；**阻塞原因缺失** → `invalid-reason`；**项目未登记/不可解析** → `unknown-project`（读）/同码（写）；**读取失败** → `read-failed`；**数据层不可用** → `unavailable`。
3. core 中无法映射为产品语义的输入错误（如 `invalid-status`、`invalid-input`）→ `save-failed` 并原样带 message，不新增“猜原因”的码；B 需要新增 `invalid-input`（表单可纠正错误）时必须同时改两端词表、映射、测试与文档。
4. **handler 永不全抛**（ADR-005 `:74`；`board-channel.ts:174/191/206`），适配器的异常也要在内部转成失败结果；撤销的 `cannot-undo/nothing-to-undo/superseded` 统一走 `stale-baseline`+current，让 UI 显示当前值而不是静默失败。

**理由**：UI 的交互分支由码决定（`controller.ts:398-424`、`source.ts:74-87`）；如果适配层把 `baseline-changed` 报成 `save-failed`，用户会以为可以“重试保存”而实际需要重读，违反 REC-01 的“失败不等于成功、未知不等于失败”口径。词表固定还能让两侧测试用同一集合断言，不再出现“半边新码”。

## 8. 可选方案与拒绝理由

| 方案 | 结论 | 理由 |
| --- | --- | --- |
| Q1-A：记住上次项目/默认第一个/最近使用 | 拒绝 | 隐式选择会造成“看到的不是自己以为的项目”（F01-R01/OBJ-01 风险）；需要新增跨项目 UI 状态持久化，超出 F01 数据模型；用户选择 B |
| Q1-C：由宿主按“当前打开的工作区”注入项目 | 拒绝 | 宿主并无“看板当前项目”概念（ADR-003 只定义 workspace 实体）；会把选择变成不可见的外部状态，且要求改宿主 |
| Q2-B：适配层先读当前任务再写（本地补基线） | 拒绝 | 读后写之间的竞争会丢更新，等于弱化 SAVE-05/F02-R04；并发/多窗口行为不可验证 |
| Q2-C：撤销凭据只保留在内存 token（现状） | 拒绝 | 刷新/重开即失去撤销，且撤销竞争判定缺少 `statusRevision`，F02-R04 不可满足；用户选择 A |
| core 作为 peer 依赖、运行时从 profile 解析 | 拒绝 | `verify-host-import` 明确禁止非 `node:` bare specifier（`:265-276`）；profile 未必解析得到 `@aikanban/core` |
| 引入 `zod` npm 依赖 | 不采用 | 可避免新增依赖即可满足 `ZodLike`（结构 shim）；少一个版本兼容面 |
| 用 `ctx.webServer` 自建 HTTP 路由传数据 | 拒绝 | ADR-005 已否决（无 TLS/认证/同源策略） |
| 把通道注册放到异步引导完成后 | 拒绝（作为默认） | 会让 `apply()` 后的激活快照恒为“未注册”，且延长加载链不确定窗口；延迟端口可立即注册 |

## 9. 影响功能与验收

- **F01（主）**：项目解析（Q1=B）与任务管理动作（B）的接线；AT-01/AT-02/AT-107/AT-108 等的执行仍待 `verification.md` 的档 1 证据。
- **F02（主）**：4 端点接线与写路径基线/撤销（Q2=A）；AT-03/AT-29/AT-109 等仍全部「待执行」。
- **边界 F03**：F03 需要正式的概况内容进入卡片/详情；A/B 只提供空 `summaryProgress` 回退（`types.ts:399-401`），不实现 F03 的编辑流程，也不得用占位文案冒充。
- **边界 F04**：F04 的对话运行提示/背景准备是 `hints` 的真实来源；A/B 期 `hints` 恒省略（[s1-wiring.md](../s1-wiring.md) §3.5），不得让 UI 自行合成。
- **验收口径**：ADR 状态为 `已定`，工程证据见第 11 节；切片 A/B 的测试与探针是**辅助证据（档 2/档 3）**，不能替代 F01/F02 的 AT 执行；真实页面/真实 profile 的项按 [验收执行规则](../acceptance-execution.md) 的第 2 节档位标注。

## 10. 约束与代价

- **UX 代价（Q1=B）**：每次进入多一步选择；刷新后回到选择态。这是用户明确接受的代价，不得以“体验优化”为由偷偷持久化。
- **契约代价（Q2=A）**：wire/BoardSource/controller/面板需同步改；6 个既有测试文件必须更新（清单见 [s1-wiring.md](../s1-wiring.md) §4.5）；两半必须同包同版本发布。
- **构建代价**：host bundle 体量增加（core 内联）；`verify-host-import` 每次构建都必须跑，任何 bare specifier 都是失败而不是警告。
- **实现约束**：不得改 `packages/core` 的产品语义（A/B 只调用现有 API）；不得改 PRD/AT 状态；不得引入未被登记的第 9 个失败码；`packages/` 的实现改动另立任务与评审（本 ADR 只定设计，不改代码）。
- **阶段边界**：切片 A 完成≠S1 可用（无项目选择 UI）；B 完成≠F01/F02 验收通过（AT 未执行）。

## 11. 验证证据

**当前：待取证（本记录按词表记 `已定`，用户已确认设计，工程证据尚未取得；不得写成已验证）。** 取证办法（实施后在本节补实际命令/输出与档位）：

1. **集成测试（档 2）**：`packages/plugin/test/board-adapter.test.ts` —— 真实 `createKanbanCore` + 内存 `StoragePort` 经真实 `createBoardChannelHandler` 打通 4 端点，覆盖成功/失败/未知结果/不抛异常/快照映射/基线拒绝/撤销竞争（用例清单见 [s1-wiring.md](../s1-wiring.md) §7.1）。故障注入只用内存 port 的 `beforeWrite`（测试代码路径，符合 [验收执行规则](../acceptance-execution.md) 第 3 节，不需要登记构建开关）。
2. **协议往返（档 2）**：扩 `packages/plugin/test/channel-roundtrip.test.ts`（真实构建产物 + 信封），断言新增必填基线与撤销凭据确实过 wire。
3. **隔离探针（档 3）**：`tools/probe-host.mjs` 新增「`registerBoardChannel` 实际被调用」断言（观察 `aikanban:board-channel` 事件；[s1-wiring.md](../s1-wiring.md) §7.2）。这是 ADR-005 `:92` 已点名但当前仍缺的证据。
4. **门禁**：`pnpm run typecheck`、`pnpm run build`、`pnpm -r --if-present run test`、`node tools/verify-host-import.mjs`（11/11 不得退化）、`python docs/tools/check_docs.py`。
5. **真实 profile / 真实页面**（档 1）：把插件装入实际 profile、在真实 GUI 完成“选择项目→看板→改状态→撤销”的往返；未执行前，ADR-005 的“真实网络跳转”与 ADR-004 的“客户端实际渲染”仍为未验证。

取证完成后：把本记录状态从 `已定` 重新评估为 `采用`（或保留 `已定` 并写明缺口），证据按实测/探针/未验证分级写入本节；在此之前任何文档/实现记录不得引用本 ADR 声称“已验证”。

## 12. 尚未验证

- 真实 `ctx.connection.rpc` 网络往返（Host/Origin/浏览器 token 校验、页面侧调用）——需写 profile 并重启，ADR-005 仍 `提议`。
- 浏览器真实渲染与键盘交互（无 DOM 环境测试）。
- `ctx.storageDomain.open()` 对裸 `DomainSpecLike` 的接受性（§6 的未确认项）。
- `tsc -b` 对 core 源码导出（`packages/core/package.json:7-10`）的 project-reference 解析。
- `ctx.workspaceRegistry.get/list` 的精确返回形状与生命周期、`connection` 服务相对 `apply()` 的到达时机。
- cordis 销毁钩子（关闭 domain / 注销通道）的实际形态。
- 同一次“状态+排序”两写的失败边界（core 先写列偏好再写状态，`planning.ts:1300-1315`）在真实故障下的用户可见行为。

## 13. 被替代关系

无。若本决定被推翻：新增记录并注明替代关系，不改写本记录结论；`已定` 状态与证据分级保留原样。

## 14. 实施规格

以 [s1-wiring.md](../s1-wiring.md) 为准（该文档是实施前置规格，不是实现/验收记录）：§1 切片与文件清单、§2 当前项目解析（Q1=B）、§3 协议字段映射、§4 写路径契约（Q2=A）、§5 启动链路与依赖边、§6 错误码映射、§7 证据与完成判据、§8 未定与风险、§9 切片 B 扩展清单。
