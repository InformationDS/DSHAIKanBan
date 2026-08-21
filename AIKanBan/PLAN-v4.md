# AIKanBan v4 执行方案（看板内一键生成记忆 + 工作项内新建对话自动注入上下文）

> 依据：`DSH-PRD.md` v3（现状契约）与本方案（v4 增量）。
> 本方案只描述实现路径；改动范围仅 `aikanban-package/lib/index.js`（Host）、`aikanban-package/lib/client.js`（Client）两个源码文件 + 文档（DSH-PRD.md / REBUILD.md / README.md / 本文件），不新增依赖、不新增代码文件、不改 `PRD.md`（Codex 版）。

## 0. 需求基线（v4，已对齐确认）

- **功能一**：看板内直接点按钮生成记忆建议——工作项详情页「✨ 生成任务记忆建议」、项目记忆页「✨ 生成项目记忆建议」。点击后由**当前会话 agent**（机制 A）在聊天中起草并提交，用户在审核队列 diff 确认后才成正式记忆（确认优先原则不变）。
- **功能二**：工作项内「＋ 新建对话」后，**自动把项目记忆 + 工作项信息 + 任务记忆作为上下文注入新对话**（v3 的「不自动注入」作废）。注入内容 = 完整交接上下文文本（内容方案 A）。
- 两个决策点均已确认：
  1. 生成机制 **A**（派发当前会话 agent，复用 kanban_start/submit 工具闭环），不用 B（Host 直连 llm）或 C（后台子 agent）。
  2. 注入内容 **A**（完整交接上下文全文，作为新会话首条用户消息），不用 B（仅注入一行取数指令）。

## 1. 机制核实（来自 DSH 运行时本体，实施前可再查一次 `cordis_inspect_list`）

- **消息投递**：Host 侧 `ctx.get('agents')` → `agents.get(sessionId)` 返回活会话 `Agent`（dsh-agent 公共接口），其上公开：
  - `followup(message)`：把消息作为「独立 turn 的唯一普通消息」排队并唤醒 driver——新建对话注入用这个。
  - `steer(message)` / `inject(message)`：step 级 steering / 不唤醒的上下文——本期不用。
  - 消息在对话面呈现为 user 角色消息并进入模型输入；`source` 区分来源。
- **消息形状**（UserMessage，构造字面量即可，无需 import）：
  ```js
  { id: makeId('msg'), role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'dsh-aikanban', form: 'instructions' } }
  ```
  `form:'notice'` 需要 `summary`（≤120 字符，折叠行摘要）——本期一律用 `form:'instructions'`，简单可靠。
- **会话创建**：`workspaces.startSession()` 只接受 workspaceId、无 prompt 参数 → 上下文只能走「创建 + 绑定 + 投递」链路（v3 pendingBind 已建好前两步）。
- **就绪竞态**：新会话 agent 何时在 `agents` 注册无契约保证 → 注入 RPC 单次尝试，**由 Client 端重试**（Client 已有 `timer` 服务，v3 的 4s 轮询已证明可用；Host 不新增 timer 依赖）。
- **RPC 通道**：Client → Host 走既有 `/aikanban-api` HTTP 前缀（`rpc()` 注册即自动可用），args.sessionId 默认当前会话。

## 2. Host 改造（`aikanban-package/lib/index.js`）

### 2.1 新增助手（放在 `recordConversation` 之后）

```js
// ---- v4：插件 → 会话消息投递 ----
function pluginUserMessage(text) {
  return {
    id: makeId('msg'), role: 'user',
    content: [{ type: 'text', text: text }],
    source: { kind: 'plugin', plugin: 'dsh-aikanban', form: 'instructions' },
  }
}
function liveAgentOf(sessionId) {
  const a = ctx.get('agents')
  if (!a) return undefined
  try { return a.get(sessionId) } catch (err) { return undefined }
}
function canFollowup(agent) {
  return !!(agent && typeof agent.followup === 'function')
}
```

### 2.2 抽取 `buildHandoffText(workItemId, note)`（改造 `opHandoffContext`）

把 `opHandoffContext`（现行 ~line 643）中的文本组装抽成独立函数，`opHandoffContext` 与新的 `opInjectHandoff` 共用：

