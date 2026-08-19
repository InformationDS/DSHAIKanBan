# AIKanBan v3 执行方案（对话绑定 / 真实标题 / 工作项内新建对话）

> 依据：`DSH-PRD.md` v3（§3.1 绑定与解绑 / §3.2 对话显示名 / §3.3 新建对话 / §4 UI / §6 实现约束 / §7 自用验证）。
> 本方案只描述实现路径；改动范围仅 `aikanban-package/lib/index.js`（Host）与 `aikanban-package/lib/client.js`（Client）两个文件，不新增依赖、不新增代码文件、不改 `PRD.md`（Codex 版）。

## 0. 需求基线（已对齐确认）

- 关系模型：一个工作项 1—N 条对话；一条对话同一时间只绑定一个工作项。
- 绑定入口双向：工作项详情页「绑定已有对话」（只列当前工作区会话）+ agent 工具。
- 改绑：把已绑定其他工作项的对话绑定到本工作项时，UI 必须弹确认「从 X 改绑到 Y」；agent 侧改绑需用户明确同意。
- 解绑：解绑不删除该对话的上下文版本记录、产出的建议与记忆版本来源。
- 对话名：DSH 会话真实标题（派生显示，不另存副本）；无标题回退「会话 xxxx」；仅活会话可在看板重命名（同步 DSH 标题）；`kanban_view` 输出带 title。
- 新建对话：工作项内「＋ 新建对话」→ DSH 标准新会话流程 → 自动绑定该工作项 → 当前窗口跳转；不自动注入上下文；失败不建立绑定；待绑定意图约 10 分钟作废。
- 迁移规则：既有数据中绑定多个工作项的对话（当前数据不存在），保留最早登记的工作项，其余自动解除并在 UI 提示。

## 1. 数据模型变更（`.dsh-kanban.json`）

conversation 元素新形状（加法式，兼容旧数据）：

```
{ id, title?, live?, workItemId, workItems[], contextVersions{}, createdAt, lastActiveAt }
```

- `workItemId`：当前绑定的唯一工作项；空/缺失 = 未绑定。
- `workItems[]`：参与历史（含解绑/改绑前的旧归属），只增不删，用于追溯。
- `title` / `live`：**派生字段，不写入盘**。`getState` 返回前动态解析合并；`kanban_view` 同样带出。
- 迁移（`normalizeConversations`，在 `ensureReady`/`refine` 载入后执行）：
  - `workItemId` 缺失 → 取 `workItems[0]`（保留最早登记的工作项）；存在多个历史归属时其余保留在 `workItems` 中不再视为绑定。
  - `contextVersions` 缺失 → 补空对象（现有逻辑已做）。
  - 不升 schemaVersion：旧文件（schemaVersion===1）加载路径不变。

## 2. Host 改造（`aikanban-package/lib/index.js`）

### 2.1 会话标题解析 `resolveTitles()`

- 输入：conversation id 列表；输出 `{ [id]: title }`。
- 活会话：`sessions.list()` 命中的，调 `ctx.get('sessionTitle')?.get(s)`；无标题 → 回退 `'会话 ' + id.slice(0, 8)`。
- 非活会话：`ctx.get('sessionQuery')?.readTitleSnapshots(ids)` 批量读；空/异常 → 回退。
- 两个服务都按可选服务读取（`ctx.get` + undefined 检查），缺失时标题整体回退，功能不崩。
- 会话数小（个人看板），getState 每 4 秒轮询时全量解析成本可接受；若将来列表变大再加 TTL 缓存（本期不做）。

### 2.2 `getState` 改造

- `state` 返回前浅拷贝合并：conversations 每项输出 `{ id, title, live, workItemId, workItems, contextVersions, createdAt, lastActiveAt }`，其中 `live = !!sessions.get(id)`。

### 2.3 新增 RPC（handlers + `rpc()` 注册）

