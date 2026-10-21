/**
 * Slice-A integration matrix: real core + in-memory storage + real adapter + real handler.
 *
 * ## What this file is evidence for (and is not)
 *
 * s1-wiring.md §7.1 asks for one file that drives the **real**
 * `createKanbanCore({port: createMemoryStoragePort(createMemoryMedium())})` through
 * the **real** `createHostBoardPort(...)` and the **real**
 * `createBoardChannelHandler(...)` — no test double for the adapter, the core or
 * the channel contract. That is what this file does. It is 档 2 (auxiliary)
 * evidence: **not** F01/F02 acceptance, and not evidence that the network hop,
 * a real profile, or the real GUI work. AT status is untouched.
 *
 * ## Fault injection
 *
 * Faults are injected only at test seams (Q3 policy, acceptance-execution.md §3):
 * - the storage port wrapper (`storageFaults.read/write`) simulates durable
 *   read/write failures;
 * - a `Proxy` around the real core (`coreFaults`) simulates a **post-write
 *   re-read** failure and a core `readBoard` returning `failed`;
 * - one test replaces the adapter's `setStatus` with a thrower to prove the
 *   handler's own catch (the production adapter never throws).
 * None of this ships: the production port is the real adapter.
 *
 * @module @aikanban/dsh-aikanban/test/board-adapter
 */

import { describe, expect, it } from 'vitest'

import {
  AIKANBAN_TABLES,
  createKanbanCore,
  createMemoryMedium,
  createMemoryStoragePort,
  scopeKey,
  type KanbanCore,
  type StoragePort,
} from '@aikanban/core'
import { parseBoardSnapshotValue } from '@aikanban/plugin-client/wire'

import {
  createBoardChannelHandler,
  createHostBoardPort,
  type BoardRpcHandler,
  type BoardRpcResult,
  type HostBoardPort,
  type WorkspaceRegistryLike,
} from '../src/index.js'
import { createDelayedBoardPort } from '../src/delayed-board-port.js'

/* ------------------------------------------------------------------ *
 * Wire-side shapes the tests assert against (the wire parser is the judge)
 * ------------------------------------------------------------------ */

interface SnapshotTask {
  readonly taskId: string
  readonly projectId: string
  readonly title: string
  readonly goal: string
  readonly status: string
  readonly statusLabel?: string | null
  readonly blockedReason?: string | null
  readonly archived?: boolean
  readonly order: number
  readonly fieldsRevision?: number
  readonly statusRevision: number
  readonly undoTarget: { readonly statusVersion: string; readonly appliedUpdateId: string } | null
  readonly hasSummary?: boolean
  readonly hasRecord?: boolean
  readonly needsRecheck?: boolean
  readonly recheckCodes?: readonly string[]
  readonly hints?: unknown
}

interface SnapshotColumn {
  readonly status: string
  readonly label?: string
  readonly collapsedByDefault?: boolean
  readonly tasks?: unknown
}

interface SnapshotProject {
  readonly projectId: string
  readonly title: string
  readonly path?: string
  readonly workScopeAvailability: 'ok' | 'missing-dir' | 'unknown'
  readonly workScopeAllowed: boolean
  readonly workScopeReason?: string | null
}

interface Snapshot {
  readonly project: SnapshotProject
  readonly tasks: readonly SnapshotTask[]
  readonly columns: readonly SnapshotColumn[]
  readonly boardToken: string
  readonly capabilities: { readonly statusChange: boolean; readonly reorder: boolean; readonly undo: boolean }
}

interface FailureBody {
  readonly code: string
  readonly message: string
  readonly details: Record<string, unknown>
}

const SIGNAL = new AbortController().signal

function successOf(result: BoardRpcResult): unknown {
  if (!result.ok) throw new Error(`expected a success, got ${result.error.code}: ${result.error.message}`)
  return result.value
}

function failureOf(result: BoardRpcResult): FailureBody {
  if (result.ok) throw new Error('expected a failure result, got a success')
  return result.error
}

/** The wire parser is the authority on "is this a valid board snapshot". */
function snapshotOf(value: unknown): Snapshot {
  const parsed = parseBoardSnapshotValue(value)
  if (parsed === null) throw new Error('the host returned a snapshot the wire parser rejects')
  return parsed as unknown as Snapshot
}

function writeOf(result: BoardRpcResult): { snapshot: Snapshot; undoable: boolean } {
  const raw = successOf(result) as { snapshot?: unknown; undoable?: unknown }
  if (typeof raw.undoable !== 'boolean') throw new Error('a write success must carry a boolean undoable')
  return { snapshot: snapshotOf(raw.snapshot), undoable: raw.undoable }
}

function taskIn(snapshot: Snapshot, taskId: string): SnapshotTask {
  const task = snapshot.tasks.find((candidate) => candidate.taskId === taskId)
  if (task === undefined) throw new Error(`task '${taskId}' is missing from the snapshot`)
  return task
}

/* ------------------------------------------------------------------ *
 * Harness: real core over a fault-injecting memory port, real adapter, real handler
 * ------------------------------------------------------------------ */

interface StorageFaults {
  read?: (table: string, key: string) => Error | undefined
  write?: (table: string, key: string) => Error | undefined
}

interface CoreFaults {
  /** Make `readBoard` throw (a post-write re-read that fails). */
  failBoardRead: boolean
  /** Make `readBoard` return core's `failed` variant. */
  forceBoardFailure: boolean
  /** Arm `failBoardRead` right after a write method resolves. */
  armAfterWrite: boolean
}