```js
function buildHandoffText(workItemId, note) {
  const wi = workItemId ? findWorkItem(workItemId) : undefined
  const lines = []
  lines.push('# 交接上下文（AIKanBan for DSH）')
  lines.push('')
  lines.push('- 工作区：' + (state.workspace || '未知'))
  lines.push('- 生成时间：' + nowIso())
  lines.push('')
  lines.push(memoryToMarkdown('project', latestMemory('project', undefined), state.projectMemories.length))
  lines.push('')
  if (wi) {
    lines.push('## 工作项：' + wi.title)
    lines.push('- 状态：' + wi.status)
    lines.push('- 目标：' + (wi.goal || '（空）'))
    lines.push('- 当前进度：' + (wi.progress || '（空）'))
    lines.push('- 下一步：' + (wi.next || '（空）'))
    if (wi.status === '已阻塞') lines.push('- 阻塞原因：' + (wi.blockedReason || '（空）'))
    lines.push('')
    const list = state.taskMemories[wi.id] || []
    lines.push(memoryToMarkdown('task', latestMemory('task', wi.id), list.length))
  }
  lines.push('')
  lines.push('## 本次补充说明')
  lines.push((note || '').trim() || '（无）')
  return lines.join('\n')
}
```

`opHandoffContext` 改为：`const text = buildHandoffText(workItemId, note)`，其余逻辑不变（记录参与对话、返回 `{ok:true, text}`）。

### 2.3 新增 RPC `dispatchMemoryGeneration`

```js
// v4 RPC：看板按钮 → 当前会话 agent 起草记忆建议
async function opDispatchMemoryGeneration(args, exec) {
  await ensureReady()
  await refine(exec)
  const kind = args && args.kind === 'project' ? 'project' : 'task'
  const workItemId = kind === 'task' ? strOr(args && args.workItemId) : undefined
  if (kind === 'task' && !findWorkItem(workItemId)) return { ok: false, error: '工作项不存在' }
  const existing = state.proposals.find((p) =>
    p.kind === kind && (kind === 'project' || p.workItemId === workItemId) && ACTIVE.indexOf(p.status) >= 0)
  if (existing) {
    return { ok: false, code: 'active-proposal', proposalId: existing.id, proposalStatus: existing.status,
      error: existing.status === 'pending'
        ? '该范围已有待审核建议，请先审核或放弃后再生成'
        : '该范围已有起草中建议，agent 起草时会复用它' }
  }
  const sid = strOr(args && args.sessionId) || currentSessionId(exec)
  const live = liveAgentOf(sid)
  if (!canFollowup(live)) return { ok: false, code: 'agent-not-ready', error: '当前会话 agent 未就绪，请稍后重试' }
  const head = kind === 'task'
    ? '看板中点击了「生成任务记忆建议」。请基于本会话（及看板中该工作项相关记录）的进展，' +
      '调用 kanban_start_memory_proposal({kind:"task", workItemId:"' + workItemId + '"}) 获取基础版本，' +
      '保留仍有效的内容、只增删改确有变化的部分，起草更新后的 6 个分区，' +
      '然后调用 kanban_submit_memory_proposal 提交为待审核建议。用户在审核队列确认后才成为正式记忆。'
    : '看板中点击了「生成项目记忆建议」。请基于最新项目记忆与各工作项/对话的进展，' +
      '调用 kanban_start_memory_proposal({kind:"project"}) 获取基础版本，' +
      '保留仍有效内容、只增删改确有变化的部分，起草更新后的 5 个分区，' +
      '然后调用 kanban_submit_memory_proposal 提交为待审核建议。用户在审核队列确认后才成为正式记忆。'
  const note = strOr(args && args.note)
  const wi = kind === 'task' ? findWorkItem(workItemId) : undefined
  const text = head
    + (note ? '\n本次生成说明：' + note : '')
    + (wi ? '\n目标工作项：' + wi.title : '')
  live.followup(pluginUserMessage(text))
  return { ok: true, dispatched: true, sessionId: sid }
}
```

