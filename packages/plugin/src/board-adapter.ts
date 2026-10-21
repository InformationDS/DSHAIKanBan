/**
 * The core → `HostBoardPort` adapter (slice A, P5b).
 *
 * ## What this module is, and is not
 *
 * It is the one place where a validated, **already decoded** channel payload
 * becomes a `@aikanban/core` call, and where a core outcome becomes the wire's
 * eight failure codes plus a board snapshot. It owns no business rule: status
 * transitions, baselines, idempotency and undo identity are decided by core
 * (`packages/core/src/planning.ts`). The only decisions taken here are the ones
 * the wire contract assigns to the host half:
 *
 * 1. **Project resolution** (§3.1): `workspaceRegistry.get(projectId)` — no
 *    fallback, no "current project", no first item. A project that cannot be
 *    resolved is `unknown-project`, never an empty board. First access registers
 *    the project through `core.registerProject`; a failed registration is
 *    reported (`read-failed` on reads, `save-failed` on writes), never swallowed.
 * 2. **Snapshot mapping** (§3.2/§3.3): `TaskView → BoardTask` including the
 *    required `statusRevision` and the nullable `undoTarget`; work scope is
 *    flattened (`null → omitted`); `capabilities` is synthesised; `hints` is
 *    **never** synthesised (S1 has no real hint source, §3.5).
 * 3. **Post-write re-read** (§6.2): every landed write re-reads one snapshot and
 *    classifies a failed re-read by whether the write actually landed
 *    (`unknown-result` vs `read-failed`), so REC-01 is not violated.
 * 4. **Failure mapping** (§6.2): including `stale-baseline + current` and the
 *    `save-failed + current` synthesis core cannot provide (core's `failed`
 *    variant has no `current` field).
 * 5. **Never throw**: every public method catches its own exceptions and
 *    returns a failure result; the channel handler additionally maps an
 *    unexpected throw, but this port must stay boring.
 * 6. **Project listing** (`project/list`, Q1=B): the candidate set comes from the
 *    host workspace registry — never from core's "already registered" list — and
 *    listing selects, registers, caches and writes nothing. The ids it returns
 *    are exactly the ids {@link createHostBoardPort}'s read path resolves.
 *
 * ## What does not cross this boundary
 *
 * The `ver1:<n>` encoding never reaches this module: the handler validates and
 * decodes it before calling the port, so a write can only carry
 * `expectedStatusRevision: number`. The undo credential's two identities are
 * likewise plain values here (`operationId` = this undo, `appliedUpdateId` =
 * the write being undone); this module never re-derives one from the other.
 *
 * @module @aikanban/dsh-aikanban/board-adapter
 */

import type {
  BoardReadResult,
  KanbanCore,
  ProjectView,
  StatusSnapshot,
  TaskStatus,
  TaskView,
  WorkScopeAvailability,
} from '@aikanban/core'
import {
  encodeStatusVersion,
  type BoardFailureCodeWire,
  type BoardSnapshotValue,
  type FormalStatusValueWire,
  type ProjectListItem,
  type ReadBoardPayload,
} from '@aikanban/plugin-client/wire'

import type {
  HostBoardPort,
  HostProjectListOutcome,
  HostReadOutcome,
  HostReorderInput,
  HostSetStatusInput,
  HostUndoInput,
  HostWriteOutcome,
} from './board-channel.js'

/* ------------------------------------------------------------------ *
 * Host service shapes (structural, deliberately not DSH types)
 * ------------------------------------------------------------------ */

/**
 * One workspace entity, as far as the adapter needs it (ADR-003 W1/W2).
 *
 * `status()` is `Promise<'ok' | 'missing-dir'>` — two values, no `unknown` —
 * according to the shipped `dsh-workspace` declarations; the display-only
 * `unknown` value lives in `@aikanban/core`, not in the host.
 */
export interface WorkspaceLike {
  readonly id: string
  readonly title?: string
  readonly path?: string
  status(): Promise<'ok' | 'missing-dir'>
}