const WRITE_METHODS = new Set<string>(['setTaskStatus', 'reorderTask', 'undoStatusChange'])

function faultyStorage(faults: StorageFaults): StoragePort {
  const memory = createMemoryStoragePort(createMemoryMedium())
  return {
    name: memory.name,
    get<T>(table: string, key: string): T | undefined {
      const error = faults.read?.(table, key)
      if (error !== undefined) throw error
      return memory.get<T>(table, key)
    },
    put<T>(table: string, key: string, value: T): Promise<void> {
      const error = faults.write?.(table, key)
      return error === undefined ? memory.put(table, key, value) : Promise.reject(error)
    },
    delete(table: string, key: string): Promise<boolean> {
      const error = faults.write?.(table, key)
      return error === undefined ? memory.delete(table, key) : Promise.reject(error)
    },
    update<T>(table: string, key: string, transform: (current: T) => T): Promise<T> {
      const error = faults.write?.(table, key)
      return error === undefined ? memory.update(table, key, transform) : Promise.reject(error)
    },
    entries<T>(table: string): IterableIterator<[string, T]> {
      // The entries scan is the whole-table read; a synthetic key lets a test
      // fail it without also failing point reads.
      const error = faults.read?.(table, `${table}/*`)
      if (error !== undefined) throw error
      return memory.entries<T>(table)
    },
    keys(table: string): IterableIterator<string> {
      return memory.keys(table)
    },
    size(table: string): number {
      return memory.size(table)
    },
  }
}

/**
 * Wrap the real core with only the two fault seams above. Everything not named
 * here is the production core, delegated unchanged.
 */
function proxyCore(core: KanbanCore, faults: CoreFaults): KanbanCore {
  return new Proxy(core, {
    get(target, property, receiver) {
      if (property === 'readBoard') {
        return (input: Parameters<KanbanCore['readBoard']>[0]) => {
          if (faults.failBoardRead) throw new Error('injected post-write re-read failure')
          if (faults.forceBoardFailure) {
            return {
              status: 'failed',
              projectId: input.projectId,
              code: 'read-failed',
              message: 'injected board read failure',
            }
          }
          return target.readBoard(input)
        }
      }
      if (faults.armAfterWrite && typeof property === 'string' && WRITE_METHODS.has(property)) {
        const original = Reflect.get(target, property, receiver) as (...args: readonly unknown[]) => Promise<unknown>
        return async (...args: readonly unknown[]) => {
          const outcome = await original.apply(target, args)
          faults.failBoardRead = true
          return outcome
        }
      }
      return Reflect.get(target, property, receiver)
    },
  })
}

interface FakeWorkspace {
  readonly id: string
  readonly title?: string
  readonly path?: string
  readonly statusMode: 'ok' | 'missing-dir' | 'reject'
}

interface RegistryDouble {
  readonly workspaces: Map<string, FakeWorkspace>
  readonly registry: WorkspaceRegistryLike
  add(id: string, overrides?: Partial<Omit<FakeWorkspace, 'id'>>): void
  remove(id: string): void
}

function makeRegistry(): RegistryDouble {
  const workspaces = new Map<string, FakeWorkspace>()
  const toWorkspace = (entry: FakeWorkspace) => ({
    id: entry.id,
    ...(entry.title === undefined ? {} : { title: entry.title }),
    ...(entry.path === undefined ? {} : { path: entry.path }),
    status: async (): Promise<'ok' | 'missing-dir'> => {
      if (entry.statusMode === 'reject') throw new Error('workspace.status() is unavailable in this composition')
      return entry.statusMode === 'missing-dir' ? 'missing-dir' : 'ok'
    },
  })
  const registry: WorkspaceRegistryLike = {
    get: (id: string) => {
      const entry = workspaces.get(id)
      return entry === undefined ? undefined : toWorkspace(entry)
    },
    list: () => [...workspaces.values()].map(toWorkspace),
  }
  return {
    workspaces,
    registry,
    add(id, overrides = {}) {
      workspaces.set(id, { id, title: 'Demo project', path: 'C:/demo', statusMode: 'ok', ...overrides })
    },
    remove(id) {
      workspaces.delete(id)
    },
  }
}

interface Harness {
  readonly core: KanbanCore
  readonly faults: CoreFaults
  readonly storageFaults: StorageFaults
  readonly registry: RegistryDouble
  readonly adapter: HostBoardPort
  readonly handler: BoardRpcHandler
  readonly projectId: string
}

function createHarness(
  options: {
    project?: boolean
    projectStatus?: 'ok' | 'missing-dir' | 'reject'
    registry?: boolean
    armAfterWrite?: boolean
  } = {},
): Harness {
  const storageFaults: StorageFaults = {}
  const faults: CoreFaults = {
    failBoardRead: false,
    forceBoardFailure: false,
    armAfterWrite: options.armAfterWrite === true,
  }
  const core = proxyCore(createKanbanCore({ port: faultyStorage(storageFaults) }), faults)
  const registry = makeRegistry()
  if (options.project !== false) {
    registry.add('ws-1', { title: 'Demo project', path: 'C:/demo', statusMode: options.projectStatus ?? 'ok' })
  }
  const adapter = createHostBoardPort({
    core: () => core,
    workspaceRegistry: () => (options.registry === false ? undefined : registry.registry),
  })
  return {
    core,
    faults,
    storageFaults,
    registry,
    adapter,
    handler: createBoardChannelHandler(adapter),
    projectId: 'ws-1',
  }
}