要点：
- 范围已有活动建议 → 不派发，返回 `code:'active-proposal'`（UI 层也会先禁用按钮，双保险）。
- `followup` 排队独立 turn：当前 agent 正在跑时排到下一 turn，不打断。
- 不写任何看板数据（不 commit）——proposal 的产生与参与对话登记都由 agent 后续调工具完成。
- 不强制绑定：当前会话未绑定该工作项时，agent 调 startProposal 会按既有语义自动登记参与。

### 2.4 新增 RPC `injectHandoff`

```js
// v4 RPC：把交接上下文作为一条用户消息注入目标会话（新建对话自动注入 / 手动注入共用）
async function opInjectHandoff(args, exec) {
  await ensureReady()
  await refine(exec)
  const sessionId = strOr(args && args.sessionId) || currentSessionId(exec)
  if (!sessionId || sessionId === 'unknown') return { ok: false, error: '无法确定会话' }
  const workItemId = strOr(args && args.workItemId)
  const wi = workItemId ? findWorkItem(workItemId) : undefined
  if (!wi) return { ok: false, error: '工作项不存在' }
  const conv = state.conversations.find((c) => c.id === sessionId)
  if (!conv || conv.workItemId !== workItemId) return { ok: false, code: 'not-bound', error: '该会话未绑定此工作项' }
  const live = liveAgentOf(sessionId)
  if (!canFollowup(live)) return { ok: false, code: 'agent-not-ready', error: '目标会话未打开（agent 未就绪）' }
  const text = buildHandoffText(workItemId, undefined)
    + '\n\n以上是 AIKanBan 看板交接上下文（项目记忆 + 工作项信息 + 任务记忆）。'
    + '请基于它继续工作项「' + wi.title + '」；如需更新版本可用 kanban_get_handoff_context 重新读取。'
  live.followup(pluginUserMessage(text))
  // 登记「目标会话」（注意：exec 是点击方会话，必须显式指向目标）
  recordConversation({ agent: { id: sessionId } }, workItemId)
  commit()
  return { ok: true, injected: true, sessionId: sessionId }
}
```

要点：
- 绑定校验：只有已绑定该工作项的会话才注入（自动流程里 bind 先于 inject，天然满足；手动按钮只对已绑定行出现）。
- `recordConversation({agent:{id: sessionId}}, workItemId)` 把**目标**会话的 `contextVersions[workItemId]` 刷新为最新记忆版本——注入后该对话「上下文 最新」徽标立即正确。
- 注入后新会话的 agent 因 followup 被唤醒，直接以交接上下文开跑第一个 turn。
- `agent-not-ready` 交给 Client 重试（见 §3.4）。

### 2.5 RPC 注册（`rpc()` 注册段，现行 ~line 813）

```js
rpc('dispatchMemoryGeneration', opDispatchMemoryGeneration)
rpc('injectHandoff', opInjectHandoff)
```

不新增 agent 工具（`tool()` 段不动）；`kanban_view` 输出不动。

## 3. Client 改造（`aikanban-package/lib/client.js`）

### 3.1 模块级新增（`startNewConversation` 附近，现行 ~line 142）

```js
// v4：注入失败降级提示（模块变量 + localStorage，防刷新丢失）
const INJ_KEY = 'aikanban:injectNote'
let injectNote = ''
try { injectNote = window.localStorage.getItem(INJ_KEY) || '' } catch (e) {}
function setInjectNote(s) {
  injectNote = s
  try { if (s) window.localStorage.setItem(INJ_KEY, s); else window.localStorage.removeItem(INJ_KEY) } catch (e) {}
}

// v4：注入重试（新会话 agent 就绪无契约保证；timer 已在 apply 开头 ctx.get('timer') 取得）
async function injectWithRetry(sessionId, workItemId, maxAttempts) {
  const max = maxAttempts || 5
  for (let i = 0; i < max; i++) {
    const r = await call('injectHandoff', { sessionId: sessionId, workItemId: workItemId })
    if (r && r.ok) { setInjectNote(''); return true }
    if (r && r.code === 'not-bound') return false // 绑定没成，不注入、不提示重试
    if (i < max - 1 && timer) await timer.timeout(2000)
  }
  setInjectNote('上下文自动注入未完成（新会话 agent 未就绪）：可在工作项对话区对该对话点「注入上下文」重试')
  return false
}

// v4：生成派发（agent-not-ready 时客户端重试，与注入同理）
async function dispatchWithRetry(kind, workItemId, note) {
  const max = 5
  for (let i = 0; i < max; i++) {
    const r = await call('dispatchMemoryGeneration', { kind: kind, workItemId: workItemId, note: note })
    if (r && r.ok) return { ok: true }
    if (r && r.code === 'active-proposal') return { ok: false, msg: r.error || '该范围已有活动建议' }
    if (i < max - 1 && timer) await timer.timeout(2000)
  }
  return { ok: false, msg: '派发失败：当前会话 agent 未就绪' }
}
```

