window.__ModuleLoader__.load({
	id: "@omdsh-dev/dsh-aikanban",
	factory: (require) => {
		let React = require('react');
		if (React && React.__esModule) React = React.default;
		const module = { exports: {} };
		const exports = module.exports;
		const plugin = {
			inject: ['slots'],
			async apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) return
    const timer = ctx.get('timer')
    const workspaces = ctx.get('workspaces')
    const clientSessions = ctx.get('sessions')
    const h = React.createElement
    const styles = {
      insert(css) {
        if (typeof document === 'undefined') return
        const id = '@omdsh-dev/dsh-aikanban'
        let el = document.querySelector('style[data-plugin-css="' + id + '"]')
        if (!el) {
          el = document.createElement('style')
          el.setAttribute('data-plugin-css', id)
          document.head.appendChild(el)
        }
        el.textContent = css
      },
    }


    const TASK_LABELS = {
      goal_scope: '任务目标与范围',
      decisions: '已确认的决策与约束',
      progress_done: '已完成工作与当前进展',
      artifacts: '关键产物与验证结果',
      open_issues: '未解决问题、阻塞与风险',
      next_steps: '下一步',
    }
    const PROJECT_LABELS = {
      purpose_scope: '项目目的与范围',
      conventions: '共享约束与工作约定',
      project_decisions: '已确认的项目级决策',
      cross_workitem: '跨工作项上下文与依赖',
      open_issues: '项目级未决问题与风险',
    }
    const STATUSES = ['未开始', '进行中', '已阻塞', '已完成', '已取消']
    const STATUS_CLASS = { '未开始': 'todo', '进行中': 'doing', '已阻塞': 'blocked', '已完成': 'done', '已取消': 'cancel' }
    const PROPOSAL_LABELS = { drafting: '起草中', pending: '待审核', expired: '已过期', confirmed: '已确认', abandoned: '已放弃' }

    styles.insert(`
.kb-root { display: flex; flex-direction: column; gap: 12px; padding: 14px 16px; font-size: 13px; line-height: 1.5; }
.kb-root * { box-sizing: border-box; }
.kb-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.kb-title { font-size: 16px; font-weight: 600; color: light-dark(#1a1a1a, #ececec); }
.kb-sub { font-size: 12px; color: light-dark(#888, #9a9a9a); }
.kb-grow { flex: 1; }
.kb-btn { font-size: 12px; padding: 4px 10px; border-radius: 7px; border: 1px solid light-dark(rgba(0,0,0,.18), rgba(255,255,255,.2)); background: light-dark(#fff, #2a2a2a); cursor: pointer; color: light-dark(#222, #e5e5e5); }
.kb-btn:hover { background: light-dark(#f0f0f0, #3a3a3a); }
.kb-btn.primary { background: #2563eb; border-color: #2563eb; color: #fff; }
.kb-btn.primary:hover { background: #1d4ed8; }
.kb-btn.on { background: #2563eb; border-color: #2563eb; color: #fff; }
.kb-btn.danger { color: light-dark(#b91c1c, #f87171); border-color: light-dark(rgba(185,28,28,.5), rgba(248,113,113,.5)); }
.kb-btn.ghost { border-color: transparent; background: transparent; }
.kb-btn.ghost:hover { background: light-dark(rgba(0,0,0,.06), rgba(255,255,255,.08)); }
.kb-btn:disabled { opacity: .45; cursor: default; }
.kb-badge { font-size: 11px; padding: 2px 9px; border-radius: 999px; border: 1px solid light-dark(rgba(0,0,0,.15), rgba(255,255,255,.18)); color: light-dark(#666, #b0b0b0); background: transparent; }
.kb-badge.warn { border-color: light-dark(#f59e0b, #b45309); color: light-dark(#b45309, #fbbf24); cursor: pointer; }
.kb-chip { display: inline-block; font-size: 11px; padding: 1px 8px; border-radius: 999px; border: 1px solid light-dark(rgba(0,0,0,.15), rgba(255,255,255,.18)); background: light-dark(#eee, #333); color: light-dark(#333, #bbb); }
.kb-chip.doing { background: light-dark(#dbeafe, #1e3a5f); color: light-dark(#1d4ed8, #93c5fd); }
.kb-chip.blocked { background: light-dark(#fee2e2, #4c1d1d); color: light-dark(#b91c1c, #fca5a5); }
.kb-chip.done { background: light-dark(#dcfce7, #14532d); color: light-dark(#15803d, #86efac); }
.kb-chip.cancel { background: light-dark(#f3f4f6, #333); color: light-dark(#6b7280, #999); }
.kb-chip.pending { background: light-dark(#fef3c7, #4a3608); color: light-dark(#92400e, #fcd34d); }
.kb-chip.expired { background: light-dark(#f3f4f6, #333); color: light-dark(#9ca3af, #777); }
.kb-chip.latest { background: light-dark(#dcfce7, #14532d); color: light-dark(#15803d, #86efac); }
.kb-board { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; align-items: start; }
.kb-col { background: light-dark(rgba(0,0,0,.03), rgba(255,255,255,.04)); border: 1px solid light-dark(rgba(0,0,0,.1), rgba(255,255,255,.12)); border-radius: 10px; padding: 8px; min-height: 100px; }
.kb-col.dragover { border-color: #2563eb; }
.kb-col-head { display: flex; align-items: center; gap: 6px; font-weight: 600; color: light-dark(#1a1a1a, #ececec); font-size: 12px; margin-bottom: 8px; }
.kb-col-count { color: light-dark(#888, #9a9a9a); font-weight: 400; }
.kb-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.kb-card { background: light-dark(#fff, #262626); border: 1px solid light-dark(rgba(0,0,0,.12), rgba(255,255,255,.14)); border-radius: 8px; padding: 8px 9px; margin-bottom: 8px; cursor: pointer; transition: transform .15s ease; }
.kb-card:hover { transform: translateY(-1px); }
.kb-card-title { font-weight: 600; color: light-dark(#1a1a1a, #ececec); margin-bottom: 3px; }
.kb-card-goal { color: light-dark(#888, #9a9a9a); font-size: 12px; margin-bottom: 6px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.kb-card-foot { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; font-size: 11px; color: light-dark(#888, #9a9a9a); }
.kb-blocked { color: light-dark(#b91c1c, #f87171); font-size: 12px; margin-top: 4px; }
.kb-panel { background: light-dark(#fff, #262626); border: 1px solid light-dark(rgba(0,0,0,.12), rgba(255,255,255,.14)); border-radius: 10px; padding: 12px; }
.kb-panel h4 { margin: 0 0 8px; font-size: 13px; color: light-dark(#1a1a1a, #ececec); }
.kb-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.kb-muted { color: light-dark(#888, #9a9a9a); font-size: 11px; }
.kb-error { color: light-dark(#b91c1c, #f87171); font-size: 12px; margin: 4px 0; }
.kb-sec-head { font-weight: 600; font-size: 12px; margin: 12px 0 6px; color: light-dark(#1a1a1a, #ececec); }
.kb-pre { white-space: pre-wrap; font-size: 12px; background: light-dark(#f6f6f6, #2a2a2a); border: 1px solid light-dark(rgba(0,0,0,.1), rgba(255,255,255,.12)); border-radius: 6px; padding: 6px 8px; margin: 0; color: light-dark(#1a1a1a, #e5e5e5); }
.kb-input, .kb-textarea, .kb-select { width: 100%; font-size: 12px; padding: 5px 7px; border: 1px solid light-dark(rgba(0,0,0,.2), rgba(255,255,255,.2)); border-radius: 6px; background: light-dark(#fff, #2a2a2a); color: light-dark(#111, #e5e5e5); }
.kb-textarea { min-height: 56px; resize: vertical; font-family: inherit; }
.kb-label { display: block; font-size: 11px; color: light-dark(#666, #9a9a9a); margin: 6px 0 2px; }
.kb-diff { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
@media (max-width: 700px) { .kb-diff { grid-template-columns: 1fr; } }
.kb-diff-col { border: 1px solid light-dark(rgba(0,0,0,.12), rgba(255,255,255,.14)); border-radius: 8px; padding: 8px; }
.kb-diff-col.changed { border-color: light-dark(#f59e0b, #b45309); }
.kb-conv { border: 1px solid light-dark(rgba(0,0,0,.1), rgba(255,255,255,.12)); border-radius: 8px; padding: 8px 10px; margin-bottom: 8px; cursor: pointer; }
.kb-conv:hover { border-color: #2563eb; }
.kb-conv-title { font-weight: 600; color: light-dark(#1a1a1a, #ececec); }
.kb-item-title { font-size: 15px; font-weight: 700; color: light-dark(#1a1a1a, #ececec); }
.kb-two { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; align-items: start; }
@media (max-width: 800px) { .kb-two { grid-template-columns: 1fr; } }
.kb-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
.kb-confirm { border: 1px solid light-dark(#f59e0b,#b45309); border-radius: 8px; padding: 8px 10px; margin: 6px 0; background: light-dark(rgba(245,158,11,.08), rgba(180,83,9,.12)); }
.kb-bindrow { display: flex; align-items: center; gap: 8px; padding: 6px 0; border-bottom: 1px solid light-dark(rgba(0,0,0,.08), rgba(255,255,255,.1)); }
.kb-bindrow:last-child { border-bottom: none; }
.kb-live { display: inline-block; font-size: 10px; padding: 0 6px; border-radius: 999px; border: 1px solid light-dark(rgba(21,128,61,.5), rgba(74,222,128,.5)); color: light-dark(#15803d,#4ade80); margin-left: 6px; }
.kb-bound { display: inline-block; font-size: 10px; padding: 0 6px; border-radius: 999px; border: 1px solid light-dark(rgba(37,99,235,.5), rgba(147,197,253,.5)); color: light-dark(#1d4ed8,#93c5fd); margin-left: 6px; }
.kb-chip.handed { background: light-dark(#e0e7ff, #1e2a4a); color: light-dark(#4338ca, #a5b4fc); }
`)


    let currentSessionId = ''

    // v3：待绑定意图（新建对话 → 自动绑定）。模块变量 + localStorage 防刷新丢失；约 10 分钟过期。
    const PB_KEY = 'aikanban:pendingBind'
    let pendingBind = null
    function loadPendingBind() {
      try {
        const raw = window.localStorage.getItem(PB_KEY)
        if (!raw) return
        const o = JSON.parse(raw)
        if (o && typeof o.workItemId === 'string' && typeof o.clickedSessionId === 'string' && typeof o.deadline === 'number') {
          pendingBind = o
        }
      } catch (e) {}
    }
    function savePendingBind() {
      try {
        if (pendingBind) window.localStorage.setItem(PB_KEY, JSON.stringify(pendingBind))
        else window.localStorage.removeItem(PB_KEY)
      } catch (e) {}
    }
    loadPendingBind()
    // 记录意图并走 DSH 标准新会话流程（无参，继承当前工作区；成功后当前窗口自动跳到新会话）。
    function startNewConversation(workItemId) {
      if (!workspaces || typeof workspaces.startSession !== 'function') return false
      pendingBind = { workItemId, clickedSessionId: currentSessionId, deadline: Date.now() + 10 * 60 * 1000 }
      savePendingBind()
      try {
        workspaces.startSession()
        return true
      } catch (e) {
        pendingBind = null
        savePendingBind()
        return false
      }
    }

    async function rpc(method, args) {
      // 显式传 sessionId（重命名/解绑其他会话）时保留；否则默认当前会话
      const payload = Object.assign({}, args || {})
      if (!payload.sessionId) payload.sessionId = currentSessionId
      const res = await fetch('/aikanban-api', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method: method, args: payload }),
      })
      if (!res.ok) throw new Error('aikanban api HTTP ' + res.status)
      return res.json()
    }

    let state = null
    let busy = false
    let lastError = ''
    const listeners = new Set()
    const notify = () => { for (const l of listeners) l() }

    function useStore() {
      const [, setTick] = React.useState(0)
      React.useEffect(() => {
        const l = () => setTick((t) => t + 1)
        listeners.add(l)
        return () => { listeners.delete(l) }
      }, [])
      return { state, busy, lastError }
    }

    async function refresh() {
      try {
        const r = await call('getState')
        if (r && r.ok) { state = r.state; lastError = '' } else { lastError = (r && r.error) || '读取失败' }
      } catch (err) { lastError = '连接失败' }
      notify()
    }

    async function call(method, args) {
      busy = true
      notify()
      try {
        const r = await rpc(method, args || {})
        if (r && r.ok) {
          if (r.state !== undefined) state = r.state
          lastError = ''
          notify()
          return r
        }
        lastError = (r && r.error) || '操作失败'
        notify()
        return r
      } catch (err) {
        lastError = '连接失败'
        notify()
        return { ok: false, error: '连接失败' }
      } finally {
        busy = false
        notify()
      }
    }


    function Btn(props) {
      const p = Object.assign({}, props, { type: 'button', className: 'kb-btn' + (props.className ? ' ' + props.className : '') })
      delete p.children
      return h('button', p, props.children)
    }

    function Field(props) {
      return h('div', null,
        h('span', { className: 'kb-label' }, props.label),
        props.textarea
          ? h('textarea', { className: 'kb-textarea', rows: props.rows || 3, value: props.value || '', placeholder: props.placeholder || '', onChange: (e) => props.onChange(e.target.value) })
          : h('input', { className: 'kb-input', value: props.value || '', placeholder: props.placeholder || '', onChange: (e) => props.onChange(e.target.value) })
      )
    }

    function SectionEditor(props) {
      const keys = Object.keys(props.labels)
      return h('div', null, keys.map((k) => h('div', { key: k },
        h('span', { className: 'kb-label' }, props.labels[k]),
        h('textarea', {
          className: 'kb-textarea', rows: 3,
          value: props.sections[k] || '',
          onChange: (e) => { const next = Object.assign({}, props.sections); next[k] = e.target.value; props.onChange(next) },
        })
      )))
    }

    function MemoryView(props) {
      if (!props.memory) return h('div', { className: 'kb-muted' }, '暂无已确认版本')
      const keys = Object.keys(props.labels)
      return h('div', null, keys.map((k) => h('div', { key: k },
        h('span', { className: 'kb-label' }, props.labels[k]),
        h('div', { className: 'kb-pre' }, (props.memory.sections[k] || '').trim() || '（暂无）')
      )))
    }

    function DiffView(props) {
      const keys = Object.keys(props.labels)
      return h('div', null, keys.map((k) => {
        const b = (props.base && props.base[k]) || ''
        const c = (props.current && props.current[k]) || ''
        const changed = b !== c
        return h('div', { key: k, style: { marginBottom: 8 } },
          h('span', { className: 'kb-label' }, props.labels[k] + (changed ? '（有变化）' : '（无变化）')),
          h('div', { className: 'kb-diff' },
            h('div', { className: 'kb-diff-col' + (changed ? ' changed' : '') },
              h('div', { className: 'kb-muted' }, '基础版本'),
              h('div', { className: 'kb-pre' }, b || '（空）')),
            h('div', { className: 'kb-diff-col' + (changed ? ' changed' : '') },
              h('div', { className: 'kb-muted' }, '新内容'),
              h('div', { className: 'kb-pre' }, c || '（空）')))
        )
      }))
    }

    function MemoryEditForm(props) {
      const [phase, setPhase] = React.useState('edit')
      const [sections, setSections] = React.useState(() => {
        const s = {}
        for (const k of Object.keys(props.labels)) s[k] = props.base ? (props.base.sections[k] || '') : ''
        return s
      })
      if (phase === 'confirm') {
        return h('div', null,
          h('div', { className: 'kb-label' }, '确认差异（保存后将形成不可变新版本，来源：手动编辑）'),
          h(DiffView, { labels: props.labels, base: props.base ? props.base.sections : {}, current: sections }),
          h('div', { className: 'kb-row', style: { marginTop: 8 } },
            h(Btn, { className: 'primary', onClick: () => props.onSubmit(sections) }, '确认保存'),
            h(Btn, { onClick: () => setPhase('edit') }, '返回编辑'),
            h(Btn, { onClick: props.onCancel }, '取消')))
      }
      return h('div', null,
        h(SectionEditor, { labels: props.labels, sections: sections, onChange: setSections }),
        h('div', { className: 'kb-row', style: { marginTop: 8 } },
          h(Btn, { className: 'primary', onClick: () => setPhase('confirm') }, '预览差异'),
          h(Btn, { onClick: props.onCancel }, '取消')))
    }

    function HistoryList(props) {
      const [openIdx, setOpenIdx] = React.useState(-1)
      const list = props.versions || []
      if (!list.length) return h('div', { className: 'kb-muted' }, '暂无版本历史')
      return h('div', null, list.slice().reverse().map((v, i) => {
        const no = list.length - i
        const src = v.source && v.source.type === 'proposal'
          ? 'AI 建议（会话 ' + String((v.source.sessionId || 'unknown')).slice(0, 8) + '…）'
          : '手动编辑'
        return h('div', { key: v.id, style: { marginBottom: 6 } },
          h('div', { className: 'kb-conv', style: { cursor: 'pointer', marginBottom: 0 }, onClick: () => setOpenIdx(openIdx === i ? -1 : i) },
            h('span', { className: 'kb-muted' }, 'V' + no + ' · ' + (v.confirmedAt || '').slice(0, 16).replace('T', ' ') + ' · ' + src + (openIdx === i ? ' ▾' : ' ▸'))),
          openIdx === i ? h('div', { className: 'kb-panel', style: { marginTop: 6 } }, h(MemoryView, { labels: props.labels, memory: v })) : null)
      }))
    }

    function ProposalReview(props) {
      const snap = useStore()
      const st = snap.state
      const p = props.proposal
      const labels = p.kind === 'task' ? TASK_LABELS : PROJECT_LABELS
      const [sections, setSections] = React.useState(() => JSON.parse(JSON.stringify(p.sections || {})))
      const [sug, setSug] = React.useState(() => JSON.parse(JSON.stringify(p.fieldSuggestions || {})))
      const wi = p.kind === 'task' && st ? st.workItems.find((w) => w.id === p.workItemId) : null
      async function doConfirm() {
        const r1 = await call('editProposalDraft', { proposalId: p.id, sections: sections, fieldSuggestions: sug })
        if (r1 && r1.ok) await call('confirmProposal', { proposalId: p.id })
      }
      const fieldNodes = ['goal', 'status', 'progress', 'next', 'blockedReason'].map((k) => {
        if (k === 'status') {
          return h('div', { key: k },
            h('span', { className: 'kb-label' }, '状态建议（当前：' + (wi ? wi.status : '?') + '）'),
            h('select', { className: 'kb-select', value: sug[k] || '', onChange: (e) => setSug(Object.assign({}, sug, { status: e.target.value })) },
              h('option', { value: '' }, '（不变）'),
              STATUSES.map((s) => h('option', { value: s, key: s }, s))))
        }
        return h('div', { key: k },
          h(Field, {
            label: k === 'goal' ? '目标建议' : k === 'progress' ? '进度建议' : k === 'next' ? '下一步建议' : '阻塞原因建议',
            value: sug[k] || '',
            onChange: (v) => setSug(Object.assign({}, sug, { [k]: v })),
            textarea: k === 'goal',
          }))
      })
      const fieldPanel = p.kind === 'task' ? h('div', null,
        h('div', { className: 'kb-sec-head' }, '工作项字段建议（随建议一起确认后才生效）'),
        fieldNodes) : null
      return h('div', { className: 'kb-panel', style: { borderColor: 'light-dark(#f59e0b,#b45309)' } },
        h('div', { className: 'kb-row' },
          h('span', { style: { fontWeight: 600, color: 'light-dark(#1a1a1a,#ececec)' } }, p.kind === 'task' ? '任务记忆建议' : '项目记忆建议'),
          h('span', { className: 'kb-chip pending' }, '待审核'),
          wi ? h('span', { className: 'kb-muted' }, '工作项：' + wi.title) : null,
          h('span', { className: 'kb-muted' }, '基础：' + (p.baseVersionId ? String(p.baseVersionId).slice(0, 10) + '…' : '空白基础'))),
        h(DiffView, { labels: labels, base: p.baseSections || {}, current: sections }),
        h('div', { className: 'kb-label' }, '编辑建议内容（确认前可修改）'),
        h(SectionEditor, { labels: labels, sections: sections, onChange: setSections }),
        fieldPanel,
        h('div', { className: 'kb-row', style: { marginTop: 8 } },
          h(Btn, { className: 'primary', disabled: snap.busy, onClick: doConfirm }, '确认（形成新版本）'),
          h(Btn, { className: 'danger', onClick: () => call('abandonProposal', { proposalId: p.id }) }, '放弃建议')))
    }

    function HandoffPanel(props) {
      const [text, setText] = React.useState('')
      const [note, setNote] = React.useState('')
      let taEl = null
      async function generate() {
        const r = await call('handoffContext', { workItemId: props.workItemId, note: note })
        setText(r && r.ok ? r.text : ((r && r.error) || '生成失败'))
      }
      function selectOnly() {
        if (taEl) { try { taEl.focus(); taEl.select() } catch (e) {} }
      }
      function copy() {
        try {
          if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).catch(() => {})
          }
        } catch (e) {}
        selectOnly()
      }
      return h('div', null,
        h(Field, { label: '一次性补充说明（仅用于本次交接，不进入正式记忆）', value: note, onChange: setNote, textarea: true, rows: 2 }),
        h('div', { className: 'kb-row', style: { marginTop: 8 } }, h(Btn, { className: 'primary', onClick: generate }, '生成交接上下文')),
        text ? h('div', null,
          h('div', { className: 'kb-label' }, '交接上下文（粘贴到新 DSH 会话，或让新会话 agent 用 kanban_get_handoff_context 读取）'),
          h('textarea', { className: 'kb-textarea', rows: 14, value: text, readOnly: true, ref: (el) => { taEl = el }, onClick: selectOnly }),
          h('div', { className: 'kb-row', style: { marginTop: 8 } },
            h(Btn, { onClick: copy }, '复制'),
            h(Btn, { onClick: selectOnly }, '全选'),
            h('span', { className: 'kb-muted' }, '若复制按钮不可用：全选后 Ctrl+C')))
        : null)
    }

    // 上下文版本状态（v3.1 四态）：版本对比为内核（A），叠加绑定维度（B1）
    // 最新 = 记录等于当前最新确认版本 且 当前绑定该工作项
    // 已转交 = 记录版本还新，但对话已解绑/改绑走
    // 已过期 = 记录版本落后于当前最新确认版本
    // 未知 = 从未记录过该工作项的上下文版本
    function convCtxStatus(st, conv, workItemId) {
      const rec = conv && conv.contextVersions && conv.contextVersions[workItemId]
      if (!rec) return '未知'
      const pm = st.projectMemories.length ? st.projectMemories[st.projectMemories.length - 1] : null
      const tmList = st.taskMemories[workItemId] || []
      const tm = tmList.length ? tmList[tmList.length - 1] : null
      const fresh = (pm ? pm.id : null) === rec.projectMemory && (tm ? tm.id : null) === rec.taskMemory
      if (!fresh) return '已过期'
      if (conv.workItemId !== workItemId) return '已转交'
      return '最新'
    }
    function ctxClass(ctx) {
      if (ctx === '最新') return 'latest'
      if (ctx === '已过期') return 'expired'
      if (ctx === '已转交') return 'handed'
      return ''
    }

    function Board(props) {
      const snap = useStore()
      const st = snap.state
      const [creating, setCreating] = React.useState(false)
      const [form, setForm] = React.useState({ title: '', goal: '', progress: '', next: '' })
      const [dragOver, setDragOver] = React.useState('')
      const pending = st.proposals.filter((p) => p.status === 'pending').length
      const baseName = (st.workspace || '').split(/[\\\\\\/]/).filter(Boolean).pop() || st.workspace
      const head = h('div', { className: 'kb-head' },
        h('div', null,
          h('div', { className: 'kb-title' }, '📋 ' + baseName + ' · AIKanBan 看板'),
          h('div', { className: 'kb-sub' }, '任务分配给对话完成 · 项目记忆 V' + st.projectMemories.length + ' · ' + st.conversations.length + ' 段参与对话')),
        h('span', { className: 'kb-grow' }),
        pending > 0 ? h('span', { className: 'kb-badge warn', onClick: () => props.setNav({ kind: 'review' }) }, '待审核 ' + pending) : null,
        h(Btn, { className: 'ghost', onClick: () => props.setNav({ kind: 'memory' }) }, '项目记忆'),
        h(Btn, { className: 'ghost', onClick: () => props.setNav({ kind: 'handoff' }) }, '交接'),
        h(Btn, { className: 'primary', onClick: () => setCreating(!creating) }, creating ? '收起' : '＋ 新建工作项'))
      const createForm = creating ? h('div', { className: 'kb-panel' },
        h(Field, { label: '标题（必填）', value: form.title, onChange: (v) => setForm(Object.assign({}, form, { title: v })) }),
        h(Field, { label: '目标（必填）', value: form.goal, onChange: (v) => setForm(Object.assign({}, form, { goal: v })), textarea: true }),
        h(Field, { label: '当前进度（选填）', value: form.progress, onChange: (v) => setForm(Object.assign({}, form, { progress: v })) }),
        h(Field, { label: '下一步（选填）', value: form.next, onChange: (v) => setForm(Object.assign({}, form, { next: v })) }),
        h('div', { className: 'kb-row', style: { marginTop: 8 } },
          h(Btn, { className: 'primary', onClick: async () => { const r = await call('createWorkItem', form); if (r && r.ok) { setCreating(false); setForm({ title: '', goal: '', progress: '', next: '' }) } } }, '创建工作项'),
          h(Btn, { onClick: () => setCreating(false) }, '取消'))) : null
      const columns = STATUSES.map((s) => {
        const items = st.workItems.filter((w) => !w.archived && w.status === s)
        const cards = items.map((w) => {
          const convCount = st.conversations.filter((c) => c.workItemId === w.id).length
          const memCount = (st.taskMemories[w.id] || []).length
          const hasPending = st.proposals.some((p) => p.workItemId === w.id && p.status === 'pending')
          return h('div', {
            key: w.id,
            className: 'kb-card',
            draggable: true,
            onDragStart: (e) => { if (e.dataTransfer) { e.dataTransfer.setData('text/plain', w.id); e.dataTransfer.effectAllowed = 'move' } },
            onClick: () => props.setNav({ kind: 'item', id: w.id }),
          },
            h('div', { className: 'kb-card-title' }, w.title),
            h('div', { className: 'kb-card-goal' }, w.goal),
            h('div', { className: 'kb-card-foot' },
              h('span', { className: 'kb-chip' }, '💬 ' + convCount),
              h('span', { className: 'kb-chip' }, '记忆 V' + memCount),
              hasPending ? h('span', { className: 'kb-chip pending' }, '待审核') : null,
              h('span', { className: 'kb-muted' }, (w.updatedAt || '').slice(0, 10))),
            w.status === '已阻塞' ? h('div', { className: 'kb-blocked' }, '阻塞：' + (w.blockedReason || '（空）')) : null)
        })
        return h('div', {
          key: s,
          className: 'kb-col' + (dragOver === s ? ' dragover' : ''),
          onDragOver: (e) => { e.preventDefault() },
          onDragEnter: () => setDragOver(s),
          onDragLeave: () => setDragOver(''),
          onDrop: (e) => {
            e.preventDefault()
            setDragOver('')
            const id = e.dataTransfer && e.dataTransfer.getData('text/plain')
            if (id && id !== s) call('updateWorkItem', { id: id, patch: { status: s } })
          },
        },
          h('div', { className: 'kb-col-head' },
            h('span', { className: 'kb-dot', style: { background: s === '进行中' ? '#2563eb' : s === '已阻塞' ? 'light-dark(#b91c1c,#f87171)' : s === '已完成' ? 'light-dark(#15803d,#4ade80)' : 'light-dark(#999,#777)' } }),
            s,
            h('span', { className: 'kb-col-count' }, String(items.length))),
          cards)
      })
      const archived = st.workItems.filter((w) => w.archived)
      const archivedRow = archived.length ? h('div', null,
        h('div', { className: 'kb-sec-head' }, '已归档'),
        h('div', { className: 'kb-row' }, archived.map((w) => h(Btn, { key: w.id, className: 'ghost', onClick: () => props.setNav({ kind: 'item', id: w.id }) }, w.title)))) : null
      return h('div', { className: 'kb-root' }, head, createForm, h('div', { className: 'kb-board' }, columns), archivedRow)
    }

    function ItemDetail(props) {
      const snap = useStore()
      const st = snap.state
      const wi = st.workItems.find((w) => w.id === props.id)
      const [editing, setEditing] = React.useState(false)
      const [form, setForm] = React.useState(null)
      const [editMem, setEditMem] = React.useState(false)
      const [showHandoff, setShowHandoff] = React.useState(false)
      const [confirmDel, setConfirmDel] = React.useState(false)
      const [bindOpen, setBindOpen] = React.useState(false)
      const [bindSessions, setBindSessions] = React.useState(null)
      const [rebind, setRebind] = React.useState(null)
      const [renamingId, setRenamingId] = React.useState('')
      const [renameVal, setRenameVal] = React.useState('')
      const [showHistory, setShowHistory] = React.useState(false)
      if (!wi) {
        return h('div', { className: 'kb-root' },
          h('div', { className: 'kb-muted' }, '工作项不存在'),
          h(Btn, { onClick: () => props.setNav({ kind: 'board' }) }, '← 返回看板'))
      }
      const memList = st.taskMemories[wi.id] || []
      const latest = memList.length ? memList[memList.length - 1] : null
      const boundConvs = st.conversations.filter((c) => c.workItemId === wi.id)
      const historyConvs = st.conversations.filter((c) => c.workItemId !== wi.id && c.workItems.indexOf(wi.id) >= 0)
      const myProps = st.proposals.filter((p) => p.kind === 'task' && p.workItemId === wi.id)
      const pendingProps = myProps.filter((p) => p.status === 'pending')
      const otherProps = myProps.filter((p) => p.status !== 'pending')
      function startEdit() {
        setForm({ title: wi.title, goal: wi.goal, status: wi.status, progress: wi.progress, next: wi.next, blockedReason: wi.blockedReason })
        setEditing(true)
      }
      const headerRow = h('div', { className: 'kb-row' },
        h(Btn, { className: 'ghost', onClick: () => props.setNav({ kind: 'board' }) }, '← 看板'),
        h('span', { className: 'kb-item-title' }, wi.title),
        h('span', { className: 'kb-chip ' + (STATUS_CLASS[wi.status] || '') }, wi.status),
        h('span', { className: 'kb-grow' }),
        h(Btn, { onClick: () => call('updateWorkItem', { id: wi.id, patch: { archived: !wi.archived } }) }, wi.archived ? '恢复' : '归档'),
        wi.archived ? (confirmDel
          ? h(Btn, { className: 'danger', onClick: async () => { await call('deleteWorkItem', { id: wi.id }); setConfirmDel(false); props.setNav({ kind: 'board' }) } }, '确认永久删除？')
          : h(Btn, { className: 'danger', onClick: () => setConfirmDel(true) }, '永久删除'))
          : null)
      const fieldsPanel = h('div', { className: 'kb-panel' },
        h('h4', null, '工作项'),
        h('div', { className: 'kb-label' }, '目标'),
        h('div', { className: 'kb-pre' }, wi.goal || '（空）'),
        h('div', { className: 'kb-label' }, '当前进度'),
        h('div', { className: 'kb-pre' }, wi.progress || '（空）'),
        h('div', { className: 'kb-label' }, '下一步'),
        h('div', { className: 'kb-pre' }, wi.next || '（空）'),
        wi.status === '已阻塞' ? h('div', null, h('div', { className: 'kb-label' }, '阻塞原因'), h('div', { className: 'kb-pre' }, wi.blockedReason || '（空）')) : null,
        h('div', { className: 'kb-row', style: { marginTop: 8 } }, STATUSES.map((s) => h(Btn, { key: s, className: s === wi.status ? 'on' : '', onClick: () => call('updateWorkItem', { id: wi.id, patch: { status: s } }) }, s))),
        editing && form ? h('div', null,
          h(Field, { label: '标题', value: form.title, onChange: (v) => setForm(Object.assign({}, form, { title: v })) }),
          h(Field, { label: '目标', value: form.goal, onChange: (v) => setForm(Object.assign({}, form, { goal: v })), textarea: true }),
          h('div', null,
            h('span', { className: 'kb-label' }, '状态'),
            h('select', { className: 'kb-select', value: form.status, onChange: (e) => setForm(Object.assign({}, form, { status: e.target.value })) }, STATUSES.map((s) => h('option', { value: s, key: s }, s)))),
          h(Field, { label: '当前进度', value: form.progress, onChange: (v) => setForm(Object.assign({}, form, { progress: v })) }),
          h(Field, { label: '下一步', value: form.next, onChange: (v) => setForm(Object.assign({}, form, { next: v })) }),
          h(Field, { label: '阻塞原因（状态为已阻塞时必填）', value: form.blockedReason, onChange: (v) => setForm(Object.assign({}, form, { blockedReason: v })) }),
          h('div', { className: 'kb-row', style: { marginTop: 8 } },
            h(Btn, { className: 'primary', onClick: async () => { const r = await call('updateWorkItem', { id: wi.id, patch: form }); if (r && r.ok) setEditing(false) } }, '保存'),
            h(Btn, { onClick: () => setEditing(false) }, '取消')))
        : h('div', { className: 'kb-row', style: { marginTop: 8 } }, h(Btn, { onClick: startEdit }, '编辑字段')))
      const canStart = !!(workspaces && typeof workspaces.startSession === 'function')
      async function toggleBind() {
        const next = !bindOpen
        setBindOpen(next)
        if (next) {
          const r = await call('listSessions', {})
          setBindSessions(r && r.ok ? r.sessions : [])
        }
      }
      function doBind(sessionId, confirm) {
        call('bindConversation', { workItemId: wi.id, sessionId, confirm: !!confirm })
        setRebind(null)
        setBindOpen(false)
      }
      function doUnbind(sessionId) {
        call('unbindConversation', { workItemId: wi.id, sessionId })
      }
      function startRename(c) {
        setRenamingId(c.id)
        setRenameVal(c.title && c.title.indexOf('会话 ') !== 0 ? c.title : '')
      }
      function doRename(c) {
        const t = renameVal.trim()
        if (!t) return
        call('renameConversation', { sessionId: c.id, title: t }).then(() => refresh())
        setRenamingId('')
        setRenameVal('')
      }
      const bindCandidates = bindSessions || []
      const bindPanel = bindOpen ? h('div', null,
        bindCandidates.length === 0 ? h('div', { className: 'kb-muted' }, '当前工作区暂无其他会话') : null,
        bindCandidates.map((s) => {
          const isBoundHere = s.boundWorkItemId === wi.id
          const otherBound = s.boundWorkItemId && s.boundWorkItemId !== wi.id
          return h('div', { key: s.id, className: 'kb-bindrow' },
            h('span', { style: { fontWeight: 600, color: 'light-dark(#1a1a1a,#ececec)' } }, s.title),
            s.live ? h('span', { className: 'kb-live' }, '已打开') : null,
            otherBound ? h('span', { className: 'kb-muted' }, '已绑定：' + (s.boundWorkItemTitle || s.boundWorkItemId)) : null,
            h('span', { className: 'kb-grow' }),
            isBoundHere ? h('span', { className: 'kb-muted' }, '已绑定本工作项')
              : otherBound ? h(Btn, { onClick: () => setRebind({ sessionId: s.id, from: s.boundWorkItemId, fromTitle: s.boundWorkItemTitle }) }, '改绑到此')
              : h(Btn, { className: 'primary', onClick: () => doBind(s.id, false) }, '绑定'))
        })) : null
      const rebindBar = rebind ? h('div', { className: 'kb-confirm' },
        h('div', { className: 'kb-row' },
          h('span', { className: 'kb-muted' }, '从「' + (rebind.fromTitle || rebind.from) + '」改绑到「' + wi.title + '」？'),
          h(Btn, { className: 'primary', onClick: () => doBind(rebind.sessionId, true) }, '确认改绑'),
          h(Btn, { onClick: () => setRebind(null) }, '取消'))) : null
      const convsPanel = h('div', { className: 'kb-panel', style: { marginTop: 12 } },
        h('h4', null, '已绑定对话（' + boundConvs.length + '）'),
        h('div', { className: 'kb-bar' },
          h(Btn, { className: 'primary', disabled: !canStart, onClick: () => { startNewConversation(wi.id) } }, '＋ 新建对话'),
          h(Btn, { className: 'ghost', onClick: toggleBind }, bindOpen ? '收起绑定面板' : '绑定已有对话'),
          !canStart ? h('span', { className: 'kb-muted' }, 'workspaces 服务不可用，新建对话已禁用') : null),
        rebindBar,
        bindPanel,
        boundConvs.length === 0 ? h('div', { className: 'kb-muted' }, '还没有绑定的对话。点「＋ 新建对话」或「绑定已有对话」，或在聊天中让 agent 起草建议后本会话会自动绑定。') : null,
        boundConvs.slice().reverse().map((c) => {
          const ctx = convCtxStatus(st, c, wi.id)
          const live = !!c.live
          return h('div', { key: c.id, className: 'kb-conv', onClick: () => props.setNav({ kind: 'conv', id: c.id }) },
            h('div', { className: 'kb-conv-title' }, c.title || c.id, live ? h('span', { className: 'kb-live' }, '已打开') : null),
            h('div', { className: 'kb-row' },
              h('span', { className: 'kb-muted' }, (c.lastActiveAt || '').slice(0, 16).replace('T', ' ')),
              h('span', { className: 'kb-chip ' + ctxClass(ctx) }, '上下文 ' + ctx),
              renamingId === c.id ? h('input', { className: 'kb-input', style: { width: 180 }, value: renameVal, placeholder: '新标题', onClick: (e) => e.stopPropagation(), onChange: (e) => setRenameVal(e.target.value), onKeyDown: (e) => { if (e.key === 'Enter') doRename(c) } })
                : live ? h(Btn, { onClick: (e) => { e.stopPropagation(); startRename(c) } }, '重命名')
                : h('span', { className: 'kb-muted' }, '打开会话后可重命名'),
              renamingId === c.id ? h(Btn, { className: 'primary', onClick: (e) => { e.stopPropagation(); doRename(c) } }, '保存') : null,
              h(Btn, { className: 'danger', onClick: (e) => { e.stopPropagation(); doUnbind(c.id) } }, '解绑'),
              h('span', { className: 'kb-muted' }, '▸ 对话详情')))
        }),
        historyConvs.length ? h('div', { style: { marginTop: 10 } },
          h('div', { className: 'kb-row' },
            h('span', { className: 'kb-muted' }, '历史参与（已解绑/已改绑，共 ' + historyConvs.length + '）'),
            h(Btn, { className: 'ghost', onClick: () => setShowHistory(!showHistory) }, showHistory ? '收起' : '展开')),
          showHistory ? historyConvs.slice().reverse().map((c) => {
            const ctx = convCtxStatus(st, c, wi.id)
            return h('div', { key: c.id, className: 'kb-conv', style: { opacity: .72 }, onClick: () => props.setNav({ kind: 'conv', id: c.id }) },
              h('div', { className: 'kb-conv-title' }, c.title || c.id),
              h('div', { className: 'kb-row' },
                h('span', { className: 'kb-muted' }, (c.lastActiveAt || '').slice(0, 16).replace('T', ' ')),
                h('span', { className: 'kb-chip ' + ctxClass(ctx) }, '上下文 ' + ctx),
                h('span', { className: 'kb-muted' }, '▸ 对话详情')))
          }) : null)
        : null)
      const leftColumn = h('div', null, fieldsPanel, convsPanel)
      const memPanel = h('div', { className: 'kb-panel' },
        h('h4', null, '任务记忆（V' + memList.length + '）'),
        h(MemoryView, { labels: TASK_LABELS, memory: latest }),
        h('div', { className: 'kb-row', style: { marginTop: 8 } },
          h(Btn, { onClick: () => setEditMem(!editMem) }, editMem ? '收起手动编辑' : '手动编辑任务记忆'),
          h(Btn, { className: 'ghost', onClick: () => setShowHandoff(!showHandoff) }, showHandoff ? '收起交接' : '生成交接上下文'),
          h('span', { className: 'kb-muted' }, '让 agent 起草：在聊天中要求基于本会话起草任务记忆建议')),
        editMem ? h(MemoryEditForm, {
          labels: TASK_LABELS,
          base: latest,
          onCancel: () => setEditMem(false),
          onSubmit: async (sections) => { const r = await call('manualEditMemory', { kind: 'task', workItemId: wi.id, sections: sections }); if (r && r.ok) setEditMem(false) },
        }) : null,
        showHandoff ? h(HandoffPanel, { workItemId: wi.id }) : null,
        h(HistoryList, { labels: TASK_LABELS, versions: memList }))
      const rightChildren = [memPanel]
      if (pendingProps.length) {
        rightChildren.push(h('div', { className: 'kb-panel', style: { marginTop: 12 } },
          h('h4', null, '本工作项待审核建议'),
          pendingProps.map((p) => h(ProposalReview, { key: p.id, proposal: p }))))
      }
      if (otherProps.length) {
        rightChildren.push(h('div', { className: 'kb-panel', style: { marginTop: 12 } },
          h('h4', null, '本工作项其他建议'),
          otherProps.slice().reverse().map((p) => h('div', { key: p.id, className: 'kb-row' },
            h('span', { className: 'kb-chip ' + (p.status === 'expired' ? 'expired' : '') }, PROPOSAL_LABELS[p.status] || p.status),
            h('span', { className: 'kb-muted' }, (p.createdAt || '').slice(0, 16).replace('T', ' '))))))
      }
      const rightColumn = h('div', null, rightChildren)
      return h('div', { className: 'kb-root' }, headerRow, h('div', { className: 'kb-two' }, leftColumn, rightColumn))
    }

    function ConvDetail(props) {
      const snap = useStore()
      const st = snap.state
      const c = st.conversations.find((x) => x.id === props.id)
      if (!c) {
        return h('div', { className: 'kb-root' },
          h('div', { className: 'kb-muted' }, '对话不存在'),
          h(Btn, { onClick: () => props.setNav({ kind: 'board' }) }, '← 返回看板'))
      }
      const myProps = st.proposals.filter((p) => p.sessionId === c.id)
      const myVersions = []
      for (const wid of Object.keys(st.taskMemories)) {
        const list = st.taskMemories[wid] || []
        list.forEach((v, i) => { if (v.source && v.source.sessionId === c.id) myVersions.push({ v: v, kind: 'task', workItemId: wid, no: i + 1 }) })
      }
      st.projectMemories.forEach((v, i) => { if (v.source && v.source.sessionId === c.id) myVersions.push({ v: v, kind: 'project', no: i + 1 }) })
      const [renamingId, setRenamingId] = React.useState('')
      const [renameVal, setRenameVal] = React.useState('')
      const live = !!c.live
      function startRename() {
        setRenamingId('on')
        setRenameVal(c.title && c.title.indexOf('会话 ') !== 0 ? c.title : '')
      }
      function doRename() {
        const t = renameVal.trim()
        if (!t) return
        call('renameConversation', { sessionId: c.id, title: t }).then(() => refresh())
        setRenamingId('')
        setRenameVal('')
      }
      const headerRow = h('div', { className: 'kb-row' },
        h(Btn, { className: 'ghost', onClick: () => props.setNav({ kind: 'board' }) }, '← 看板'),
        h('span', { className: 'kb-item-title' }, c.title || c.id),
        live ? h('span', { className: 'kb-live' }, '已打开') : null,
        h('span', { className: 'kb-muted' }, c.id),
        h('span', { className: 'kb-grow' }),
        renamingId === 'on' ? h('input', { className: 'kb-input', style: { width: 180 }, value: renameVal, placeholder: '新标题', onChange: (e) => setRenameVal(e.target.value), onKeyDown: (e) => { if (e.key === 'Enter') doRename() } })
          : live ? h(Btn, { onClick: startRename }, '重命名')
          : h('span', { className: 'kb-muted' }, '打开会话后可重命名'),
        renamingId === 'on' ? h(Btn, { className: 'primary', onClick: doRename }, '保存') : null,
        c.workItemId ? h(Btn, { className: 'danger', onClick: () => call('unbindConversation', { workItemId: c.workItemId, sessionId: c.id }) }, '解绑') : null)
      const tasksPanel = h('div', { className: 'kb-panel' },
        h('h4', null, '参与的任务'),
        c.workItems.length === 0 ? h('div', { className: 'kb-muted' }, '只参与过项目级活动（项目记忆建议/编辑）') : null,
        c.workItems.map((wid) => {
          const wi = st.workItems.find((w) => w.id === wid)
          if (!wi) return null
          const ctx = convCtxStatus(st, c, wid)
          const isBound = c.workItemId === wid
          return h('div', { key: wid, className: 'kb-conv', onClick: () => props.setNav({ kind: 'item', id: wid }) },
            h('div', { className: 'kb-conv-title' }, wi.title, isBound ? h('span', { className: 'kb-bound' }, '当前绑定') : null),
            h('div', { className: 'kb-row' },
              h('span', { className: 'kb-chip ' + (STATUS_CLASS[wi.status] || '') }, wi.status),
              h('span', { className: 'kb-chip ' + ctxClass(ctx) }, '上下文 ' + ctx)))
        }))
      const proposalsPanel = h('div', { className: 'kb-panel' },
        h('h4', null, '产出的建议（' + myProps.length + '）'),
        myProps.length === 0 ? h('div', { className: 'kb-muted' }, '暂无') : null,
        myProps.slice().reverse().map((p) => h('div', { key: p.id, className: 'kb-row', style: { marginBottom: 4 } },
          h('span', { className: 'kb-chip ' + (p.status === 'pending' ? 'pending' : p.status === 'expired' ? 'expired' : '') }, (p.kind === 'task' ? '任务' : '项目') + '记忆建议'),
          h('span', { className: 'kb-muted' }, PROPOSAL_LABELS[p.status] || p.status),
          h('span', { className: 'kb-muted' }, (p.createdAt || '').slice(0, 16).replace('T', ' ')))))
      const versionsPanel = h('div', { className: 'kb-panel', style: { marginTop: 12 } },
        h('h4', null, '产出的记忆版本（' + myVersions.length + '）'),
        myVersions.length === 0 ? h('div', { className: 'kb-muted' }, '暂无已确认版本（建议仍需你在审核队列确认）') : null,
        myVersions.map((m) => h('div', { key: m.v.id, className: 'kb-row', style: { marginBottom: 4 } },
          h('span', { className: 'kb-chip' }, (m.kind === 'task' ? '任务记忆' : '项目记忆') + ' V' + m.no),
          h('span', { className: 'kb-muted' }, (m.v.confirmedAt || '').slice(0, 16).replace('T', ' ')))))
      const leftColumn = h('div', null, tasksPanel)
      const rightColumn = h('div', null, proposalsPanel, versionsPanel)
      return h('div', { className: 'kb-root' }, headerRow, h('div', { className: 'kb-two' }, leftColumn, rightColumn))
    }

    function ReviewQueue(props) {
      const snap = useStore()
      const st = snap.state
      const pending = st.proposals.filter((p) => p.status === 'pending')
      const others = st.proposals.filter((p) => p.status !== 'pending')
      const pendingNodes = pending.map((p) => h('div', { key: p.id, style: { marginBottom: 12 } }, h(ProposalReview, { proposal: p })))
      const otherNodes = others.map((p) => h('div', { key: p.id, className: 'kb-row', style: { marginBottom: 6 } },
        h('span', { className: 'kb-chip ' + (p.status === 'expired' ? 'expired' : '') }, (p.kind === 'task' ? '任务' : '项目') + '记忆建议'),
        h('span', { className: 'kb-muted' }, PROPOSAL_LABELS[p.status] || p.status),
        h('span', { className: 'kb-muted' }, (p.createdAt || '').slice(0, 16).replace('T', ' ')),
        p.status === 'expired' ? h(Btn, { className: 'danger', onClick: () => call('abandonProposal', { proposalId: p.id }) }, '放弃') : null))
      const headerRow = h('div', { className: 'kb-row' },
        h(Btn, { className: 'ghost', onClick: () => props.setNav({ kind: 'board' }) }, '← 看板'),
        h('span', { className: 'kb-item-title' }, '建议审核'))
      const empty = pending.length === 0 ? h('div', { className: 'kb-muted' }, '暂无待审核建议。在聊天中让 agent 起草记忆建议（kanban_start_memory_proposal + kanban_submit_memory_proposal），提交后会出现在这里。') : null
      const othersHead = others.length ? h('div', { className: 'kb-sec-head' }, '其他建议（已确认 / 已放弃 / 已过期 / 起草中）') : null
      return h('div', { className: 'kb-root' }, headerRow, empty, pendingNodes, othersHead, otherNodes)
    }

    function ProjectMemoryView(props) {
      const snap = useStore()
      const st = snap.state
      const [editing, setEditing] = React.useState(false)
      const list = st.projectMemories || []
      const latest = list.length ? list[list.length - 1] : null
      return h('div', { className: 'kb-root' },
        h('div', { className: 'kb-row' },
          h(Btn, { className: 'ghost', onClick: () => props.setNav({ kind: 'board' }) }, '← 看板'),
          h('span', { className: 'kb-item-title' }, '项目记忆（V' + list.length + '）')),
        h('div', { className: 'kb-panel' },
          h(MemoryView, { labels: PROJECT_LABELS, memory: latest }),
          h('div', { className: 'kb-row', style: { marginTop: 8 } },
            h(Btn, { onClick: () => setEditing(!editing) }, editing ? '收起手动编辑' : '手动编辑项目记忆'),
            h('span', { className: 'kb-muted' }, '让 agent 起草项目记忆建议：在聊天中要求基于最新确认记忆生成建议')),
          editing ? h(MemoryEditForm, {
            labels: PROJECT_LABELS,
            base: latest,
            onCancel: () => setEditing(false),
            onSubmit: async (sections) => { const r = await call('manualEditMemory', { kind: 'project', sections: sections }); if (r && r.ok) setEditing(false) },
          }) : null,
          h(HistoryList, { labels: PROJECT_LABELS, versions: list })))
    }

    function HandoffView(props) {
      const snap = useStore()
      const st = snap.state
      const [workItemId, setWorkItemId] = React.useState('')
      const items = st.workItems.filter((w) => !w.archived)
      return h('div', { className: 'kb-root' },
        h('div', { className: 'kb-row' },
          h(Btn, { className: 'ghost', onClick: () => props.setNav({ kind: 'board' }) }, '← 看板'),
          h('span', { className: 'kb-item-title' }, '生成交接上下文')),
        h('div', { className: 'kb-panel' },
          h('div', { className: 'kb-muted', style: { marginBottom: 8 } }, '按 PRD 规则组装：最新项目记忆 + 工作项信息 + 最新任务记忆 + 一次性说明。复制后带入新 DSH 会话继续工作。'),
          h('span', { className: 'kb-label' }, '工作项（可留空，只生成项目级上下文）'),
          h('select', { className: 'kb-select', value: workItemId, onChange: (e) => setWorkItemId(e.target.value) },
            h('option', { value: '' }, '（无）'),
            items.map((w) => h('option', { value: w.id, key: w.id }, w.title))),
          h(HandoffPanel, { workItemId: workItemId || undefined })))
    }

    function App(props) {
      const sid = props && props.sessionId ? props.sessionId : ''
      if (sid) currentSessionId = sid
      const snap = useStore()
      const [nav, setNav] = React.useState({ kind: 'board' })
      React.useEffect(() => {
        if (sid) currentSessionId = sid
        refresh()
        // v3：消费「待绑定意图」——新会话（sid ≠ 点击时会话）挂载时自动绑定该工作项。
        if (pendingBind && pendingBind.workItemId) {
          if (Date.now() < pendingBind.deadline) {
            if (sid && sid !== pendingBind.clickedSessionId) {
              const pb = pendingBind
              pendingBind = null
              savePendingBind()
              call('bindConversation', { workItemId: pb.workItemId, sessionId: sid }).then((r) => {
                if (r && r.ok) refresh()
              })
            }
          } else {
            pendingBind = null
            savePendingBind()
          }
        }
        if (!timer) return undefined
        return timer.interval(() => { refresh() }, 4000)
      }, [sid])
      if (!snap.state) return h('div', { className: 'kb-root' }, h('div', { className: 'kb-muted' }, '加载看板数据…'))
      const errorBar = snap.lastError ? h('div', { className: 'kb-root', style: { paddingBottom: 0 } }, h('div', { className: 'kb-error' }, snap.lastError)) : null
      const view = nav.kind === 'board' ? h(Board, { setNav: setNav })
        : nav.kind === 'item' ? h(ItemDetail, { id: nav.id, setNav: setNav })
        : nav.kind === 'conv' ? h(ConvDetail, { id: nav.id, setNav: setNav })
        : nav.kind === 'review' ? h(ReviewQueue, { setNav: setNav })
        : nav.kind === 'memory' ? h(ProjectMemoryView, { setNav: setNav })
        : h(HandoffView, { setNav: setNav })
      return h('div', null, errorBar, view)
    }

    slots.inject('conversation.view', () => slots.register(
      { name: 'conversation.view', id: 'aikanban-board', order: 20, label: '📋 看板' },
      (props) => h(App, props)
    ))
			}
		};
		exports.apply = plugin.apply;
		exports.inject = plugin.inject;
		return module.exports;
	}
});