async function seedProject(harness: Harness): Promise<void> {
  const registration = await harness.core.registerProject({
    projectId: harness.projectId,
    title: 'Demo project',
    path: 'C:/demo',
  })
  if (registration.status === 'rejected') throw new Error(`registerProject failed: ${registration.message}`)
}

async function seedTask(harness: Harness, requestId: string, title: string): Promise<string> {
  const outcome = await harness.core.createTask({ projectId: harness.projectId, requestId, title })
  if (outcome.status === 'rejected' || outcome.status === 'failed') {
    throw new Error(`createTask failed: ${outcome.status}`)
  }
  return outcome.taskId
}

async function seedProjectAndTask(harness: Harness, title = 'Task A', requestId = 'create-1'): Promise<string> {
  await seedProject(harness)
  return seedTask(harness, requestId, title)
}

async function readBoard(harness: Harness, projectId = harness.projectId): Promise<Snapshot> {
  return snapshotOf(successOf(await harness.handler('board/read', { projectId }, SIGNAL)))
}

function setPayload(
  taskId: string,
  next: string,
  operationId: string,
  expectedStatusVersion: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { taskId, next, operationId, expectedStatusVersion, ...extra }
}

function reorderPayload(
  taskId: string,
  status: string,
  toIndex: number,
  operationId: string,
  expectedStatusVersion: string,
): Record<string, unknown> {
  return { taskId, status, toIndex, operationId, expectedStatusVersion }
}

function undoPayload(
  taskId: string,
  operationId: string,
  expectedStatusVersion: string,
  appliedUpdateId: string,
): Record<string, unknown> {
  return { taskId, operationId, expectedStatusVersion, appliedUpdateId }
}

/** The `current` payload handler puts in `details` for stale-baseline/save-failed. */
function currentOf(failure: FailureBody): unknown {
  return failure.details['current']
}

/* ------------------------------------------------------------------ *
 * board/read — ok / unknown-project / read-failed (§3.1, §6.1)
 * ------------------------------------------------------------------ */

describe('board/read: three outcomes and snapshot mapping (§3.1/§3.2/§3.3)', () => {
  it('registers the project on first access and returns a wire-valid snapshot', async () => {
    const harness = createHarness()

    // First access with a registry-only project: the adapter registers it with
    // core and returns an empty (but valid) board — not an error, not a guess.
    const first = await readBoard(harness)
    expect(harness.core.listProjects().map((project) => project.projectId)).toEqual(['ws-1'])
    expect(first.tasks).toEqual([])

    const taskId = await seedTask(harness, 'create-1', 'Task A')
    const snapshot = await readBoard(harness)

    expect(snapshot.project.projectId).toBe('ws-1')
    expect(snapshot.project.title).toBe('Demo project')
    expect(snapshot.project.path).toBe('C:/demo')
    expect(snapshot.project.workScopeAvailability).toBe('ok')
    expect(snapshot.project.workScopeAllowed).toBe(true)
    // `null` reason is omitted (the wire parser rejects null for an optional string).
    expect('workScopeReason' in snapshot.project).toBe(false)

    expect(snapshot.tasks).toHaveLength(1)
    const task = taskIn(snapshot, taskId)
    expect(task.statusRevision).toBe(0)
    expect(task.undoTarget).toBeNull()
    expect(task.archived).toBe(false)
    expect(typeof task.fieldsRevision).toBe('number')
    // §3.5: hints are never synthesised, so the key is absent (not empty).
    expect('hints' in task).toBe(false)

    // Columns are core's five, in order, and do not duplicate the task list.
    expect(snapshot.columns.map((column) => column.status)).toEqual(['todo', 'doing', 'blocked', 'done', 'cancelled'])
    expect(snapshot.columns.find((column) => column.status === 'cancelled')?.collapsedByDefault).toBe(true)
    for (const column of snapshot.columns) expect('tasks' in column).toBe(false)

    // §3.4: capabilities are contract-level and all true on a serving data layer.
    expect(snapshot.capabilities).toEqual({ statusChange: true, reorder: true, undo: true })

    // The change token must be core's own for the same read hint.
    const direct = harness.core.readBoard({ projectId: 'ws-1', workScope: { availability: 'ok' } })
    if (direct.status !== 'ok') throw new Error(`direct read failed: ${direct.status}`)
    expect(snapshot.boardToken).toBe(direct.boardToken)
  })

  it('refuses a missing projectId without guessing a project', async () => {
    const harness = createHarness()
    expect(harness.core.listProjects()).toEqual([])

    const result = await harness.handler('board/read', {}, SIGNAL)

    expect(failureOf(result).code).toBe('invalid-payload')
    // No project was registered or read as a fallback.
    expect(harness.core.listProjects()).toEqual([])
  })

  it('reports an unregistered project as unknown-project, never an empty board', async () => {
    const harness = createHarness()

    const result = await harness.handler('board/read', { projectId: 'ws-unknown' }, SIGNAL)

    expect(failureOf(result).code).toBe('unknown-project')
    expect(failureOf(result).message).toContain('unknown')
    expect(harness.core.listProjects()).toEqual([])
  })

  it('reports a composition without workspaceRegistry as unknown-project', async () => {
    const harness = createHarness({ registry: false })

    const result = await harness.handler('board/read', { projectId: 'ws-1' }, SIGNAL)

    expect(failureOf(result).code).toBe('unknown-project')
    expect(failureOf(result).message).toContain('workspaceRegistry')
  })

  it('maps a failing data-layer read to read-failed (never an empty board)', async () => {
    const harness = createHarness()
    await seedProjectAndTask(harness)
    harness.storageFaults.read = () => new Error('injected storage read failure')

    const result = await harness.handler('board/read', { projectId: 'ws-1' }, SIGNAL)

    expect(failureOf(result).code).toBe('read-failed')
    expect(result.ok).toBe(false)
  })

  it('maps core\'s failed read variant to read-failed', async () => {
    const harness = createHarness()
    await seedProjectAndTask(harness)
    harness.faults.forceBoardFailure = true

    const result = await harness.handler('board/read', { projectId: 'ws-1' }, SIGNAL)

    expect(failureOf(result).code).toBe('read-failed')
    expect(failureOf(result).message).toContain('injected board read failure')
  })

  it('flattens a missing-dir work scope: not allowed, with a reason', async () => {
    const harness = createHarness({ projectStatus: 'missing-dir' })
    await seedProjectAndTask(harness)

    const snapshot = await readBoard(harness)

    expect(snapshot.project.workScopeAvailability).toBe('missing-dir')
    expect(snapshot.project.workScopeAllowed).toBe(false)
    expect(typeof snapshot.project.workScopeReason).toBe('string')
    expect(snapshot.project.workScopeReason).toContain('不可用')
  })

  it('uses unknown availability when workspace.status() cannot be observed', async () => {
    const harness = createHarness({ projectStatus: 'reject' })
    await seedProjectAndTask(harness)

    const snapshot = await readBoard(harness)

    // "未观测" is our display state, not a host return value; it must not read
    // as "no scope" and must not refuse actions.
    expect(snapshot.project.workScopeAvailability).toBe('unknown')
    expect(snapshot.project.workScopeAllowed).toBe(true)
    expect('workScopeReason' in snapshot.project).toBe(false)
  })

  it('treats a project whose workspace path is empty as unknown-project', async () => {
    const harness = createHarness({ project: false })
    harness.registry.add('ws-empty', { title: 'Empty', path: '   ' })

    const result = await harness.handler('board/read', { projectId: 'ws-empty' }, SIGNAL)

    expect(failureOf(result).code).toBe('unknown-project')
    expect(harness.core.listProjects()).toEqual([])
  })
})