### 3.2 `ItemDetail` 任务记忆面板（现行 memPanel ~line 637）

按钮行（「手动编辑任务记忆」之前插入生成按钮）改为：

```js
const activeTaskProp = myProps.find((p) => p.status === 'drafting' || p.status === 'pending')
const [genMsg, setGenMsg] = React.useState('')
async function genTask() {
  setGenMsg('已派发，起草过程见聊天…')
  const r = await dispatchWithRetry('task', wi.id, undefined)
  setGenMsg(r.ok ? '已派发给当前对话，起草完成后将出现在审核队列' : (r.msg || ''))
}
// memPanel 按钮行：
h('div', { className: 'kb-row', style: { marginTop: 8 } },
  h(Btn, {
    className: 'primary',
    disabled: !!activeTaskProp || snap.busy,
    title: activeTaskProp ? (activeTaskProp.status === 'pending' ? '已有待审核建议，请先审核或放弃' : '已有起草中建议，先处理再生成') : '',
    onClick: genTask,
  }, '✨ 生成任务记忆建议'),
  h(Btn, { onClick: () => setEditMem(!editMem) }, editMem ? '收起手动编辑' : '手动编辑任务记忆'),
  h(Btn, { className: 'ghost', onClick: () => setShowHandoff(!showHandoff) }, showHandoff ? '收起交接' : '生成交接上下文')),
genMsg ? h('div', { className: 'kb-muted', style: { marginTop: 6 } }, genMsg) : null
```

- 原「让 agent 起草：在聊天中要求…」的 muted 提示文字删除（被按钮取代）。
- `activeTaskProp` 存在时按钮禁用并给 title 说明。

### 3.3 `ItemDetail` 已绑定对话行（现行 ~line 607）加「注入上下文」

在「重命名」与「解绑」按钮之间插入（仅 live 行显示；非 live 行保持现状）：

```js
live ? h(Btn, { title: '把最新项目记忆 + 任务记忆作为一条消息注入该对话',
  onClick: (e) => { e.stopPropagation(); injectWithRetry(c.id, wi.id, 2) } }, '注入上下文') : null
```

### 3.4 `App` pendingBind 消费处（现行 ~line 812）串联注入

把现有：

```js
call('bindConversation', { workItemId: pb.workItemId, sessionId: sid }).then((r) => {
  if (r && r.ok) refresh()
})
```

改为：

```js
call('bindConversation', { workItemId: pb.workItemId, sessionId: sid }).then((r) => {
  if (r && r.ok) {
    refresh()
    // v4：绑定成功后自动注入交接上下文（内部 5×2s 重试；失败降级提示 + 手动按钮兜底）
    injectWithRetry(sid, pb.workItemId, 5)
  }
})
```

另外在 `Board`（或 App 顶部 errorBar 旁）渲染 `injectNote`：

```js
const injectBar = injectNote ? h('div', { className: 'kb-root', style: { paddingBottom: 0 } },
  h('div', { className: 'kb-confirm' }, injectNote,
    h(Btn, { onClick: () => setInjectNote('') }, '知道了'))) : null
```

### 3.5 `ProjectMemoryView`（现行 ~line 761）加生成按钮

与 §3.2 同构：