| RPC | 入参 | 行为 |
| --- | --- | --- |
| `bindConversation` | `workItemId`（必）、`sessionId?`（缺省=当前会话）、`confirm?` | 校验工作项存在；会话已绑定其他工作项 A 且未带 confirm → 返回 `{ok:false, needsConfirm:true, from:A}`；confirm 或未绑定 → 解绑 A（若有）、绑定目标、写 `contextVersions[目标]`=当前最新记忆版本、更新 `lastActiveAt`、`commit()` |
| `unbindConversation` | `workItemId?`、`sessionId?` | 校验会话当前绑定与 workItemId 一致；清 `workItemId`；`workItems`/`contextVersions`/建议/记忆来源不动；`commit()` |
| `renameConversation` | `sessionId?`、`title` | 仅活会话：`sessions.get(id)` 失败 → `{ok:false, error:'仅已打开的会话可重命名'}`；成功 → `sessionTitle.rename(session, title)`，空标题错误透传；返回新标题 |
| `listSessions` | 无 | 合并 `sessions.list()`（活）+ `sessionPersistence.list()`（持久化）按 id 去重；按 `header.cwd` 规范化后 === `state.workspace` 过滤（当前工作区）；输出 `[{id, title, live, boundWorkItemId, lastActiveAt?}]` |

### 2.4 `recordConversation` 语义调整（自动登记）

- 新对话对象首次登记 → 同时绑定 `workItemId`（保持 v2「参与即登记」的体验）。
- 已绑定 A、参与 B → 只追加 `workItems` 历史 + `contextVersions[B]`，不改绑定（改绑必须显式流程，符合 PRD 3.1）。
- 无绑定、参与 B → 绑定 B。

### 2.5 新增 agent 工具（`tool()` 注册）

- `kanban_bind_conversation`：`{ workItemId（必）, confirm（布尔） }`。描述注明：当前会话已绑定其他工作项时，须用户明确同意改绑后带 `confirm: true` 再次调用；返回 `needsConfirm` 时向用户说明并等待同意。
- `kanban_unbind_conversation`：`{ workItemId? }`，解绑当前会话。

### 2.6 `kanban_view` 输出扩展

- conversations 数组每项加 `title`、`workItemId`、`live`（供 agent 引用真实对话名）。

## 3. Client 改造（`aikanban-package/lib/client.js`）

### 3.1 依赖与状态

- `inject` 保持 `['slots']`；新增 `ctx.get('workspaces')` 可选读取（缺失时「＋ 新建对话」按钮禁用并提示）。
- 复用现有 `rpc()/call()/useStore()/refresh()`，getState 新字段直接可用，无新轮询机制。

### 3.2 工作项详情对话区（ItemDetail）

- 按钮行：「＋ 新建对话」（primary）、「绑定已有对话」（ghost）。
- 绑定面板（展开态）：`listSessions` → 列表项显示真实标题 + live 标记 + 已绑定标记（已绑定其他工作项显示其标题）。点击：
  - 未绑定 → `bindConversation({workItemId, sessionId})` 直接绑定；
  - 已绑定 A → 内联确认「从 A 改绑到 Y？」→ 确认后带 `confirm:true` 调用。
- 每个对话行：真实标题（无标题回退「会话 xxxx」）；live 时提供「重命名」→ 内联输入框 → `renameConversation`；非 live 显示 muted「打开会话后可重命名」；「解绑」按钮直接执行（可逆、不动其他数据，不设二次确认）。
- 空状态文案：无会话可绑 →「当前工作区暂无其他会话」。

### 3.3 对话详情页（ConvDetail）

- 标题行显示真实标题；live 时提供重命名入口，非 live 显示提示。
- 新增「解绑」按钮；「参与的任务」列表照旧（历史语义）。

### 3.4 新建对话流程（核心闭环）

1. 点击「＋ 新建对话」：记录 `pendingBind = { workItemId, clickedSessionId: 当前 sid, deadline: now + 10min }`，写入模块变量 + `localStorage`（防刷新丢失）。
2. 调用 `ctx.workspaces.startSession()`（无参，继承当前会话工作区；DSH 标准新会话流程，成功后当前窗口自动跳到新会话）。
3. 会话切换 → `conversation.view` 插槽以新 `sessionId` 重渲染 `App` → App 副作用中检测：`pendingBind` 存在、未过期、且 `sid !== clickedSessionId` → 调 `bindConversation({workItemId, sessionId: sid})` → 成功后清除 `pendingBind`（模块变量 + localStorage）。
4. 不注入上下文（PRD 3.3）：新对话从空开始，agent 按需调 `kanban_get_handoff_context`。
5. 失败处理：startSession 失败（会话列表状态报错）不建立绑定；pendingBind 超时（10 分钟）或过期后静默作废，避免误绑后续打开的会话。
6. 备选路径（仅当 startSession 不触发插槽重挂载时启用）：`workspaces.connectWorkspace(workspaceId)` 返回确定的新 `sessionId` → 先 `bindConversation` 再 `ctx.sessions.open(sessionId)`。默认主路径，备选只在验证 P5 时评估。