/* ------------------------------------------------------------------ *
 * task/status.set — success paths and §6.2 mappings
 * ------------------------------------------------------------------ */

describe('task/status.set: success paths', () => {
  it('changes status through the real core and returns the re-read snapshot', async () => {
    const harness = createHarness()
    const taskId = await seedProjectAndTask(harness)

    const result = await harness.handler('task/status.set', setPayload(taskId, 'doing', 'op-1', 'ver1:0'), SIGNAL)

    const { snapshot, undoable } = writeOf(result)
    expect(undoable).toBe(true)
    const task = taskIn(snapshot, taskId)
    expect(task.status).toBe('doing')
    expect(task.statusRevision).toBe(1)
    expect(task.undoTarget).toEqual({ statusVersion: 'ver1:1', appliedUpdateId: 'op-1' })

    const stored = harness.core.readTask({ taskId })
    expect(stored?.status).toBe('doing')
    expect(stored?.statusRevision).toBe(1)
  })

  it('treats a retried operation id as already applied, not as a second change', async () => {
    const harness = createHarness()
    const taskId = await seedProjectAndTask(harness)

    expect((await harness.handler('task/status.set', setPayload(taskId, 'doing', 'op-1', 'ver1:0'), SIGNAL)).ok).toBe(true)
    // Same operationId, stale baseline: REC-02 idempotency must win over SAVE-05.
    const retried = await harness.handler('task/status.set', setPayload(taskId, 'doing', 'op-1', 'ver1:0'), SIGNAL)

    const { snapshot, undoable } = writeOf(retried)
    expect(undoable).toBe(true)
    expect(taskIn(snapshot, taskId).statusRevision).toBe(1)
    expect(harness.core.readTask({ taskId })?.statusRevision).toBe(1)
  })

  it('reports no-change as a success whose undoable comes from the snapshot', async () => {
    const harness = createHarness()
    const taskId = await seedProjectAndTask(harness)
    expect((await harness.handler('task/status.set', setPayload(taskId, 'doing', 'op-1', 'ver1:0'), SIGNAL)).ok).toBe(true)

    // `todo → doing`, then "doing → doing" with the correct new baseline: core
    // reports no-change, and the previous undo target is still valid.
    const unchanged = await harness.handler('task/status.set', setPayload(taskId, 'doing', 'op-2', 'ver1:1'), SIGNAL)

    const { snapshot, undoable } = writeOf(unchanged)
    // §6.2 explicitly: no-change is NOT undoable=false.
    expect(undoable).toBe(true)
    expect(taskIn(snapshot, taskId).undoTarget).toEqual({ statusVersion: 'ver1:1', appliedUpdateId: 'op-1' })
    expect(harness.core.readTask({ taskId })?.statusRevision).toBe(1)
  })
})