```js
const activeProjectProp = st.proposals.find((p) => p.kind === 'project' && (p.status === 'drafting' || p.status === 'pending'))
const [genMsg, setGenMsg] = React.useState('')
async function genProject() {
  setGenMsg('已派发，起草过程见聊天…')
  const r = await dispatchWithRetry('project', undefined, undefined)
  setGenMsg(r.ok ? '已派发给当前对话，起草完成后将出现在审核队列' : (r.msg || ''))
}
// 按钮行（手动编辑按钮旁）：
h(Btn, {
  className: 'primary',
  disabled: !!activeProjectProp || snap.busy,
  title: activeProjectProp ? '已有活动建议，请先处理' : '',
  onClick: genProject,
}, '✨ 生成项目记忆建议')
// 原「让 agent 起草项目记忆建议：在聊天中要求…」muted 文字删除
// genMsg 提示行同 §3.2
```

### 3.6 样式（`styles.insert` 的 CSS 段）

无需新样式类：按钮用现有 `kb-btn.primary`/禁用态，提示用 `kb-muted`，降级条复用 `kb-confirm`。如确需，加一条 `.kb-btn:disabled { cursor: not-allowed; }` 细化即可（现有 `:disabled` 已有 opacity）。

## 4. 数据模型与兼容性

- **零迁移**：不加字段、不升 schemaVersion。gen 请求无状态；注入只复用 `conversations.contextVersions` 与绑定关系。
- 旧 `.dsh-kanban.json` 直接加载，v3 normalize 逻辑不动。
- 核心原则不变：建议必须审核确认才成记忆；未确认内容不进交接上下文；状态由用户最终决定。

## 5. 修改点清单（代码级索引）

| 文件 | 位置 | 动作 |
| --- | --- | --- |
| index.js | `recordConversation` 后（~line 379） | 新增 `pluginUserMessage` / `liveAgentOf` / `canFollowup` |
| index.js | `opHandoffContext`（~line 643） | 抽 `buildHandoffText(workItemId, note)`，原函数改为调用它 |
| index.js | 新增（放在 `opListSessions` 后） | `opDispatchMemoryGeneration` / `opInjectHandoff` |
| index.js | `rpc()` 注册段（~line 813） | 注册 `dispatchMemoryGeneration`、`injectHandoff` |
| client.js | `startNewConversation` 附近（~line 142） | 新增 `injectNote`/`setInjectNote`、`injectWithRetry`、`dispatchWithRetry` |
| client.js | `ItemDetail` memPanel（~line 637） | 「✨ 生成任务记忆建议」按钮 + 禁用态 + 提示行；删旧 muted 提示 |
| client.js | `ItemDetail` boundConvs 行（~line 607） | live 行加「注入上下文」按钮 |
| client.js | `App` pendingBind 消费（~line 812） | bind 成功后串联 `injectWithRetry` |
| client.js | `App` / `Board` 顶部 | 渲染 `injectNote` 降级提示条（`kb-confirm`） |
| client.js | `ProjectMemoryView`（~line 761） | 「✨ 生成项目记忆建议」按钮 + 提示行；删旧 muted 提示 |
| DSH-PRD.md | §3.3 / §4 / §6 / §7 | v4 契约（见 §7） |
| REBUILD.md / README.md | 相应段落 | 同步 v4 能力与重建指引 |

## 6. 实施顺序与验收

- 顺序：P1（Host 助手 + 两个 RPC）→ P2（生成按钮）→ P3（新建对话注入）→ P4（手动注入 + 降级 UI）→ P5（文档 v4）→ P6（回归）。
- Host RPC 冒烟（无需 UI）：curl 或 pwsh `Invoke-RestMethod`：
  ```powershell
  curl.exe -s -X POST http://127.0.0.1:3080/aikanban-api `
    -H "content-type: application/json" `
    -d '{"method":"dispatchMemoryGeneration","args":{"kind":"task","workItemId":"<wid>","sessionId":"<当前会话id>"}}'
  ```
  （当前会话 id 从 `kanban_view` 的 conversations 中 `live:true` 项取得；工作项 id 同理。）

### 验收用例