/** The subset of `ctx.workspaceRegistry` the adapter needs (read-only). */
export interface WorkspaceRegistryLike {
  get(id: string): WorkspaceLike | undefined
  list(): readonly WorkspaceLike[]
}

/** What the adapter needs from its owner: live accessors, never captured cores. */
export interface HostBoardAdapterDeps {
  /** The core opened by the data-layer bootstrap, or `null` while it is not ready. */
  core(): KanbanCore | null
  /** The host `workspaceRegistry` service, or `undefined` when it is not bound. */
  workspaceRegistry(): WorkspaceRegistryLike | undefined
}

/* ------------------------------------------------------------------ *
 * Wire-side aliases
 * ------------------------------------------------------------------ */

type WireTask = BoardSnapshotValue['tasks'][number]
type WireProject = BoardSnapshotValue['project']

/**
 * Capabilities are contract-level, not per-card: the three operations exist as
 * soon as a data layer serves a snapshot (core `types.ts:1107-1138`). Per-card
 * undo availability is expressed by `undoTarget`, never by this object (§3.4).
 */
const CAPABILITIES: BoardSnapshotValue['capabilities'] = { statusChange: true, reorder: true, undo: true }

/** The prefix REC-01 messages use; making it a constant keeps the wording stable. */
const VERIFY_FIRST = '请先核对当前正式状态，不要重复提交。'

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/* ------------------------------------------------------------------ *
 * Small result builders
 * ------------------------------------------------------------------ */

function readFailure(code: BoardFailureCodeWire, message: string): HostReadOutcome {
  return { ok: false, code, message }
}

function writeFailure(code: BoardFailureCodeWire, message: string, current?: FormalStatusValueWire): HostWriteOutcome {
  return current === undefined ? { ok: false, code, message } : { ok: false, code, message, current }
}

/* ------------------------------------------------------------------ *
 * The adapter
 * ------------------------------------------------------------------ */

/**
 * Build the real board port over a live core and workspace registry.
 *
 * @param deps - live accessors; both are read on every call so a data layer
 *   that becomes ready (or a registry that binds late) needs no re-wiring.
 * @returns a port safe to hand to `registerBoardChannel`.
 */