describe('task/status.set: §6.2 failure mappings', () => {
  it('maps a lost baseline to stale-baseline with the formal current value', async () => {
    const harness = createHarness()
    const taskId = await seedProjectAndTask(harness)
    await harness.handler('task/status.set', setPayload(taskId, 'doing', 'op-1', 'ver1:0'), SIGNAL)

    const result = await harness.handler('task/status.set', setPayload(taskId, 'done', 'op-2', 'ver1:0'), SIGNAL)

    const failure = failureOf(result)
    expect(failure.code).toBe('stale-baseline')
    expect(currentOf(failure)).toEqual({ status: 'doing', statusVersion: 'ver1:1' })
    expect(harness.core.readTask({ taskId })?.status).toBe('doing')
  })

  it('maps invalid-status to save-failed with current', async () => {
    const harness = createHarness()
    const taskId = await seedProjectAndTask(harness)

    const result = await harness.handler('task/status.set', setPayload(taskId, 'archived', 'op-1', 'ver1:0'), SIGNAL)

    const failure = failureOf(result)
    expect(failure.code).toBe('save-failed')
    expect(currentOf(failure)).toEqual({ status: 'todo', statusVersion: 'ver1:0' })
    expect(harness.core.readTask({ taskId })?.status).toBe('todo')
  })

  it('maps an unknown task to not-found', async () => {
    const harness = createHarness()

    const result = await harness.handler('task/status.set', setPayload('nope', 'doing', 'op-1', 'ver1:0'), SIGNAL)

    expect(failureOf(result).code).toBe('not-found')
  })

  it('maps a project missing from the workspace registry to unknown-project', async () => {
    const harness = createHarness()
    const taskId = await seedProjectAndTask(harness)
    harness.registry.remove('ws-1')

    const result = await harness.handler('task/status.set', setPayload(taskId, 'doing', 'op-1', 'ver1:0'), SIGNAL)

    expect(failureOf(result).code).toBe('unknown-project')
    expect(harness.core.readTask({ taskId })?.status).toBe('todo')
  })

  it('synthesises current for a failed write and leaves the formal value unchanged', async () => {
    const harness = createHarness()
    const taskId = await seedProjectAndTask(harness)
    harness.storageFaults.write = (table, key) =>
      table === AIKANBAN_TABLES.scopeState && key === scopeKey('task', taskId)
        ? new Error('injected write failure')
        : undefined

    const result = await harness.handler('task/status.set', setPayload(taskId, 'doing', 'op-1', 'ver1:0'), SIGNAL)

    const failure = failureOf(result)
    expect(failure.code).toBe('save-failed')
    // F6: core's failed variant has no current; the adapter must readTask and encode it.
    expect(currentOf(failure)).toEqual({ status: 'todo', statusVersion: 'ver1:0' })
    const stored = harness.core.readTask({ taskId })
    expect(stored?.status).toBe('todo')
    expect(stored?.statusRevision).toBe(0)
  })

  it('maps a blocked transition without a reason to invalid-reason (adapter branch)', async () => {
    const harness = createHarness()
    const taskId = await seedProjectAndTask(harness)

    // Direct port call: the handler would refuse earlier, so this pins the
    // adapter's defensive mapping of core's `blocked-reason-required`.
    const outcome = await harness.adapter.setStatus({
      taskId,
      next: 'blocked',
      operationId: 'op-block',
      expectedStatusRevision: 0,
    })

    expect(outcome).toMatchObject({ ok: false, code: 'invalid-reason' })
    expect(harness.core.readTask({ taskId })?.status).toBe('todo')
  })

  it('maps invalid-input to save-failed with current (adapter branch)', async () => {
    const harness = createHarness()
    const taskId = await seedProjectAndTask(harness)

    const outcome = await harness.adapter.setStatus({
      taskId,
      next: 'doing',
      operationId: '',
      expectedStatusRevision: 0,
    })

    expect(outcome).toMatchObject({
      ok: false,
      code: 'save-failed',
      current: { status: 'todo', statusVersion: 'ver1:0' },
    })
  })
})

/* ------------------------------------------------------------------ *
 * task/reorder
 * ------------------------------------------------------------------ */