| # | 用例 | 预期行为 |
| --- | --- | --- |
| P1-1 | 冒烟 dispatchMemoryGeneration | 返回 `{ok:true,dispatched:true}`；聊天中 agent 开始新 turn 起草建议 |
| P1-2 | 冒烟 injectHandoff（当前绑定工作项的活会话） | 返回 `{ok:true,injected:true}`；目标会话出现 plugin 源首条消息（交接上下文全文）；该会话 contextVersions 刷新为最新 |
| P1-3 | injectHandoff 对未绑定工作项的会话 | `{ok:false,code:'not-bound'}` |
| P1-4 | injectHandoff 对未打开会话 | `{ok:false,code:'agent-not-ready'}` |
| P2-1 | 工作项详情点「✨ 生成任务记忆建议」 | 按钮短暂显示「已派发…」；聊天中 agent 调 start+submit；审核队列 +1；确认后任务记忆 V+1 |
| P2-2 | 该范围已有待审核/起草中建议时 | 按钮禁用（title 说明）；直接调 RPC 返回 `active-proposal` |
| P2-3 | 项目记忆页点「✨ 生成项目记忆建议」 | 同 P2-1，kind=project |
| P3-1 | 工作项内「＋ 新建对话」 | 新会话自动绑定；首条消息即交接上下文（项目记忆+工作项+任务记忆）；agent 带记忆开跑；对话时间线新增对话且「上下文 最新」 |
| P3-2 | 注入时新 agent 未就绪（可人为延迟/断网模拟） | 5×2s 重试；仍失败 → 看板降级提示条 + 手动注入按钮可补救 |
| P4-1 | 对话行「注入上下文」 | 仅 live 行显示；点击后该对话收到交接上下文消息，contextVersions 刷新 |
| P4-2 | 非 live 对话行 | 无注入按钮（现状提示「打开会话后可重命名」不变） |
| P6-1 | 回归 | 拖拽流转、审核确认/放弃、过期建议、归档/删除、手动编辑记忆、交接页生成均不受影响 |
| P6-2 | 兼容 | 旧 `.dsh-kanban.json` 直接加载，无报错、无数据丢失 |

## 7. 文档更新清单（P5，随实施落地）

- `DSH-PRD.md` 升 v4：
  - §3.3「不自动注入上下文」改为「自动注入交接上下文」：流程 = startSession → 自动绑定 → injectHandoff 投递完整交接文本；失败降级提示 + 对话行手动「注入上下文」按钮；注入内容为已确认的最新项目记忆 + 工作项信息 + 任务记忆，未确认内容仍不进上下文。
  - §4 UI：工作项详情任务记忆面板与项目记忆页各加「✨ 生成记忆建议」按钮；对话行加「注入上下文」。
  - §6 实现约束：新增 RPC `dispatchMemoryGeneration` / `injectHandoff`；消息投递机制 = `agents.get(sessionId).followup(UserMessage)`，source=`{kind:'plugin', plugin:'dsh-aikanban', form:'instructions'}`；生成与注入都只是把建议/上下文送到位，确认优先原则不变。
  - §7 自用验证：补两条闭环（① 看板点按钮 → agent 起草 → 审核确认成版本；② 新建对话 → 自动注入 → agent 带记忆继续）。
- `REBUILD.md`：重建指引不变（文件仍是同一对 lib/index.js + lib/client.js）；补一句 v4 能力说明。
- `README.md`：产品形态与使用方式补 v4 两句。

## 8. 风险与降级

- `Agent.followup` 的形状来自 dsh-agent 公共契约，但动态插件运行时实际行为以 P1 冒烟为准；若消息对象被 inbox 校验拒绝（如要求冻结对象），优先排查构造形状，必要时在 `agent/session-start` 事件后投递作为备选时序。
- 新会话 agent 就绪竞态 → 客户端重试 + 超时降级 + 手动按钮三层兜底；冷会话（未打开）注入不在本期范围（后续如需支持，需验证 `sessionPersistence.append` 的 seq/turn 契约，风险高）。
- 注入文本较长 → 单条消息可容纳（交接上下文通常几 KB）；如遇超长可考虑截断 + 提示 agent 用 `kanban_get_handoff_context` 补全（本期不做）。
- 生成派发依赖当前会话 agent 可用；agent 忙时 followup 排队，不打断现有 turn。
- 只读沙箱/commit 失败 → 沿用 `lastPersistError` 展示，注入/派发本身的返回码不受影响。

