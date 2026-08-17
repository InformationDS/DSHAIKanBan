// AIKanBan for DSH — Host v2 源码（可重建）。
// 用法：将此文件内容（去掉首行 wrapper 与末尾 wrapper 关闭）作为 cordis_define 的 code.host。
// 校验：node --check .host-v2.js
async function __b() {
return {
  inject: ['fs'],
  apply(ctx) {
    const agents = ctx.get('agents')
    const sp = ctx.get('sandboxPolicy')
    const sessions = ctx.get('sessions')

    const TASK_SECTIONS = ['goal_scope', 'decisions', 'progress_done', 'artifacts', 'open_issues', 'next_steps']
    const PROJECT_SECTIONS = ['purpose_scope', 'conventions', 'project_decisions', 'cross_workitem', 'open_issues']
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
    const ACTIVE = ['drafting', 'pending']

    const nowIso = () => new Date().toISOString()
    const makeId = (prefix) => prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
    const strOr = (v) => (typeof v === 'string' ? v : '')
    const deep = (v) => JSON.parse(JSON.stringify(v))

    // 递归把 undefined 归一为 null，保证返回值是纯 JSON
    function cleanJson(v) {
      if (v === undefined) return null
      if (Array.isArray(v)) return v.map(cleanJson)
      if (v && typeof v === 'object') {
        const out = {}
        for (const k of Object.keys(v)) out[k] = cleanJson(v[k])
        return out
      }
      return v
    }

    let ownSessionId = ''
    try {
      const a = agents && agents.currentInitiator()
      if (a && typeof a.id === 'string') ownSessionId = a.id
      else if (a && typeof a.sessionId === 'string') ownSessionId = a.sessionId
    } catch (err) {}

    function currentSessionId(exec) {
      try {
        if (exec && exec.agent && typeof exec.agent.id === 'string') {
          ownSessionId = exec.agent.id
          return exec.agent.id
        }
        if (ownSessionId) return ownSessionId
        const a = agents && agents.currentInitiator()
        if (a && typeof a.id === 'string') {
          ownSessionId = a.id
          return a.id
        }
      } catch (err) {}
      return 'unknown'
    }

    function liveSessionCwd() {
      try {
        if (!sessions) return ''
        const list = sessions.list()
        const cwds = []
        for (const s of list) {
          const h = s && s.header
          if (h && typeof h.cwd === 'string' && h.cwd && cwds.indexOf(h.cwd) === -1) cwds.push(h.cwd)
        }
        return cwds.length === 1 ? cwds[0] : ''
      } catch (err) { return '' }
    }

    function policyFor(exec) {
      if (!sp) return undefined
      try {
        if (exec && exec.agent && exec.agent.session) return sp.resolve({ session: exec.agent.session })
        if (ownSessionId && sessions) {
          const s = sessions.get(ownSessionId)
          if (s) return sp.resolve({ session: s })
        }
        if (sessions) {
          const list = sessions.list()
          if (list && list.length === 1) return sp.resolve({ session: list[0] })
        }
        return sp.resolve()
      } catch (err) { return undefined }
    }

    let workspacePath = ''
    let resolvedPolicy = undefined
    function emptyState() {
      return {
        schemaVersion: 1,
        workspace: workspacePath,
        workItems: [],
        taskMemories: {},
        projectMemories: [],
        proposals: [],
        conversations: [],
      }
    }

    let state = emptyState()
    let target = null
    let queue = Promise.resolve()
    let storageDiag = ''
    let lastPersistError = ''

    const ready = (async () => {
      const live = liveSessionCwd()
      if (live) { workspacePath = live; storageDiag = 'live-session-cwd' }
      if (!workspacePath) {
        try {
          const persist = ctx.get('sessionPersistence')
          if (persist && ownSessionId) {
            const headers = await persist.list()
            const hit = (headers || []).find((h) => h && h.id === ownSessionId)
            if (hit && typeof hit.cwd === 'string' && hit.cwd) {
              workspacePath = hit.cwd
              storageDiag = 'header:' + ownSessionId.slice(0, 8)
            }
          }
        } catch (err) { storageDiag = 'header-error:' + String((err && err.message) || err) }
      }
      if (!workspacePath) {
        try {
          const reg = ctx.get('workspaceRegistry')
          const list = reg ? reg.list() : []
          const paths = []
          for (const w of list) if (w && typeof w.path === 'string' && w.path && paths.indexOf(w.path) === -1) paths.push(w.path)
          if (paths.length === 1) { workspacePath = paths[0]; storageDiag = 'workspaceRegistry-single' }
        } catch (err) {}
      }
      if (!workspacePath) {
        try {
          resolvedPolicy = policyFor(undefined)
          if (resolvedPolicy && typeof resolvedPolicy.workspaceRoot === 'string' && resolvedPolicy.workspaceRoot) {
            workspacePath = resolvedPolicy.workspaceRoot
            storageDiag = 'policy-root'
          }
        } catch (err) { storageDiag = 'policy-error:' + String((err && err.message) || err) }
      }
      try {
        if (workspacePath) target = await ctx.fs.resolve('.dsh-kanban.json', { cwd: workspacePath })
        else target = await ctx.fs.resolve('.dsh-kanban.json')
        if (!workspacePath) {
          const full = ctx.fs.processPath(target)
          const i = Math.max(full.lastIndexOf('/'), full.lastIndexOf('\\'))
          workspacePath = i > 0 ? full.slice(0, i) : full
          storageDiag = 'file-dirname'
        }
        storageDiag = storageDiag + ' target:' + ctx.fs.processPath(target)
        if (workspacePath) state.workspace = workspacePath
        const info = await ctx.fs.stat(target)
        if (info) {
          const parsed = JSON.parse(await ctx.fs.readText(target))
          if (parsed && parsed.schemaVersion === 1 && Array.isArray(parsed.workItems)) {
            state = parsed
            if (!state.taskMemories || typeof state.taskMemories !== 'object' || Array.isArray(state.taskMemories)) state.taskMemories = {}
            if (!Array.isArray(state.projectMemories)) state.projectMemories = []
            if (!Array.isArray(state.proposals)) state.proposals = []
            if (!Array.isArray(state.conversations)) state.conversations = []
            state.workspace = workspacePath || state.workspace || ''
            for (const wi of state.workItems) {
              if (!Array.isArray(state.taskMemories[wi.id])) state.taskMemories[wi.id] = []
            }
            for (const c of state.conversations) {
              if (!Array.isArray(c.workItems)) c.workItems = []
              if (!c.contextVersions || typeof c.contextVersions !== 'object' || Array.isArray(c.contextVersions)) c.contextVersions = {}
            }
          }
        }
      } catch (err) {
        storageDiag = storageDiag + ' load-error:' + String((err && err.message) || err)
        console.error('aikanban load failed:', err)
      }
    })()

    async function refine(exec) {
      const p = policyFor(exec)
      if (p) resolvedPolicy = p
      const live = liveSessionCwd()
      const cwd = live || (p && typeof p.workspaceRoot === 'string' && p.workspaceRoot ? p.workspaceRoot : '')
      if (cwd && cwd !== workspacePath) {
        workspacePath = cwd
        state.workspace = cwd
        try {
          const next = await ctx.fs.resolve('.dsh-kanban.json', { cwd: cwd })
          target = next
          storageDiag = 'refined target:' + ctx.fs.processPath(target)
          const info = await ctx.fs.stat(target)
          if (info) {
            const parsed = JSON.parse(await ctx.fs.readText(target))
            if (parsed && parsed.schemaVersion === 1 && Array.isArray(parsed.workItems)) {
              state = parsed
              if (!state.taskMemories || typeof state.taskMemories !== 'object' || Array.isArray(state.taskMemories)) state.taskMemories = {}
              if (!Array.isArray(state.projectMemories)) state.projectMemories = []
              if (!Array.isArray(state.proposals)) state.proposals = []
              if (!Array.isArray(state.conversations)) state.conversations = []
              state.workspace = workspacePath || state.workspace || ''
              for (const wi of state.workItems) {
                if (!Array.isArray(state.taskMemories[wi.id])) state.taskMemories[wi.id] = []
              }
            }
          }
        } catch (err) {
          lastPersistError = 'refine-error:' + String((err && err.message) || err)
        }
      }
    }

    function commit() {
      const snap = JSON.stringify(state, null, 2)
      const policy = resolvedPolicy
      queue = queue.then(async () => {
        if (!target) { lastPersistError = 'no storage target'; return }
        try {
          await ctx.fs.writeText(target, snap, undefined, undefined, policy)
          lastPersistError = ''
        } catch (err) {
          lastPersistError = 'persist:' + String((err && err.message) || err)
          console.error('aikanban persist failed:', err)
        }
      })
    }

    function findWorkItem(id) {
      return state.workItems.find((w) => w.id === id)
    }
    function findProposal(id) {
      return state.proposals.find((p) => p.id === id)
    }
    function latestMemory(kind, workItemId) {
      if (kind === 'project') return state.projectMemories.length ? state.projectMemories[state.projectMemories.length - 1] : undefined
      const list = state.taskMemories[workItemId]
      return list && list.length ? list[list.length - 1] : undefined
    }
    function sectionsEqual(a, b) {
      const ka = Object.keys(a || {})
      const kb = Object.keys(b || {})
      if (ka.length !== kb.length) return false
      for (const k of ka) if ((a[k] || '') !== (b[k] || '')) return false
      return true
    }
    function sanitizeSections(kind, sections) {
      if (!sections || typeof sections !== 'object' || Array.isArray(sections)) return null
      const keys = kind === 'task' ? TASK_SECTIONS : PROJECT_SECTIONS
      const out = {}
      for (const k of keys) out[k] = strOr(sections[k]).replace(/[ \t]+$/gm, '')
      return out
    }
    function sanitizeFields(sug) {
      const out = {}
      if (!sug || typeof sug !== 'object' || Array.isArray(sug)) return out
      for (const k of ['goal', 'status', 'progress', 'next', 'blockedReason']) {
        if (typeof sug[k] === 'string') out[k] = sug[k]
      }
      if (out.status && STATUSES.indexOf(out.status) === -1) delete out.status
      return out
    }
    function validateItem(item) {
      if (item.status === '已阻塞' && !(item.blockedReason || '').trim()) return '状态为「已阻塞」时阻塞原因必填'
      return null
    }

    // 对话一等对象：把当前会话登记为参与某工作项（或项目级活动）的对话
    function recordConversation(exec, workItemId) {
      const sid = currentSessionId(exec)
      if (!sid || sid === 'unknown') return undefined
      let conv = state.conversations.find((c) => c.id === sid)
      if (!conv) {
        conv = { id: sid, title: '会话 ' + sid.slice(0, 8), workItems: [], contextVersions: {}, createdAt: nowIso(), lastActiveAt: nowIso() }
        state.conversations.push(conv)
      }
      if (workItemId && conv.workItems.indexOf(workItemId) === -1) conv.workItems.push(workItemId)
      if (workItemId) {
        const pm = latestMemory('project', undefined)
        const tm = latestMemory('task', workItemId)
        conv.contextVersions[workItemId] = { projectMemory: pm ? pm.id : null, taskMemory: tm ? tm.id : null }
      }
      conv.lastActiveAt = nowIso()
      return conv
    }

    async function opCreateWorkItem(args, exec) {
      await ready
      await refine(exec)
      const title = strOr(args && args.title).trim()
      const goal = strOr(args && args.goal).trim()
      if (!title || !goal) return { ok: false, error: '标题与目标必填' }
      const item = {
        id: makeId('wi'), title, goal,
        status: args && STATUSES.indexOf(args.status) >= 0 ? args.status : '未开始',
        progress: strOr(args && args.progress),
        next: strOr(args && args.next),
        blockedReason: strOr(args && args.blockedReason),
        archived: false,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      }
      const err = validateItem(item)
      if (err) return { ok: false, error: err }
      state.workItems.push(item)
      state.taskMemories[item.id] = []
      commit()
      return { ok: true, state, id: item.id }
    }

    async function opUpdateWorkItem(args, exec) {
      await ready
      await refine(exec)
      const item = findWorkItem(args && args.id)
      if (!item) return { ok: false, error: '工作项不存在' }
      const patch = (args && args.patch) || {}
      for (const k of ['title', 'goal', 'status', 'progress', 'next', 'blockedReason']) {
        if (typeof patch[k] === 'string') item[k] = patch[k]
      }
      if (typeof patch.archived === 'boolean') item.archived = patch.archived
      if (!item.title || !item.title.trim()) return { ok: false, error: '标题不能为空' }
      if (!item.goal || !item.goal.trim()) return { ok: false, error: '目标不能为空' }
      if (STATUSES.indexOf(item.status) === -1) return { ok: false, error: '非法状态' }
      const err = validateItem(item)
      if (err) return { ok: false, error: err }
      item.updatedAt = nowIso()
      commit()
      return { ok: true, state }
    }

    async function opDeleteWorkItem(args, exec) {
      await ready
      await refine(exec)
      const item = findWorkItem(args && args.id)
      if (!item) return { ok: false, error: '工作项不存在' }
      if (!item.archived) return { ok: false, error: '只能永久删除已归档的工作项' }
      state.workItems = state.workItems.filter((w) => w.id !== item.id)
      delete state.taskMemories[item.id]
      state.proposals = state.proposals.filter((p) => !(p.kind === 'task' && p.workItemId === item.id))
      for (const c of state.conversations) {
        c.workItems = c.workItems.filter((wid) => wid !== item.id)
        delete c.contextVersions[item.id]
      }
      commit()
      return { ok: true, state }
    }

    async function opStartProposal(args, exec) {
      await ready
      await refine(exec)
      const kind = args && args.kind === 'project' ? 'project' : 'task'
      const workItemId = kind === 'task' ? strOr(args && args.workItemId) : undefined
      if (kind === 'task' && !findWorkItem(workItemId)) return { ok: false, error: '工作项不存在' }
      const existing = state.proposals.find((p) => p.kind === kind && (kind === 'project' || p.workItemId === workItemId) && ACTIVE.indexOf(p.status) >= 0)
      if (existing) {
        return {
          ok: true, state, proposalId: existing.id, baseVersionId: existing.baseVersionId,
          baseSections: existing.baseSections, baseWorkItem: kind === 'task' ? existing.baseWorkItem : null, reused: true,
          proposalStatus: existing.status,
          note: existing.status === 'pending' ? '该范围内已有待审核建议，直接复用；它已提交待审核，无需重复提交。' : '该范围内已有起草中的建议，直接复用它继续起草。',
        }
      }
      const base = latestMemory(kind, workItemId)
      const keys = kind === 'task' ? TASK_SECTIONS : PROJECT_SECTIONS
      const baseSections = {}
      for (const k of keys) baseSections[k] = base ? (base.sections[k] || '') : ''
      const proposal = {
        id: makeId('prop'), kind, workItemId: kind === 'task' ? workItemId : null,
        status: 'drafting',
        baseVersionId: base ? base.id : null,
        baseSections,
        sections: deep(baseSections),
        aiDraft: null,
        fieldSuggestions: {},
        note: strOr(args && args.note),
        sessionId: currentSessionId(exec),
        createdAt: nowIso(),
        updatedAt: nowIso(),
      }
      if (kind === 'task') {
        const wi = findWorkItem(workItemId)
        proposal.baseWorkItem = { title: wi.title, goal: wi.goal, status: wi.status, progress: wi.progress, next: wi.next, blockedReason: wi.blockedReason }
      }
      state.proposals.push(proposal)
      recordConversation(exec, workItemId)
      commit()
      return { ok: true, state, proposalId: proposal.id, baseVersionId: proposal.baseVersionId, baseSections, baseWorkItem: kind === 'task' ? proposal.baseWorkItem : null, reused: false, proposalStatus: 'drafting' }
    }

    async function opSubmitProposal(args, exec) {
      await ready
      await refine(exec)
      const p = findProposal(args && args.proposalId)
      if (!p) return { ok: false, error: '建议不存在' }
      if (p.status === 'pending') return { ok: false, error: '该建议已提交待审核，无需重复提交；如需修改请在审核面板编辑' }
      if (p.status !== 'drafting') return { ok: false, error: '建议不在起草中状态，无法提交' }
      const sections = sanitizeSections(p.kind, args && args.sections)
      if (!sections) return { ok: false, error: '分区内容格式错误' }
      let has = false
      for (const k of Object.keys(sections)) if (sections[k].trim()) { has = true; break }
      if (!has) return { ok: false, error: '建议内容不能全部为空' }
      p.sections = sections
      p.aiDraft = deep(sections)
      p.fieldSuggestions = p.kind === 'task' ? sanitizeFields(args && args.fieldSuggestions) : {}
      p.status = 'pending'
      p.updatedAt = nowIso()
      recordConversation(exec, p.workItemId)
      commit()
      return { ok: true, state, proposalId: p.id }
    }

    async function opEditProposalDraft(args, exec) {
      await ready
      await refine(exec)
      const p = findProposal(args && args.proposalId)
      if (!p) return { ok: false, error: '建议不存在' }
      if (p.status !== 'pending') return { ok: false, error: '只有待审核建议可以编辑' }
      const sections = sanitizeSections(p.kind, args && args.sections)
      if (!sections) return { ok: false, error: '分区内容格式错误' }
      p.sections = sections
      p.fieldSuggestions = p.kind === 'task' ? sanitizeFields(args && args.fieldSuggestions) : {}
      p.updatedAt = nowIso()
      commit()
      return { ok: true, state }
    }

    async function opConfirmProposal(args, exec) {
      await ready
      await refine(exec)
      const p = findProposal(args && args.proposalId)
      if (!p) return { ok: false, error: '建议不存在' }
      if (p.status !== 'pending') return { ok: false, error: '该建议当前不可确认' }
      const base = latestMemory(p.kind, p.workItemId)
      const baseId = base ? base.id : null
      if (baseId !== p.baseVersionId) {
        p.status = 'expired'
        p.updatedAt = nowIso()
        commit()
        return { ok: false, error: '基础版本已变化，建议已过期。请放弃后基于最新版本重新生成。' }
      }
      const version = {
        id: makeId('ver'),
        kind: p.kind,
        workItemId: p.kind === 'task' ? p.workItemId : null,
        sections: deep(p.sections),
        prevVersionId: base ? base.id : undefined,
        baseVersionId: p.baseVersionId,
        source: { type: 'proposal', proposalId: p.id, sessionId: p.sessionId },
        aiOriginal: p.aiDraft ? deep(p.aiDraft) : undefined,
        userEdited: p.aiDraft && !sectionsEqual(p.aiDraft, p.sections) ? deep(p.sections) : undefined,
        fieldChanges: Object.keys(p.fieldSuggestions || {}).length ? deep(p.fieldSuggestions) : undefined,
        confirmedAt: nowIso(),
        createdAt: nowIso(),
      }
      if (p.kind === 'task') {
        if (!Array.isArray(state.taskMemories[p.workItemId])) state.taskMemories[p.workItemId] = []
        state.taskMemories[p.workItemId].push(version)
      } else {
        state.projectMemories.push(version)
      }
      p.status = 'confirmed'
      p.confirmedVersionId = version.id
      p.updatedAt = nowIso()
      for (const other of state.proposals) {
        if (other.id !== p.id && other.kind === p.kind && (p.kind === 'project' || other.workItemId === p.workItemId) && ACTIVE.indexOf(other.status) >= 0) {
          other.status = 'expired'
          other.updatedAt = nowIso()
        }
      }
      const fs = p.fieldSuggestions || {}
      if (p.kind === 'task' && Object.keys(fs).length) {
        const wi = findWorkItem(p.workItemId)
        if (wi) {
          let changed = false
          for (const k of ['goal', 'status', 'progress', 'next', 'blockedReason']) {
            if (typeof fs[k] === 'string' && fs[k] !== (wi[k] || '')) { wi[k] = fs[k]; changed = true }
          }
          if (changed) wi.updatedAt = nowIso()
        }
      }
      recordConversation(exec, p.workItemId)
      commit()
      return { ok: true, state, versionId: version.id }
    }

    async function opAbandonProposal(args, exec) {
      await ready
      await refine(exec)
      const p = findProposal(args && args.proposalId)
      if (!p) return { ok: false, error: '建议不存在' }
      if (ACTIVE.indexOf(p.status) < 0 && p.status !== 'expired') return { ok: false, error: '该建议状态不可放弃' }
      p.status = 'abandoned'
      p.updatedAt = nowIso()
      commit()
      return { ok: true, state }
    }

    async function opManualEditMemory(args, exec) {
      await ready
      await refine(exec)
      const kind = args && args.kind === 'project' ? 'project' : 'task'
      const workItemId = kind === 'task' ? strOr(args && args.workItemId) : undefined
      if (kind === 'task' && !findWorkItem(workItemId)) return { ok: false, error: '工作项不存在' }
      const sections = sanitizeSections(kind, args && args.sections)
      if (!sections) return { ok: false, error: '分区内容格式错误' }
      const base = latestMemory(kind, workItemId)
      if (base && sectionsEqual(base.sections, sections)) return { ok: false, error: '内容无变化，未产生新版本' }
      const version = {
        id: makeId('ver'), kind, workItemId: kind === 'task' ? workItemId : null,
        sections,
        prevVersionId: base ? base.id : undefined,
        baseVersionId: base ? base.id : null,
        source: { type: 'manual', sessionId: currentSessionId(exec) },
        confirmedAt: nowIso(),
        createdAt: nowIso(),
      }
      if (kind === 'task') {
        if (!Array.isArray(state.taskMemories[workItemId])) state.taskMemories[workItemId] = []
        state.taskMemories[workItemId].push(version)
      } else {
        state.projectMemories.push(version)
      }
      for (const other of state.proposals) {
        if (other.kind === kind && (kind === 'project' || other.workItemId === workItemId) && ACTIVE.indexOf(other.status) >= 0) {
          other.status = 'expired'
          other.updatedAt = nowIso()
        }
      }
      recordConversation(exec, workItemId)
      commit()
      return { ok: true, state, versionId: version.id }
    }

    function memoryToMarkdown(kind, memory, versionNo) {
      const labels = kind === 'task' ? TASK_LABELS : PROJECT_LABELS
      const keys = kind === 'task' ? TASK_SECTIONS : PROJECT_SECTIONS
      const head = kind === 'task' ? '任务记忆' : '项目记忆'
      if (!memory) return '## ' + head + '（暂无已确认版本）\n（空）'
      const lines = ['## ' + head + '（V' + versionNo + '，确认于 ' + (memory.confirmedAt || '') + '）']
      for (const k of keys) {
        const text = (memory.sections[k] || '').trim()
        lines.push('### ' + labels[k] + (text ? '' : '（暂无）'))
        lines.push(text || '（暂无）')
      }
      return lines.join('\n')
    }

    async function opHandoffContext(args, exec) {
      await ready
      await refine(exec)
      const workItemId = strOr(args && args.workItemId)
      const wi = workItemId ? findWorkItem(workItemId) : undefined
      if (workItemId && !wi) return { ok: false, error: '工作项不存在' }
      const note = strOr(args && args.note)
      if (exec) recordConversation(exec, workItemId || undefined)
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
      lines.push(note.trim() || '（无）')
      return { ok: true, text: lines.join('\n') }
    }

    function rpc(method, fn) {
      harness.handle(method, async (args) => {
        try {
          return cleanJson(await fn(args, undefined))
        } catch (err) {
          console.error('aikanban rpc', method, err)
          return { ok: false, error: String((err && err.message) || err) }
        }
      })
    }

    rpc('getState', async () => { await ready; await refine(undefined); return { ok: true, state, diag: { storage: storageDiag, persistError: lastPersistError } } })
    rpc('createWorkItem', opCreateWorkItem)
    rpc('updateWorkItem', opUpdateWorkItem)
    rpc('deleteWorkItem', opDeleteWorkItem)
    rpc('startProposal', opStartProposal)
    rpc('submitProposal', opSubmitProposal)
    rpc('editProposalDraft', opEditProposalDraft)
    rpc('confirmProposal', opConfirmProposal)
    rpc('abandonProposal', opAbandonProposal)
    rpc('manualEditMemory', opManualEditMemory)
    rpc('handoffContext', opHandoffContext)

    function compact(r) {
      if (!r || typeof r !== 'object') return r
      const out = {}
      for (const k of Object.keys(r)) if (k !== 'state') out[k] = r[k]
      return out
    }

    function tool(name, description, schema, fn) {
      const def = harness.defineTool({
        name,
        description,
        parameters: {
          type: 'object',
          properties: schema.properties || {},
          required: schema.required || [],
        },
        output: {
          schema: { type: 'json' },
          render: (args, value) => {
            const text = value && typeof value === 'object' && typeof value.text === 'string'
              ? value.text
              : JSON.stringify(value, null, 2)
            return [{ type: 'text', text: String(text) }]
          },
        },
        execute: async (args, exec) => {
          try {
            return compact(cleanJson(await fn(args, exec)))
          } catch (err) {
            return { error: String((err && err.message) || err) }
          }
        },
      })
      harness.registerTool(ctx, def)
    }

    tool('kanban_view', '查看 AIKanBan 看板当前状态：工作项列表、任务/项目记忆版本数、参与对话、活动建议与待审核建议。', { properties: {} }, async (args, exec) => {
      await ready
      await refine(exec)
      const taskCounts = {}
      for (const k of Object.keys(state.taskMemories)) taskCounts[k] = (state.taskMemories[k] || []).length
      return {
        workspace: state.workspace,
        storage: storageDiag,
        persistError: lastPersistError,
        projectMemoryVersion: state.projectMemories.length,
        workItems: state.workItems.map((w) => ({ id: w.id, title: w.title, status: w.status, archived: w.archived, updatedAt: w.updatedAt })),
        taskMemoryVersions: taskCounts,
        conversations: state.conversations.map((c) => ({ id: c.id, workItems: c.workItems, lastActiveAt: c.lastActiveAt })),
        activeProposals: state.proposals.filter((p) => p.status === 'drafting' || p.status === 'pending').map((p) => ({ id: p.id, kind: p.kind, workItemId: p.workItemId === undefined ? null : p.workItemId, status: p.status })),
        pendingProposals: state.proposals.filter((p) => p.status === 'pending').length,
      }
    })

    tool('kanban_create_work_item', '在看板创建一个工作项。标题与目标必填；状态固定五种（未开始/进行中/已阻塞/已完成/已取消），默认未开始；状态为「已阻塞」时 blockedReason 必填。', {
      properties: {
        title: { type: 'string', description: '工作项标题（必填）' },
        goal: { type: 'string', description: '工作项目标（必填）' },
        status: { type: 'string', description: '状态：未开始/进行中/已阻塞/已完成/已取消，默认未开始' },
        progress: { type: 'string', description: '当前进度（选填）' },
        next: { type: 'string', description: '下一步（选填）' },
        blockedReason: { type: 'string', description: '阻塞原因（状态为已阻塞时必填）' },
      },
      required: ['title', 'goal'],
    }, opCreateWorkItem)

    tool('kanban_update_work_item', '更新工作项字段、状态或归档标记。状态由用户最终决定：只有在用户明确要求时才修改；也可以在记忆建议的 fieldSuggestions 中提出状态变化，随建议由用户确认。', {
      properties: {
        id: { type: 'string', description: '工作项 id（必填）' },
        patch: {
          type: 'object',
          description: '要修改的字段：title/goal/status/progress/next/blockedReason/archived',
          properties: {
            title: { type: 'string' },
            goal: { type: 'string' },
            status: { type: 'string' },
            progress: { type: 'string' },
            next: { type: 'string' },
            blockedReason: { type: 'string' },
            archived: { type: 'boolean' },
          },
        },
      },
      required: ['id', 'patch'],
    }, opUpdateWorkItem)

    tool('kanban_start_memory_proposal', '开始起草一条记忆更新建议（kind=task 任务记忆 或 kind=project 项目记忆）。返回当前基础版本内容（baseSections）供起草参考，起草应保留仍有效的内容，只增删改确有变化的部分。同一范围内同时只有一条活动建议；重复调用会复用已有建议。当前会话会被登记为该任务/项目的参与对话。', {
      properties: {
        kind: { type: 'string', description: "'task' 或 'project'（必填）" },
        workItemId: { type: 'string', description: 'kind=task 时必填；工作项 id' },
        note: { type: 'string', description: '本次建议的说明（选填）' },
      },
      required: ['kind'],
    }, opStartProposal)

    tool('kanban_submit_memory_proposal', '提交起草好的记忆建议，使其进入待审核。建议必须经用户在看板查看差异并确认后才会成为正式记忆；未确认内容不是正式记忆。sections 的键必须与 start 返回的 baseSections 的键完全一致（任务记忆 6 个分区 / 项目记忆 5 个分区）。', {
      properties: {
        proposalId: { type: 'string', description: '由 kanban_start_memory_proposal 返回的建议 id（必填）' },
        sections: { type: 'object', description: '各分区的完整内容，键与 baseSections 一致：任务记忆 goal_scope/decisions/progress_done/artifacts/open_issues/next_steps；项目记忆 purpose_scope/conventions/project_decisions/cross_workitem/open_issues' },
        fieldSuggestions: { type: 'object', description: '可选：与工作项字段（goal/status/progress/next/blockedReason）相关的变更建议，随建议一起由用户确认后才生效（仅任务记忆建议）' },
      },
      required: ['proposalId', 'sections'],
    }, opSubmitProposal)

    tool('kanban_manual_edit_memory', '直接手动编辑并版本化记忆（任务或项目）。仅在用户明确要求直接修改记忆时使用；否则应走建议流程。保存后形成新版本，来源标记为手动编辑；与当前版本内容相同则不会产生新版本。', {
      properties: {
        kind: { type: 'string', description: "'task' 或 'project'（必填）" },
        workItemId: { type: 'string', description: 'kind=task 时必填；工作项 id' },
        sections: { type: 'object', description: '各分区的完整新内容（键同建议流程）' },
      },
      required: ['kind', 'sections'],
    }, opManualEditMemory)

    tool('kanban_get_handoff_context', '生成交接上下文文本：最新项目记忆 + 指定工作项信息（目标/状态/进度/下一步/阻塞原因）+ 最新任务记忆 + 本次补充说明。用于把已确认上下文带入新的 DSH 会话继续工作；不修改任何看板数据（会登记当前会话为参与对话）。', {
      properties: {
        workItemId: { type: 'string', description: '要交接的工作项 id（选填；不填则只包含项目记忆）' },
        note: { type: 'string', description: '只用于本次交接的一次性补充说明（选填，不进入正式记忆）' },
      },
      required: [],
    }, opHandoffContext)
  },
}
}
__b