describe('task/reorder: success path and §6.2 mappings', () => {
  it('reorders a column and returns the re-read order', async () => {
    const harness = createHarness()
    await seedProject(harness)
    await seedTask(harness, 'create-1', 'Task A')
    await seedTask(harness, 'create-2', 'Task B')
    await seedTask(harness, 'create-3', 'Task C')
    const before = await readBoard(harness)
    expect(before.tasks).toHaveLength(3)
    const mover = before.tasks[2]
    if (mover === undefined) throw new Error('missing third task')

    const result = await harness.handler(
      'task/reorder',
      reorderPayload(mover.taskId, 'todo', 0, 'op-r1', 'ver1:0'),
      SIGNAL,
    )

    const { snapshot, undoable } = writeOf(result)
    expect(undoable).toBe(false) // no status transition ever happened for these tasks
    expect(taskIn(snapshot, mover.taskId).order).toBe(0)
    const direct = harness.core.readBoard({ projectId: 'ws-1', workScope: { availability: 'ok' } })
    if (direct.status !== 'ok') throw new Error(`direct read failed: ${direct.status}`)
    const todo = direct.columns.find((column) => column.status === 'todo')
    expect(todo?.tasks[0]?.taskId).toBe(mover.taskId)
  })

  it('refuses a reorder whose visible column changed: stale-baseline + current', async () => {
    const harness = createHarness()
    const taskId = await seedProjectAndTask(harness)
    await harness.handler('task/status.set', setPayload(taskId, 'doing', 'op-1', 'ver1:0'), SIGNAL)

    const result = await harness.handler('task/reorder', reorderPayload(taskId, 'todo', 0, 'op-r2', 'ver1:1'), SIGNAL)

    const failure = failureOf(result)
    expect(failure.code).toBe('stale-baseline')
    expect(currentOf(failure)).toEqual({ status: 'doing', statusVersion: 'ver1:1' })
  })

  it('maps a reorder baseline change to stale-baseline + current', async () => {
    const harness = createHarness()
    const taskId = await seedProjectAndTask(harness)

    const result = await harness.handler('task/reorder', reorderPayload(taskId, 'todo', 0, 'op-r1', 'ver1:9'), SIGNAL)

    const failure = failureOf(result)
    expect(failure.code).toBe('stale-baseline')
    expect(currentOf(failure)).toEqual({ status: 'todo', statusVersion: 'ver1:0' })
  })

  it('maps a rejected reorder input to save-failed with current (adapter branch)', async () => {
    const harness = createHarness()
    const taskId = await seedProjectAndTask(harness)

    const outcome = await harness.adapter.reorder({
      taskId,
      status: 'todo',
      toIndex: 0,
      operationId: '',
      expectedStatusRevision: 0,
    })

    expect(outcome).toMatchObject({
      ok: false,
      code: 'save-failed',
      current: { status: 'todo', statusVersion: 'ver1:0' },
    })
  })

  it('synthesises current for a failed reorder write', async () => {
    const harness = createHarness()
    await seedProject(harness)
    const taskId = await seedTask(harness, 'create-1', 'Task A')
    await seedTask(harness, 'create-2', 'Task B')
    harness.storageFaults.write = (table, key) =>
      table === AIKANBAN_TABLES.scopeState && key === scopeKey('project', 'ws-1')
        ? new Error('injected reorder write failure')
        : undefined

    const result = await harness.handler('task/reorder', reorderPayload(taskId, 'todo', 1, 'op-r1', 'ver1:0'), SIGNAL)

    const failure = failureOf(result)
    expect(failure.code).toBe('save-failed')
    expect(currentOf(failure)).toEqual({ status: 'todo', statusVersion: 'ver1:0' })
  })

  it('maps an unknown task to not-found', async () => {
    const harness = createHarness()

    const result = await harness.handler('task/reorder', reorderPayload('nope', 'todo', 0, 'op-r1', 'ver1:0'), SIGNAL)

    expect(failureOf(result).code).toBe('not-found')
  })

  it('maps a project missing from the workspace registry to unknown-project', async () => {
    const harness = createHarness()
    const taskId = await seedProjectAndTask(harness)
    harness.registry.remove('ws-1')

    const result = await harness.handler('task/reorder', reorderPayload(taskId, 'todo', 0, 'op-r1', 'ver1:0'), SIGNAL)

    expect(failureOf(result).code).toBe('unknown-project')
  })
})

/* ------------------------------------------------------------------ *
 * task/status.undo
 * ------------------------------------------------------------------ */