## 9. 交付提示词（交新对话实施用，复制整段）

见下。实施者必须：先读本文件与 DSH-PRD.md，再改两个源码文件，最后按 REBUILD.md 用 cordis_define/cordis_run 重建插件并请用户批准，跑完 §6 验收用例。

---

> ## 实施提示词（复制给新对话）
>
> 请实施 AIKanBan 看板插件 v4 迭代（两个能力：看板内一键生成记忆建议；工作项内新建对话自动注入交接上下文）。工作区：D:\BaiduSyncdisk\dsh-plugin。
>
> 【第一步：读材料】
> 1. 读 AIKanBan/PLAN-v4.md（本次完整执行方案，含机制核实、改动清单、验收用例，实施时以它为准）；
> 2. 读 AIKanBan/DSH-PRD.md（v3 现状契约）；
> 3. 读源码：AIKanBan/aikanban-package/lib/index.js（Host）与 lib/client.js（Client）；
> 4. 读 AIKanBan/REBUILD.md（动态插件重建流程）。
>
> 【第二步：按 PLAN-v4.md §2–§5 实施，顺序 P1→P6】
> - P1 Host：新增 pluginUserMessage/liveAgentOf/canFollowup 助手；把 opHandoffContext 的文本组装抽为 buildHandoffText；新增并注册 RPC dispatchMemoryGeneration 与 injectHandoff（行为与返回码严格按方案）。
> - P2 Client：ItemDetail 任务记忆面板加「✨ 生成任务记忆建议」按钮（范围有活动建议时禁用）、派发提示与重试（dispatchWithRetry，5×2s）；ProjectMemoryView 加「✨ 生成项目记忆建议」。
> - P3 Client：App pendingBind 消费处，bind 成功后串联 injectWithRetry(5×2s)；注入失败降级提示条（injectNote + localStorage）。
> - P4 Client：工作项已绑定对话行（live）加「注入上下文」按钮（injectWithRetry 2 次）。
> - P5 文档：DSH-PRD.md 升 v4（§3.3 自动注入、§4 UI、§6 RPC、§7 验证清单）；REBUILD.md / README.md 同步。
> - P6 回归：按方案 §6 验收用例逐条验证（含拖拽流转、审核、过期、归档、旧数据加载）。
>
> 【已确认决策（不要改）】
> - 生成机制 A：按钮把指令消息派发给当前会话 agent（ctx.agents.get(sessionId).followup(...)），agent 用 kanban_start_memory_proposal + kanban_submit_memory_proposal 起草提交，用户在审核队列 diff 确认后成正式记忆。
> - 注入内容 A：注入完整交接上下文文本（项目记忆 + 工作项信息 + 任务记忆）作为新会话首条用户消息。
> - 消息构造字面量：{ id: makeId('msg'), role:'user', content:[{type:'text',text}], source:{kind:'plugin', plugin:'dsh-aikanban', form:'instructions'} }。
> - 零数据迁移：不加字段、不升 schemaVersion；「确认优先」原则不变；未确认内容不进注入文本。
>
> 【硬约束】
> - 只改 AIKanBan/aikanban-package/lib/index.js、lib/client.js 与文档；不新增依赖、不新增代码文件。
> - 纯 JS：无 import/require、无 TS、无 JSX（React.createElement）；工具注册沿用现有 tool()/harness.defineTool 双环境写法（v4 不新增 agent 工具）；文件写入沿用 commit() 的策略解析方式。
> - 重建验证：改完文件后，按 REBUILD.md 用 cordis_define（kind:new，idPrefix 自定，code.host=lib/index.js 全文，code.client=lib/client.js 全文）+ cordis_run 重建插件并请用户批准；冒烟 RPC 可用 curl POST http://127.0.0.1:3080/aikanban-api（见 PLAN-v4.md §6）。
> - 数据文件 .dsh-kanban.json 重建不清数据，改坏可重来；但不要改动该文件内容本身。
>
> 【验收要求】
> 跑完 PLAN-v4.md §6 全部验收用例并逐条记录结果；失败修复后重验；最后报告：改动文件清单、验收结果表、遗留风险与未决项。