## 4. 兼容与边界

- 旧 `.dsh-kanban.json` 直接加载，载入时 normalize，不升级 schema。
- `sessionTitle` / `sessionQuery` 任一缺失 → 标题整体回退，重命名禁用（UI 提示），其余功能不受影响。
- 工作区过滤失败（cwd 不可比）→ 降级列出全部已知会话并标注工作区，不阻断绑定。
- 只读沙箱/commit 失败 → 沿用 `lastPersistError` 展示，UI 不崩；操作结果明确失败提示。
- 所有写操作走现有 `commit()` 队列，无并发新风险。

## 5. 修改点清单（代码级索引）

| 文件 | 位置 | 动作 |
| --- | --- | --- |
| index.js | `emptyState/ensureReady/refine` | 载入后调 `normalizeConversations` |
| index.js | 新增 | `resolveTitles` / `opBindConversation` / `opUnbindConversation` / `opRenameConversation` / `opListSessions` |
| index.js | `recordConversation` | 按 §2.4 调整绑定语义 |
| index.js | `rpc()` 注册段 | 加 4 个 RPC |
| index.js | `tool()` 注册段 | 加 2 个工具 |
| index.js | `kanban_view` | conversations 输出扩展 |
| client.js | `inject/apply` 开头 | 可选读 `ctx.get('workspaces')` |
| client.js | `ItemDetail` | 对话区按钮行、绑定面板、重命名、解绑 |
| client.js | `ConvDetail` | 标题/重命名/解绑 |
| client.js | `App` + 新增 | `pendingBind` 模块状态 + localStorage + 自动绑定副作用 |
| client.js | `styles` | 新增确认条/绑定面板/内联重命名样式 |

## 6. 实施顺序与验收

- 顺序：P1（Host 数据层与迁移）→ P2（Host RPC 与工具）→ P3（标题解析）→ P4（Client 绑定/解绑/重命名 UI）→ P5（新建对话流程）→ P6（验收）。每阶段完成即可独立验证（P1/P2 用工具验证，P3+ 用看板 UI 验证）。
- 验收用例：

| 验收用例 | 预期行为 |
| --- | --- |
| 工作项里打开「绑定已有对话」 | 只列当前工作区会话；显示真实标题；已绑定会话有标记 |
| 绑定未归属会话 | 立即绑定；contextVersions 记录当时最新记忆版本 |
| 改绑已归属会话 | 弹「从 X 改绑到 Y」确认后才生效；旧归属保留在参与历史 |
| 解绑 | 绑定清除；建议、记忆版本来源、上下文版本记录不动 |
| 重命名已打开会话 | 看板内修改同步为 DSH 会话标题 |
| 未打开会话 | 只读显示真实标题，无重命名入口 |
| 点「＋ 新建对话」 | 新会话自动绑定该工作项、当前窗口跳转、不注入上下文 |
| agent 工具 | bind 改绑需 confirm:true；unbind 解绑当前会话 |
| 重启后 | 绑定关系从 .dsh-kanban.json 恢复 |
| 待绑定意图过期 | 10 分钟未兑现自动作废，不误绑后续打开的会话 |

- PRD §7 新增自用验证：① 至少 1 次在工作项内「新建对话 → 自动绑定 → agent 取交接上下文继续」闭环；② 对话列表显示 DSH 真实标题；至少完成 1 次活会话重命名与 1 次改绑确认。
- 回归点：拖拽流转、记忆建议审核、交接上下文、归档/删除不受影响（改动集中在对话区与派生字段）。

## 7. 风险与备选

- `sessionTitle`/`sessionQuery` 是可选依赖：缺失时降级为占位标题 + 禁用重命名，不阻断其他功能。
- `readTitleSnapshots` 对不存在/已删除会话返回空 → 回退占位标题。
- `workspaces.startSession` 失败或未切换插槽 → pendingBind 过期机制兜底；备选 `connectWorkspace + sessions.open`。
- 工作区 cwd 规范化在 Windows 下的斜杠/大小写差异 → 比较前统一规范化（沿用现有 workspace 解析逻辑的路径风格）。