describe('task/status.undo: two identities, retries and §6.2 mappings', () => {
  it('undoes a status change using the snapshot credential and a fresh undo id', async () => {
    const harness = createHarness()
    const taskId = await seedProjectAndTask(harness)
    const changed = writeOf(await harness.handler('task/status.set', setPayload(taskId, 'doing', 'op-1', 'ver1:0'), SIGNAL))
    const credential = taskIn(changed.snapshot, taskId).undoTarget
    expect(credential).toEqual({ statusVersion: 'ver1:1', appliedUpdateId: 'op-1' })
    if (credential === null) throw new Error('expected an undo credential')

    const result = await harness.handler(
      'task/status.undo',
      undoPayload(taskId, 'undo-1', credential.statusVersion, credential.appliedUpdateId),
      SIGNAL,
    )

    const { snapshot, undoable } = writeOf(result)
    // After an undo the current status is itself an undo, so there is nothing left to undo.
    expect(undoable).toBe(false)
    const task = taskIn(snapshot, taskId)
    expect(task.status).toBe('todo')
    expect(task.statusRevision).toBe(2)
    expect(task.undoTarget).toBeNull()
    expect(harness.core.readTask({ taskId })?.status).toBe('todo')
  })

  it('treats a retried undo id as already in effect, not as a lost race', async () => {
    const harness = createHarness()
    const taskId = await seedProjectAndTask(harness)
    await harness.handler('task/status.set', setPayload(taskId, 'doing', 'op-1', 'ver1:0'), SIGNAL)
    const payload = undoPayload(taskId, 'undo-1', 'ver1:1', 'op-1')
    expect((await harness.handler('task/status.undo', payload, SIGNAL)).ok).toBe(true)

    const retried = await harness.handler('task/status.undo', payload, SIGNAL)

    const { snapshot, undoable } = writeOf(retried)
    expect(undoable).toBe(false)
    expect(taskIn(snapshot, taskId).statusRevision).toBe(2)
    expect(harness.core.readTask({ taskId })?.statusRevision).toBe(2)
  })

  it('refuses a superseded undo with stale-baseline + current', async () => {
    const harness = createHarness()
    const taskId = await seedProjectAndTask(harness)
    await harness.handler('task/status.set', setPayload(taskId, 'doing', 'op-1', 'ver1:0'), SIGNAL)
    await harness.handler('task/status.set', setPayload(taskId, 'done', 'op-2', 'ver1:1'), SIGNAL)

    // The credential names op-1, but op-2 is the latest transition.
    const result = await harness.handler('task/status.undo', undoPayload(taskId, 'undo-2', 'ver1:2', 'op-1'), SIGNAL)

    const failure = failureOf(result)
    expect(failure.code).toBe('stale-baseline')
    expect(currentOf(failure)).toEqual({ status: 'done', statusVersion: 'ver1:2' })
  })

  it('refuses nothing-to-undo with stale-baseline + current', async () => {
    const harness = createHarness()
    const taskId = await seedProjectAndTask(harness)

    const result = await harness.handler('task/status.undo', undoPayload(taskId, 'undo-1', 'ver1:0', 'op-none'), SIGNAL)

    const failure = failureOf(result)
    expect(failure.code).toBe('stale-baseline')
    expect(currentOf(failure)).toEqual({ status: 'todo', statusVersion: 'ver1:0' })
  })

  it('maps an unknown task to not-found', async () => {
    const harness = createHarness()

    const result = await harness.handler('task/status.undo', undoPayload('nope', 'undo-1', 'ver1:0', 'op-x'), SIGNAL)

    expect(failureOf(result).code).toBe('not-found')
  })

  it('maps a rejected undo input to save-failed with current (adapter branch)', async () => {
    const harness = createHarness()
    const taskId = await seedProjectAndTask(harness)

    const outcome = await harness.adapter.undoStatusChange({
      taskId,
      operationId: '',
      expectedStatusRevision: 0,
      appliedUpdateId: 'op-x',
    })

    expect(outcome).toMatchObject({
      ok: false,
      code: 'save-failed',
      current: { status: 'todo', statusVersion: 'ver1:0' },
    })
  })

  it('synthesises current for a failed undo write', async () => {
    const harness = createHarness()
    const taskId = await seedProjectAndTask(harness)
    await harness.handler('task/status.set', setPayload(taskId, 'doing', 'op-1', 'ver1:0'), SIGNAL)
    harness.storageFaults.write = (table, key) =>
      table === AIKANBAN_TABLES.scopeState && key === scopeKey('task', taskId)
        ? new Error('injected undo write failure')
        : undefined

    const result = await harness.handler('task/status.undo', undoPayload(taskId, 'undo-1', 'ver1:1', 'op-1'), SIGNAL)

    const failure = failureOf(result)
    expect(failure.code).toBe('save-failed')
    expect(currentOf(failure)).toEqual({ status: 'doing', statusVersion: 'ver1:1' })
    expect(harness.core.readTask({ taskId })?.status).toBe('doing')
  })
})

/* ------------------------------------------------------------------ *
 * Post-write re-read failure (§6.2 rule 1, F3)
 * ------------------------------------------------------------------ */

describe('post-write re-read failure: classify by whether the write landed', () => {
  it('saved + re-read failure → unknown-result without a snapshot ("已保存、视图未刷新")', async () => {
    const harness = createHarness({ armAfterWrite: true })
    const taskId = await seedProjectAndTask(harness)

    const result = await harness.handler('task/status.set', setPayload(taskId, 'doing', 'op-1', 'ver1:0'), SIGNAL)

    const failure = failureOf(result)
    expect(failure.code).toBe('unknown-result')
    expect(failure.message).toContain('已保存、视图未刷新')
    expect(failure.message).not.toContain('未做任何修改')
    expect(failure.details).toEqual({})
    // The write really landed; only the view refresh failed.
    expect(harness.core.readTask({ taskId })?.status).toBe('doing')
  })

  it('already-applied + re-read failure → unknown-result', async () => {
    const harness = createHarness()
    const taskId = await seedProjectAndTask(harness)
    expect((await harness.handler('task/status.set', setPayload(taskId, 'doing', 'op-1', 'ver1:0'), SIGNAL)).ok).toBe(true)
    harness.faults.armAfterWrite = true

    const result = await harness.handler('task/status.set', setPayload(taskId, 'doing', 'op-1', 'ver1:0'), SIGNAL)

    const failure = failureOf(result)
    expect(failure.code).toBe('unknown-result')
    expect(failure.message).toContain('已保存、视图未刷新')
    expect(harness.core.readTask({ taskId })?.statusRevision).toBe(1)
  })

  it('undone + re-read failure → unknown-result with "撤销已生效、视图未刷新"', async () => {
    const harness = createHarness()
    const taskId = await seedProjectAndTask(harness)
    expect((await harness.handler('task/status.set', setPayload(taskId, 'doing', 'op-1', 'ver1:0'), SIGNAL)).ok).toBe(true)
    harness.faults.armAfterWrite = true

    const result = await harness.handler('task/status.undo', undoPayload(taskId, 'undo-1', 'ver1:1', 'op-1'), SIGNAL)

    const failure = failureOf(result)
    // F3: must never be read-failed ("nothing changed") — the undo DID land.
    expect(failure.code).toBe('unknown-result')
    expect(failure.message).toContain('撤销已生效、视图未刷新')
    expect(harness.core.readTask({ taskId })?.status).toBe('todo')
  })

  it('no-change + re-read failure → read-failed', async () => {
    const harness = createHarness()
    const taskId = await seedProjectAndTask(harness)
    expect((await harness.handler('task/status.set', setPayload(taskId, 'doing', 'op-1', 'ver1:0'), SIGNAL)).ok).toBe(true)
    harness.faults.armAfterWrite = true

    const result = await harness.handler('task/status.set', setPayload(taskId, 'doing', 'op-2', 'ver1:1'), SIGNAL)

    const failure = failureOf(result)
    expect(failure.code).toBe('read-failed')
    expect(failure.message).toContain('没有改变正式值')
    expect(harness.core.readTask({ taskId })?.status).toBe('doing')
  })

  it('reorder saved + re-read failure → unknown-result', async () => {
    const harness = createHarness({ armAfterWrite: true })
    await seedProject(harness)
    const taskId = await seedTask(harness, 'create-1', 'Task A')
    await seedTask(harness, 'create-2', 'Task B')

    const result = await harness.handler('task/reorder', reorderPayload(taskId, 'todo', 1, 'op-r1', 'ver1:0'), SIGNAL)

    expect(failureOf(result).code).toBe('unknown-result')
  })
})