export function createHostBoardPort(deps: HostBoardAdapterDeps): HostBoardPort {
  /* ---------------- project resolution (§3.1) ---------------- */

  /** One resolved target: the core project key plus this read's display hint. */
  interface ResolvedProject {
    readonly projectId: string
    readonly availability: WorkScopeAvailability
  }

  type ProjectResolution =
    | { readonly ok: true; readonly project: ResolvedProject }
    | { readonly ok: false; readonly code: 'unknown-project' | 'read-failed'; readonly message: string }

  /**
   * Observe the work scope for display only (`'ok' | 'missing-dir'`); an
   * unavailable observation becomes core's `unknown` (未观测), never
   * `missing-dir`. This is a display hint: it is passed to `readBoard` and is
   * NOT persisted (`observeWorkScope` is never called by the board path).
   */
  const observeWorkScope = async (workspace: WorkspaceLike): Promise<WorkScopeAvailability> => {
    try {
      const status: unknown = await workspace.status()
      return status === 'ok' ? 'ok' : status === 'missing-dir' ? 'missing-dir' : 'unknown'
    } catch {
      return 'unknown'
    }
  }

  /**
   * Resolve `projectId` against the host registry and register it with core.
   *
   * Never guesses: a missing registry, a missing workspace or an empty path is
   * `unknown-project`; a registration write that fails is `read-failed` (the
   * caller decides the write-endpoint equivalent).
   */
  const resolveProject = async (projectId: string): Promise<ProjectResolution> => {
    const registry = deps.workspaceRegistry()
    if (registry === undefined) {
      return {
        ok: false,
        code: 'unknown-project',
        message: '项目信息不可用：宿主的 workspaceRegistry 服务未绑定，无法解析项目；不会猜项目。',
      }
    }
    const workspace = registry.get(projectId)
    if (workspace === undefined) {
      return {
        ok: false,
        code: 'unknown-project',
        message: `项目信息不可用：项目 '${projectId}' 不存在或尚未在此工作区登记；这不是一个空看板。`,
      }
    }
    const path = typeof workspace.path === 'string' ? workspace.path.trim() : ''
    if (path.length === 0) {
      return {
        ok: false,
        code: 'unknown-project',
        message: `项目信息不可用：项目 '${projectId}' 没有可用的工作范围路径（workspace.path 为空）。`,
      }
    }
    const core = deps.core()
    if (core === null) {
      return { ok: false, code: 'read-failed', message: '数据层尚未就绪，无法解析并登记项目。' }
    }
    const title = typeof workspace.title === 'string' ? workspace.title : ''
    try {
      const registration = await core.registerProject({ projectId: workspace.id, title, path })
      if (registration.status === 'rejected') {
        // Both `invalid-input` (empty path) and `unknown-project` mean "cannot
        // address this project"; neither may become an empty board.
        return { ok: false, code: 'unknown-project', message: `项目信息不可用：${registration.message}` }
      }
    } catch (error) {
      return { ok: false, code: 'read-failed', message: `项目登记失败：${messageOf(error)}` }
    }
    return { ok: true, project: { projectId: workspace.id, availability: await observeWorkScope(workspace) } }
  }

  /* ---------------- snapshot mapping (§3.2/§3.3) ---------------- */

  const projectOf = (project: ProjectView): WireProject => ({
    projectId: project.projectId,
    title: project.title,
    ...(project.path.length === 0 ? {} : { path: project.path }),
    workScopeAvailability: project.workScope.availability,
    workScopeAllowed: project.workScope.allowed,
    // `null → omitted`: the wire parser does not accept null for an optional
    // string (model.ts:195, wire.ts:258/475).
    ...(project.workScope.reason === null ? {} : { workScopeReason: project.workScope.reason }),
  })

  const taskOf = (task: TaskView): WireTask => ({
    taskId: task.taskId,
    projectId: task.projectId,
    title: task.title,
    goal: task.goal,
    status: task.status,
    statusLabel: task.statusLabel,
    // Null means "no blocked reason"; the wire parser accepts absent, not null.
    ...(task.blockedReason === null ? {} : { blockedReason: task.blockedReason }),
    archived: task.archived,
    order: task.order,
    fieldsRevision: task.fieldsRevision,
    statusRevision: task.statusRevision,
    undoTarget:
      task.undoTarget === null
        ? null
        : {
            statusVersion: encodeStatusVersion(task.undoTarget.statusRevision),
            appliedUpdateId: task.undoTarget.appliedUpdateId,
          },
    summaryProgress:
      task.summaryProgress === null
        ? null
        : {
            line: task.summaryProgress.line,
            versionId: task.summaryProgress.versionId,
            confirmedAt: task.summaryProgress.confirmedAt,
          },
    hasSummary: task.hasSummary,
    hasRecord: task.hasRecord,
    needsRecheck: task.needsRecheck,
    recheckCodes: [...task.recheckCodes],
    // `hints` is deliberately absent, not empty: S1 has no real hint source and
    // the UI must not receive a placeholder (§3.5).
  })

  const snapshotOf = (result: Extract<BoardReadResult, { status: 'ok' }>): BoardSnapshotValue => ({
    project: projectOf(result.project),
    tasks: result.tasks.map(taskOf),
    columns: result.columns.map((column) => ({
      status: column.status,
      label: column.label,
      collapsedByDefault: column.collapsedByDefault,
      // Column members are not duplicated on the wire: the UI groups `tasks` by
      // status (`model.ts:304-340`) and both lists come from the same read.
    })),
    boardToken: result.boardToken,
    capabilities: CAPABILITIES,
  })

  /** One snapshot read, with the failure classified for the endpoint that asked. */
  type SnapshotRead =
    | { readonly ok: true; readonly snapshot: BoardSnapshotValue }
    | { readonly ok: false; readonly kind: 'unknown-project' | 'failed'; readonly message: string }

  const readSnapshot = (core: KanbanCore, projectId: string, availability: WorkScopeAvailability): SnapshotRead => {
    let result: BoardReadResult
    try {
      // A display-only hint: core never persists it from this call (§3.1 step 5).
      result = core.readBoard({ projectId, workScope: { availability } })
    } catch (error) {
      return { ok: false, kind: 'failed', message: `读取看板失败：${messageOf(error)}` }
    }
    if (result.status === 'unknown-project') return { ok: false, kind: 'unknown-project', message: result.message }
    if (result.status === 'failed') return { ok: false, kind: 'failed', message: result.message }
    try {
      return { ok: true, snapshot: snapshotOf(result) }
    } catch (error) {
      return { ok: false, kind: 'failed', message: `映射看板快照失败：${messageOf(error)}` }
    }
  }

  /** `undoable` is always `snapshot.undoTarget !== null` for THIS task (§6.2). */
  const undoableOf = (snapshot: BoardSnapshotValue, taskId: string): boolean => {
    const task = snapshot.tasks.find((candidate) => candidate.taskId === taskId)
    return task !== undefined && task.undoTarget !== null
  }

  /* ---------------- write helpers (§6.2) ---------------- */

  /**
   * Classify a landed write by whether its authoritative re-read succeeded.
   *
   * - `saved` / `already-applied` → re-read failure is `unknown-result` ("已保存、视图未刷新").
   * - `undone` → re-read failure is `unknown-result` ("撤销已生效、视图未刷新");
   *   never `read-failed` (REC-01).
   * - `no-change` → re-read failure is `read-failed`: nothing changed formally.
   */
  const landed = (
    kind: 'saved' | 'already-applied' | 'no-change' | 'undone',
    core: KanbanCore,
    project: ResolvedProject,
    taskId: string,
  ): HostWriteOutcome => {
    const read = readSnapshot(core, project.projectId, project.availability)
    if (!read.ok) {
      if (kind === 'no-change') {
        return writeFailure(
          'read-failed',
          `本次没有改变正式值，但读取最新看板失败：${read.message}；保留旧视图，请重新读取。`,
        )
      }
      if (kind === 'undone') {
        return writeFailure('unknown-result', `撤销已生效、视图未刷新：${read.message}；${VERIFY_FIRST}`)
      }
      return writeFailure('unknown-result', `已保存、视图未刷新：${read.message}；${VERIFY_FIRST}`)
    }
    return { ok: true, snapshot: read.snapshot, undoable: undoableOf(read.snapshot, taskId) }
  }

  /** The formal current value for a `save-failed` (F6: core's `failed` has none). */
  const freshCurrent = (
    core: KanbanCore,
    taskId: string,
    fallback: TaskView | null,
  ): FormalStatusValueWire | undefined => {
    let latest: TaskView | null = null
    try {
      latest = core.readTask({ taskId })
    } catch {
      latest = null
    }
    const task = latest ?? fallback
    return task === null
      ? undefined
      : { status: task.status, statusVersion: encodeStatusVersion(task.statusRevision) }
  }

  const staleFailure = (task: TaskView, message: string): HostWriteOutcome =>
    writeFailure('stale-baseline', message, {
      status: task.status,
      statusVersion: encodeStatusVersion(task.statusRevision),
    })

  const staleFromCurrent = (current: StatusSnapshot, statusRevision: number, message: string): HostWriteOutcome =>
    writeFailure('stale-baseline', message, {
      status: current.status,
      statusVersion: encodeStatusVersion(statusRevision),
    })

  const saveFailureFor = (
    core: KanbanCore,
    taskId: string,
    fallback: TaskView | null,
    message: string,
  ): HostWriteOutcome => writeFailure('save-failed', message, freshCurrent(core, taskId, fallback))

  const notFound = (taskId: string): HostWriteOutcome =>
    writeFailure('not-found', `任务 '${taskId}' 不存在；本次未写入。`)

  const unknownProject = (message: string): HostWriteOutcome => writeFailure('unknown-project', message)

  const unknownResult = (message: string): HostWriteOutcome =>
    writeFailure('unknown-result', `${message}；${VERIFY_FIRST}`)

  /** Pre-read one task for a write path: a missing task is `not-found`, no write happens. */
  type PreRead =
    | { readonly ok: true; readonly task: TaskView }
    | { readonly ok: false; readonly outcome: HostWriteOutcome }

  const preReadTask = (core: KanbanCore, taskId: string): PreRead => {
    let task: TaskView | null
    try {
      task = core.readTask({ taskId })
    } catch (error) {
      return {
        ok: false,
        outcome: writeFailure('save-failed', `读取任务状态失败，本次写入未发生：${messageOf(error)}`),
      }
    }
    if (task === null) return { ok: false, outcome: notFound(taskId) }
    return { ok: true, task }
  }

  /** Resolve the project a write belongs to; a failed resolution never proceeds to the write. */
  const resolveForWrite = async (
    core: KanbanCore,
    task: TaskView,
  ): Promise<
    | { readonly ok: true; readonly project: ResolvedProject }
    | { readonly ok: false; readonly outcome: HostWriteOutcome }
  > => {
    const resolution = await resolveProject(task.projectId)
    if (resolution.ok) return { ok: true, project: resolution.project }
    if (resolution.code === 'unknown-project') return { ok: false, outcome: unknownProject(resolution.message) }
    return {
      ok: false,
      outcome: saveFailureFor(core, task.taskId, task, `项目登记失败，本次写入未发生：${resolution.message}`),
    }
  }

  /* ---------------- the port ---------------- */

  /**
   * One workspace as a selectable item.
   *
   * `projectId` is `workspace.id` on purpose: that is the key `board/read` sends
   * back and the adapter resolves through `workspaceRegistry.get` — the listing
   * can never offer an id its own read path would reject. `title` falls back to
   * the id, and `path` keeps same-title projects distinguishable (Q1=B).
   */
  const projectItemOf = (workspace: WorkspaceLike): ProjectListItem => ({
    projectId: workspace.id,
    title: typeof workspace.title === 'string' && workspace.title.trim().length > 0 ? workspace.title : workspace.id,
    path: typeof workspace.path === 'string' ? workspace.path.trim() : '',
  })

  return {
    /**
     * The candidate project set, straight from the host registry.
     *
     * Deliberately does **not** consult the core data layer's `listProjects()`
     * (that one only knows projects already registered by a read) and does not
     * select, register, cache or remember anything (Q1=B). An empty registry is
     * a legal empty candidate set; a missing registry is `unavailable`, and an
     * exploding registry is `read-failed` — never a fabricated project.
     */
    async listProjects(signal?: AbortSignal): Promise<HostProjectListOutcome> {
      try {
        if (signal?.aborted === true) {
          return { ok: false, code: 'read-failed', message: '读取项目清单已取消；未返回任何项目。' }
        }
        const registry = deps.workspaceRegistry()
        if (registry === undefined) {
          return {
            ok: false,
            code: 'unavailable',
            message: '项目清单不可用：宿主的 workspaceRegistry 服务未绑定；不会猜测或默认选择项目。',
          }
        }
        return { ok: true, projects: registry.list().map(projectItemOf) }
      } catch (error) {
        return { ok: false, code: 'read-failed', message: `读取项目清单失败：${messageOf(error)}` }
      }
    },

    async readBoard(input: ReadBoardPayload, signal?: AbortSignal): Promise<HostReadOutcome> {
      try {
        if (signal?.aborted === true) {
          return readFailure('read-failed', '读取已取消；未显示任何看板数据。')
        }
        const core = deps.core()
        if (core === null) {
          return readFailure('unavailable', '数据层尚未就绪，看板暂不可用；不显示空看板。')
        }
        const resolution = await resolveProject(input.projectId)
        if (!resolution.ok) {
          return readFailure(resolution.code, resolution.message)
        }
        const read = readSnapshot(core, resolution.project.projectId, resolution.project.availability)
        return read.ok
          ? { ok: true, snapshot: read.snapshot }
          : readFailure(read.kind === 'failed' ? 'read-failed' : 'unknown-project', read.message)
      } catch (error) {
        return readFailure('read-failed', `读取失败：${messageOf(error)}`)
      }
    },

    async setStatus(input: HostSetStatusInput): Promise<HostWriteOutcome> {
      try {
        const core = deps.core()
        if (core === null) {
          return writeFailure('unavailable', '数据层尚未就绪，本次操作未执行；正式值未改变。')
        }
        const pre = preReadTask(core, input.taskId)
        if (!pre.ok) return pre.outcome
        const resolved = await resolveForWrite(core, pre.task)
        if (!resolved.ok) return resolved.outcome

        let outcome: Awaited<ReturnType<KanbanCore['setTaskStatus']>>
        try {
          outcome = await core.setTaskStatus({
            taskId: input.taskId,
            requestId: input.operationId,
            // The status vocabulary is core's: a non-empty string is accepted at
            // the wire, and core decides `invalid-status` (§6.2 → save-failed).
            toStatus: input.next as TaskStatus,
            expected: { statusRevision: input.expectedStatusRevision },
            blockedReason: input.reason ?? null,
            ...(input.toIndex === undefined ? {} : { toIndex: input.toIndex }),
          })
        } catch (error) {
          return unknownResult(`写入结果未知：${messageOf(error)}`)
        }

        switch (outcome.status) {
          case 'saved':
          case 'no-change':
          case 'already-applied':
            return landed(outcome.status, core, resolved.project, input.taskId)
          case 'baseline-changed':
            return staleFailure(outcome.task, '此前的修改已被其他操作更新，本次未写入；正式值见 current。')
          case 'rejected':
            switch (outcome.code) {
              case 'unknown-task':
                return notFound(input.taskId)
              case 'unknown-project':
                return unknownProject(outcome.message)
              case 'blocked-reason-required':
                return writeFailure('invalid-reason', outcome.message)
              case 'invalid-status':
              case 'invalid-input':
                return saveFailureFor(core, input.taskId, pre.task, outcome.message)
            }
            return saveFailureFor(core, input.taskId, pre.task, '写入被数据层拒绝；正式值未改变。')
          case 'failed':
            return saveFailureFor(
              core,
              input.taskId,
              outcome.task ?? pre.task,
              `保存失败：${outcome.message}；正式值未改变。`,
            )
          default:
            return unknownResult('写入结果未知')
        }
      } catch (error) {
        // Defensive only: the branches above return failures instead of throwing.
        return unknownResult(`写入结果未知：${messageOf(error)}`)
      }
    },

    async reorder(input: HostReorderInput): Promise<HostWriteOutcome> {
      try {
        const core = deps.core()
        if (core === null) {
          return writeFailure('unavailable', '数据层尚未就绪，本次操作未执行；正式值未改变。')
        }
        const pre = preReadTask(core, input.taskId)
        if (!pre.ok) return pre.outcome
        const resolved = await resolveForWrite(core, pre.task)
        if (!resolved.ok) return resolved.outcome
        // §4.3: the wire's `status` is the column the user saw. If core moved the
        // task to another column, the drag is already stale — no write.
        if (pre.task.status !== input.status) {
          return staleFailure(pre.task, '任务已不在用户看到的那一列，本次排序未写入；请重新读取后拖动。')
        }

        let outcome: Awaited<ReturnType<KanbanCore['reorderTask']>>
        try {
          outcome = await core.reorderTask({
            taskId: input.taskId,
            requestId: input.operationId,
            toIndex: input.toIndex,
            expected: { statusRevision: input.expectedStatusRevision },
          })
        } catch (error) {
          return unknownResult(`排序结果未知：${messageOf(error)}`)
        }

        switch (outcome.status) {
          case 'saved':
          case 'no-change':
            return landed(outcome.status, core, resolved.project, input.taskId)
          case 'baseline-changed':
            return staleFailure(outcome.task, '此前的修改已被其他操作更新，本次排序未写入；正式值见 current。')
          case 'rejected':
            switch (outcome.code) {
              case 'unknown-task':
                return notFound(input.taskId)
              case 'unknown-project':
                return unknownProject(outcome.message)
              case 'invalid-input':
              default:
                return saveFailureFor(core, input.taskId, pre.task, outcome.message)
            }
          case 'failed':
            return saveFailureFor(
              core,
              input.taskId,
              outcome.task ?? pre.task,
              `排序失败：${outcome.message}；正式值未改变。`,
            )
          default:
            return unknownResult('排序结果未知')
        }
      } catch (error) {
        return unknownResult(`排序结果未知：${messageOf(error)}`)
      }
    },

    async undoStatusChange(input: HostUndoInput): Promise<HostWriteOutcome> {
      try {
        const core = deps.core()
        if (core === null) {
          return writeFailure('unavailable', '数据层尚未就绪，本次操作未执行；正式值未改变。')
        }
        const pre = preReadTask(core, input.taskId)
        if (!pre.ok) return pre.outcome
        const resolved = await resolveForWrite(core, pre.task)
        if (!resolved.ok) return resolved.outcome

        // §6.2 pre-check: a retry of an undo that already landed must not be
        // mistaken for a lost race. Core records the undo's own id as the last
        // status update, so an exact match means "already in effect".
        if (pre.task.lastStatusUpdateId === input.operationId) {
          return landed('undone', core, resolved.project, input.taskId)
        }

        let outcome: Awaited<ReturnType<KanbanCore['undoStatusChange']>>
        try {
          outcome = await core.undoStatusChange({
            taskId: input.taskId,
            undoId: input.operationId,
            expected: {
              statusRevision: input.expectedStatusRevision,
              appliedUpdateId: input.appliedUpdateId,
            },
          })
        } catch (error) {
          return unknownResult(`撤销结果未知：${messageOf(error)}`)
        }

        switch (outcome.status) {
          case 'undone':
            return landed('undone', core, resolved.project, input.taskId)
          case 'cannot-undo': {
            if (outcome.code === 'superseded') {
              // Same-id retry can also arrive here (core found the undo id in its
              // idempotency window before touching the task). Re-check the
              // authoritative last update id instead of reporting a false race.
              let latest: TaskView | null = null
              try {
                latest = core.readTask({ taskId: input.taskId })
              } catch {
                latest = null
              }
              if (latest !== null && latest.lastStatusUpdateId === input.operationId) {
                return landed('undone', core, resolved.project, input.taskId)
              }
            }
            if (outcome.code === 'unknown-task') return notFound(input.taskId)
            if (outcome.code === 'invalid-input') {
              return saveFailureFor(core, input.taskId, pre.task, outcome.message)
            }
            return staleFromCurrent(outcome.current, outcome.currentStatusRevision, `${outcome.message}；本次未覆盖当前值。`)
          }
          case 'rejected':
            switch (outcome.code) {
              case 'unknown-task':
                return notFound(input.taskId)
              case 'invalid-input':
              default:
                return saveFailureFor(core, input.taskId, pre.task, outcome.message)
            }
          case 'failed':
            return saveFailureFor(
              core,
              input.taskId,
              outcome.task ?? pre.task,
              `撤销失败：${outcome.message}；正式值未改变。`,
            )
          default:
            return unknownResult('撤销结果未知')
        }
      } catch (error) {
        return unknownResult(`撤销结果未知：${messageOf(error)}`)
      }
    },
  }
}