/* ------------------------------------------------------------------ *
 * The handler never throws (§6: 适配层/handler 不得抛)
 * ------------------------------------------------------------------ */

describe('the board channel handler never throws', () => {
  it('answers malformed payloads with protocol failures and writes nothing', async () => {
    const harness = createHarness()
    const taskId = await seedProjectAndTask(harness)
    const cases: { endpoint: string; payload: unknown; code: string }[] = [
      { endpoint: 'board/read', payload: {}, code: 'invalid-payload' },
      { endpoint: 'board/read', payload: { projectId: '' }, code: 'invalid-payload' },
      { endpoint: 'task/status.set', payload: { taskId: '', next: 'doing', operationId: 'op', expectedStatusVersion: 'ver1:0' }, code: 'invalid-payload' },
      { endpoint: 'task/status.set', payload: null, code: 'invalid-payload' },
      { endpoint: 'task/status.set', payload: { taskId, next: 'blocked', operationId: 'op', reason: '   ', expectedStatusVersion: 'ver1:0' }, code: 'invalid-reason' },
      { endpoint: 'task/status.set', payload: { taskId, next: 'doing', operationId: 'op', expectedStatusVersion: 'ver1:01' }, code: 'invalid-payload' },
      { endpoint: 'task/reorder', payload: { taskId, status: 'todo', operationId: 'op', expectedStatusVersion: 'ver1:0' }, code: 'invalid-payload' },
      { endpoint: 'task/reorder', payload: { taskId, status: 'todo', toIndex: -1, operationId: 'op', expectedStatusVersion: 'ver1:0' }, code: 'invalid-payload' },
      { endpoint: 'task/status.undo', payload: { taskId, operationId: 'op', expectedStatusVersion: 'ver1:0' }, code: 'invalid-payload' },
      { endpoint: 'board/nope', payload: {}, code: 'unknown-endpoint' },
      { endpoint: 'board/read', payload: 42, code: 'invalid-payload' },
    ]

    for (const { endpoint, payload, code } of cases) {
      const result = await harness.handler(endpoint, payload, SIGNAL)
      expect(result.ok, `${endpoint} accepted malformed payload ${JSON.stringify(payload)}`).toBe(false)
      expect(failureOf(result).code, `${endpoint} ${JSON.stringify(payload)}`).toBe(code)
    }

    // Nothing was written by any of the malformed calls.
    const stored = harness.core.readTask({ taskId })
    expect(stored?.status).toBe('todo')
    expect(stored?.statusRevision).toBe(0)
  })

  it('turns a throwing data layer into unknown-result without throwing the handler', async () => {
    const harness = createHarness()
    const throwing: HostBoardPort = {
      ...harness.adapter,
      setStatus: async () => { throw new Error('port exploded') },
    }
    const handler = createBoardChannelHandler(throwing)

    const result = await handler('task/status.set', setPayload('t1', 'doing', 'op-1', 'ver1:0'), SIGNAL)

    expect(failureOf(result).code).toBe('unknown-result')
    expect(failureOf(result).message).toContain('结果未知')
  })
})

/* ------------------------------------------------------------------ *
 * Delayed-ready wrapper (host.test.ts owns the apply() path; this pins the seam)
 * ------------------------------------------------------------------ */

describe('the delayed-ready wrapper', () => {
  it('answers unavailable before the data layer and forwards to the adapter afterwards', async () => {
    const harness = createHarness()
    const state = { ready: false, reason: null as string | null }
    const delayed = createDelayedBoardPort(
      { coreReady: () => state.ready, failureReason: () => state.reason },
      harness.adapter,
    )
    const handler = createBoardChannelHandler(delayed)
    await seedProjectAndTask(harness)

    const before = await handler('board/read', { projectId: 'ws-1' }, SIGNAL)
    expect(failureOf(before).code).toBe('unavailable')
    const writeBefore = await handler('task/status.set', setPayload('t1', 'doing', 'op-1', 'ver1:0'), SIGNAL)
    expect(failureOf(writeBefore).code).toBe('unavailable')

    state.ready = true
    const after = snapshotOf(successOf(await handler('board/read', { projectId: 'ws-1' }, SIGNAL)))
    expect(after.project.projectId).toBe('ws-1')
    expect(after.tasks).toHaveLength(1)
  })
})
