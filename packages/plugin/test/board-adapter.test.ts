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
  taskIdOf,
  type KanbanCore,
  type StoragePort,
} from '@aikanban/core'
import {
  parseBoardSnapshotValue,
  parseSummaryDraftSaveValue,
  parseSummaryReadValue,
  parseSummarySaveFailureDetails,
  parseSummarySaveValue,
  type SummaryDraftSaveValue,
  type SummarySaveValue,
  type SummaryViewValue,
} from '@aikanban/plugin-client/wire'

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

/** Parse a `task/create` success value through the wire parser's snapshot guard. */
function createValueOf(result: BoardRpcResult): {
  outcome: string
  task: SnapshotTask
  snapshot: Snapshot | null
} {
  const raw = successOf(result) as { outcome?: unknown; task?: unknown; snapshot?: unknown }
  if (typeof raw.outcome !== 'string') throw new Error('a create success must carry an outcome')
  if (raw.task === null || typeof raw.task !== 'object') throw new Error('a create success must carry the task')
  const task = { ...(raw.task as SnapshotTask) }
  const snapshot = raw.snapshot === null ? null : snapshotOf(raw.snapshot)
  return { outcome: raw.outcome, task, snapshot }
}

/** Parse a `task/fields.update` success value through the wire parser's snapshot guard. */
function updateValueOf(result: BoardRpcResult): {
  outcome: string
  task: SnapshotTask
  changed: readonly string[]
  fieldsRevision: number
  snapshot: Snapshot | null
} {
  const raw = successOf(result) as {
    outcome?: unknown
    task?: unknown
    changed?: unknown
    fieldsRevision?: unknown
    snapshot?: unknown
  }
  if (typeof raw.outcome !== 'string') throw new Error('an update success must carry an outcome')
  if (raw.task === null || typeof raw.task !== 'object') throw new Error('an update success must carry the task')
  if (!Array.isArray(raw.changed)) throw new Error('an update success must carry the changed list')
  if (typeof raw.fieldsRevision !== 'number') throw new Error('an update success must carry a numeric fieldsRevision')
  const snapshot = raw.snapshot === null ? null : snapshotOf(raw.snapshot)
  return {
    outcome: raw.outcome,
    task: { ...(raw.task as SnapshotTask) },
    changed: raw.changed as readonly string[],
    fieldsRevision: raw.fieldsRevision,
    snapshot,
  }
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

const WRITE_METHODS = new Set<string>(['setTaskStatus', 'reorderTask', 'undoStatusChange', 'createTask', 'updateTaskFields'])

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

function createPayload(
  projectId: string,
  requestId: string,
  title: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { projectId, requestId, title, ...extra }
}

function fieldsPayload(
  taskId: string,
  requestId: string,
  expectedFieldsVersion: string,
  expectedStatusVersion: string,
  fields: Record<string, unknown> = {},
): Record<string, unknown> {
  return { taskId, requestId, expectedFieldsVersion, expectedStatusVersion, ...fields }
}

interface ActivityEntryBody {
  readonly activityId: string
  readonly at: string
  readonly scopeKind: 'task' | 'project'
  readonly scopeId: string
  readonly code: string
  readonly summary: string
  readonly details: Record<string, string>
}

/** The handler's `activity/read` value, parsed through the wire guards indirectly. */
function activityOf(result: BoardRpcResult): readonly ActivityEntryBody[] {
  const raw = successOf(result) as { entries?: unknown }
  if (!Array.isArray(raw.entries)) throw new Error('activity/read success must carry an entries array')
  return raw.entries as readonly ActivityEntryBody[]
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
 * project/list — host registry candidate set (Q1=B, no "current project")
 * ------------------------------------------------------------------ */

describe('project/list: the host registry is the candidate set, never a selection', () => {
  it('lists every workspace with the read-compatible id, title and path', async () => {
    const harness = createHarness()
    // Same title, different directory: path is what tells them apart.
    harness.registry.add('ws-2', { title: 'Demo project', path: 'D:/work/demo', statusMode: 'missing-dir' })

    const result = await harness.handler('project/list', {}, SIGNAL)
    const value = successOf(result) as { projects: { projectId: string; title: string; path: string }[] }

    expect(value.projects).toEqual([
      { projectId: 'ws-1', title: 'Demo project', path: 'C:/demo' },
      { projectId: 'ws-2', title: 'Demo project', path: 'D:/work/demo' },
    ])
    // Q1=B: an item carries exactly the id/title/path — no "current", "default"
    // or "last used" flag could be smuggled through.
    for (const project of value.projects) {
      expect(Object.keys(project).sort()).toEqual(['path', 'projectId', 'title'])
    }
    // The id is the one board/read accepts: the very same registry key.
    const read = await harness.handler('board/read', { projectId: value.projects[1]?.projectId }, SIGNAL)
    expect(read.ok).toBe(true)
  })

  it('registers, reads and writes nothing: listing is not an implicit selection', async () => {
    const harness = createHarness()

    const result = await harness.handler('project/list', {}, SIGNAL)

    expect(result.ok).toBe(true)
    // Core still knows no project: nobody registered ws-1 by listing it, and a
    // later read without a selection is still refused rather than defaulted.
    expect(harness.core.listProjects()).toEqual([])
    expect(harness.core.readBoard({ projectId: 'ws-1', workScope: { availability: 'ok' } }).status).toBe('unknown-project')
  })

  it('treats an empty registry as a legal empty candidate set, not as an error', async () => {
    const harness = createHarness({ project: false })

    const result = await harness.handler('project/list', {}, SIGNAL)
    const value = successOf(result) as { projects: unknown[] }

    expect(value.projects).toEqual([])
  })

  it('maps a missing registry to unavailable and an exploding registry to read-failed, never throwing', async () => {
    const noRegistry = createHarness({ registry: false })
    const unavailable = await noRegistry.handler('project/list', {}, SIGNAL)
    expect(failureOf(unavailable).code).toBe('unavailable')
    expect(failureOf(unavailable).message).toContain('workspaceRegistry')

    const harness = createHarness()
    const exploding = createHostBoardPort({
      core: () => harness.core,
      workspaceRegistry: () => ({
        get: () => undefined,
        list: () => { throw new Error('injected registry failure') },
      }),
    })
    const result = await createBoardChannelHandler(exploding)('project/list', {}, SIGNAL)
    expect(failureOf(result).code).toBe('read-failed')
    expect(failureOf(result).message).toContain('injected registry failure')
  })

  it('refuses a non-object payload before the registry is touched', async () => {
    const harness = createHarness()
    let listings = 0
    const adapter = createHostBoardPort({
      core: () => harness.core,
      workspaceRegistry: () => ({
        get: (id: string) => harness.registry.registry.get(id),
        list: () => { listings += 1; return harness.registry.registry.list() },
      }),
    })
    const handler = createBoardChannelHandler(adapter)

    for (const payload of [null, undefined, [], 'project/list', 5]) {
      const result = await handler('project/list', payload, SIGNAL)
      expect(failureOf(result).code, `payload ${JSON.stringify(payload)}`).toBe('invalid-payload')
    }
    // §1.2: the payload guard runs before the port; no listing was attempted.
    expect(listings).toBe(0)
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
 * task/create (slice B, F01-R02/R03, REC-02)
 * ------------------------------------------------------------------ */

describe('task/create: idempotent creation over the real core', () => {
  it('registers the project first, creates the task and returns the re-read snapshot', async () => {
    const harness = createHarness()
    // Core knows no project yet: creation must register it before writing.
    expect(harness.core.listProjects()).toEqual([])

    const result = await harness.handler(
      'task/create',
      createPayload('ws-1', 'create-1', '任务 A', { goal: '把 S1 接通' }),
      SIGNAL,
    )

    const value = createValueOf(result)
    expect(value.outcome).toBe('created')
    expect(value.snapshot).not.toBeNull()
    const snapshot = value.snapshot as Snapshot
    expect(snapshot.tasks).toHaveLength(1)
    expect(value.task.taskId).toBe(taskIdOf({ projectId: 'ws-1', requestId: 'create-1' }))
    expect(value.task).toMatchObject({
      projectId: 'ws-1',
      title: '任务 A',
      goal: '把 S1 接通',
      status: 'todo',
      fieldsRevision: 0,
      statusRevision: 0,
      undoTarget: null,
      archived: false,
    })
    // The creation is durable, not just reported.
    expect(harness.core.readTask({ taskId: value.task.taskId })?.title).toBe('任务 A')
    expect(harness.core.listProjects().map((project) => project.projectId)).toEqual(['ws-1'])
  })

  it('honours initialStatus/blockedReason and lets core record the blocked state', async () => {
    const harness = createHarness()

    const result = await harness.handler(
      'task/create',
      createPayload('ws-1', 'create-blocked', '阻塞任务', { initialStatus: 'blocked', blockedReason: '等待确认' }),
      SIGNAL,
    )

    const value = createValueOf(result)
    expect(value.task.status).toBe('blocked')
    expect(value.task.blockedReason).toBe('等待确认')
    const stored = harness.core.readTask({ taskId: value.task.taskId })
    expect(stored?.status).toBe('blocked')
    expect(stored?.blockedReason).toBe('等待确认')
  })

  it('treats a replayed creation as already-created instead of a second task', async () => {
    const harness = createHarness()
    const payload = createPayload('ws-1', 'create-1', '任务 A')

    const first = createValueOf(await harness.handler('task/create', payload, SIGNAL))
    const second = createValueOf(await harness.handler('task/create', payload, SIGNAL))

    expect(first.outcome).toBe('created')
    expect(second.outcome).toBe('already-created')
    expect(second.task.taskId).toBe(first.task.taskId)
    expect(second.snapshot?.tasks).toHaveLength(1)
    const board = harness.core.readBoard({ projectId: 'ws-1', workScope: { availability: 'ok' } })
    expect(board.status === 'ok' ? board.tasks : []).toHaveLength(1)
    // One creation means one history entry, not two (REC-02).
    const entries = activityOf(await harness.handler('activity/read', { scopeKind: 'task', scopeId: first.task.taskId }, SIGNAL))
    expect(entries.filter((entry) => entry.code === 'task-created')).toHaveLength(1)
  })

  it('refuses a blank title as invalid-input and echoes the typed input', async () => {
    const harness = createHarness()

    const result = await harness.handler('task/create', createPayload('ws-1', 'create-bad', '   '), SIGNAL)

    const failure = failureOf(result)
    expect(failure.code).toBe('invalid-input')
    expect(failure.details['keptInput']).toEqual({
      title: '   ',
      goal: '',
      initialStatus: 'todo',
      blockedReason: null,
    })
    // Nothing was created; there is no half-finished task.
    const board = harness.core.readBoard({ projectId: 'ws-1', workScope: { availability: 'ok' } })
    expect(board.status === 'ok' ? board.tasks : []).toEqual([])
  })

  it('keeps invalid-reason for a blocked creation without a reason', async () => {
    const harness = createHarness()

    const result = await harness.handler(
      'task/create',
      createPayload('ws-1', 'create-blocked', '阻塞任务', { initialStatus: 'blocked', blockedReason: '  ' }),
      SIGNAL,
    )

    const failure = failureOf(result)
    expect(failure.code).toBe('invalid-reason')
    expect(failure.details['keptInput']).toMatchObject({ initialStatus: 'blocked' })
  })

  it('maps an unknown initial status to invalid-input with the echo', async () => {
    const harness = createHarness()

    const result = await harness.handler(
      'task/create',
      createPayload('ws-1', 'create-status', '任务', { initialStatus: 'archived' }),
      SIGNAL,
    )

    const failure = failureOf(result)
    expect(failure.code).toBe('invalid-input')
    expect(failure.details['keptInput']).toMatchObject({ initialStatus: 'archived' })
  })

  it('reports an unregistered project as unknown-project and creates nothing', async () => {
    const harness = createHarness()

    const result = await harness.handler('task/create', createPayload('ws-missing', 'create-1', '任务'), SIGNAL)

    expect(failureOf(result).code).toBe('unknown-project')
    expect(harness.core.listProjects()).toEqual([])
  })

  it('answers created + re-read failure with the task and a null snapshot, never an empty board', async () => {
    const harness = createHarness({ armAfterWrite: true })

    const result = await harness.handler('task/create', createPayload('ws-1', 'create-1', '任务 A'), SIGNAL)

    // The result is KNOWN (created); only the view refresh failed. This must not
    // be disguised as a failed creation (REC-01).
    const value = createValueOf(result)
    expect(value.outcome).toBe('created')
    expect(value.snapshot).toBeNull()
    expect(harness.core.readTask({ taskId: value.task.taskId })?.title).toBe('任务 A')
  })

  it('maps a failed creation write to save-failed with the echoed input, never success', async () => {
    const harness = createHarness()
    const taskId = taskIdOf({ projectId: 'ws-1', requestId: 'create-fail' })
    harness.storageFaults.write = (table, key) =>
      table === AIKANBAN_TABLES.scopeState && key === scopeKey('task', taskId)
        ? new Error('injected create write failure')
        : undefined

    const result = await harness.handler('task/create', createPayload('ws-1', 'create-fail', '任务'), SIGNAL)

    const failure = failureOf(result)
    expect(failure.code).toBe('save-failed')
    expect(failure.details['taskId']).toBe(taskId)
    expect(failure.details['keptInput']).toMatchObject({ title: '任务' })
    expect(harness.core.readTask({ taskId })).toBeNull()
  })

  it('refuses a payload without an address before any project is resolved', async () => {
    const harness = createHarness()

    for (const payload of [{}, null, { projectId: 'ws-1', requestId: 'op', title: 5 }]) {
      const result = await harness.handler('task/create', payload, SIGNAL)
      expect(failureOf(result).code, `payload ${JSON.stringify(payload)}`).toBe('invalid-payload')
    }
    expect(harness.core.listProjects()).toEqual([])
  })
})

/* ------------------------------------------------------------------ *
 * task/fields.update (slice B, F01-R05/R06, SAVE-05)
 * ------------------------------------------------------------------ */

describe('task/fields.update: baselines, outcomes and echoes', () => {
  it('saves title and goal under the current baselines and returns the re-read snapshot', async () => {
    const harness = createHarness()
    const taskId = await seedProjectAndTask(harness)

    const result = await harness.handler(
      'task/fields.update',
      fieldsPayload(taskId, 'field-1', 'fver1:0', 'ver1:0', { title: '新标题', goal: '新目标' }),
      SIGNAL,
    )

    const value = updateValueOf(result)
    expect(value.outcome).toBe('saved')
    expect(value.changed).toEqual(['title', 'goal'])
    expect(value.fieldsRevision).toBe(1)
    expect(value.snapshot).not.toBeNull()
    expect(taskIn(value.snapshot as Snapshot, taskId)).toMatchObject({ title: '新标题', goal: '新目标' })
    // Durable: the stored task carries the new fields and the advanced revision.
    const stored = harness.core.readTask({ taskId })
    expect(stored?.title).toBe('新标题')
    expect(stored?.goal).toBe('新目标')
    expect(stored?.fieldsRevision).toBe(1)
  })

  it('clears the goal with goal=null (F01: a goal may be cleared)', async () => {
    const harness = createHarness()
    await seedProject(harness)
    const created = await harness.core.createTask({
      projectId: 'ws-1',
      requestId: 'create-1',
      title: '任务',
      goal: '旧目标',
    })
    if (created.status === 'rejected' || created.status === 'failed') throw new Error('seed create failed')

    const result = await harness.handler(
      'task/fields.update',
      fieldsPayload(created.taskId, 'field-clear', 'fver1:0', 'ver1:0', { goal: null }),
      SIGNAL,
    )

    const value = updateValueOf(result)
    expect(value.outcome).toBe('saved')
    expect(value.changed).toEqual(['goal'])
    expect(value.task.goal).toBe('')
    expect(harness.core.readTask({ taskId: created.taskId })?.goal).toBe('')
  })

  it('reports no-change for an unchanged title, without bumping the revision', async () => {
    const harness = createHarness()
    const taskId = await seedProjectAndTask(harness)

    const result = await harness.handler(
      'task/fields.update',
      fieldsPayload(taskId, 'field-noop', 'fver1:0', 'ver1:0', { title: 'Task A' }),
      SIGNAL,
    )

    const value = updateValueOf(result)
    expect(value.outcome).toBe('no-change')
    expect(value.changed).toEqual([])
    expect(value.fieldsRevision).toBe(0)
    expect(harness.core.readTask({ taskId })?.fieldsRevision).toBe(0)
  })

  it('treats a replayed save id as already-applied, not as a second change', async () => {
    const harness = createHarness()
    const taskId = await seedProjectAndTask(harness)
    const payload = fieldsPayload(taskId, 'field-1', 'fver1:0', 'ver1:0', { title: '新标题' })

    expect((await harness.handler('task/fields.update', payload, SIGNAL)).ok).toBe(true)
    const retried = updateValueOf(await harness.handler('task/fields.update', payload, SIGNAL))

    expect(retried.outcome).toBe('already-applied')
    expect(retried.changed).toEqual([])
    expect(retried.fieldsRevision).toBe(1)
    expect(harness.core.readTask({ taskId })?.fieldsRevision).toBe(1)
  })

  it('refuses a stale fields baseline with stale-baseline + current + expected/actual baselines', async () => {
    const harness = createHarness()
    const taskId = await seedProjectAndTask(harness)
    expect((await harness.handler(
      'task/fields.update',
      fieldsPayload(taskId, 'field-1', 'fver1:0', 'ver1:0', { title: '第一次' }),
      SIGNAL,
    )).ok).toBe(true)

    // A second editor still holds the old fields baseline.
    const result = await harness.handler(
      'task/fields.update',
      fieldsPayload(taskId, 'field-2', 'fver1:0', 'ver1:0', { title: '第二次' }),
      SIGNAL,
    )

    const failure = failureOf(result)
    expect(failure.code).toBe('stale-baseline')
    expect(currentOf(failure)).toEqual({ status: 'todo', statusVersion: 'ver1:0' })
    expect(failure.details['baseline']).toEqual({
      expected: { fieldsVersion: 'fver1:0', statusVersion: 'ver1:0' },
      actual: { fieldsVersion: 'fver1:1', statusVersion: 'ver1:0' },
    })
    expect(failure.details['keptInput']).toEqual({ title: '第二次', goal: null })
    // REC-01: the stale save did not overwrite anything.
    expect(harness.core.readTask({ taskId })?.title).toBe('第一次')
    expect(harness.core.readTask({ taskId })?.fieldsRevision).toBe(1)
  })

  it('also refuses when only the status baseline moved underneath the editor', async () => {
    const harness = createHarness()
    const taskId = await seedProjectAndTask(harness)
    expect((await harness.handler('task/status.set', setPayload(taskId, 'doing', 'op-1', 'ver1:0'), SIGNAL)).ok).toBe(true)

    const result = await harness.handler(
      'task/fields.update',
      fieldsPayload(taskId, 'field-1', 'fver1:0', 'ver1:0', { title: '新标题' }),
      SIGNAL,
    )

    const failure = failureOf(result)
    expect(failure.code).toBe('stale-baseline')
    expect(currentOf(failure)).toEqual({ status: 'doing', statusVersion: 'ver1:1' })
    expect((failure.details['baseline'] as { actual: unknown }).actual).toEqual({
      fieldsVersion: 'fver1:0',
      statusVersion: 'ver1:1',
    })
  })

  it('refuses a blank title as invalid-input and keeps the echoed input', async () => {
    const harness = createHarness()
    const taskId = await seedProjectAndTask(harness)

    const result = await harness.handler(
      'task/fields.update',
      fieldsPayload(taskId, 'field-bad', 'fver1:0', 'ver1:0', { title: '   ' }),
      SIGNAL,
    )

    const failure = failureOf(result)
    expect(failure.code).toBe('invalid-input')
    expect(failure.details['keptInput']).toEqual({ title: '   ', goal: null })
    expect(harness.core.readTask({ taskId })?.fieldsRevision).toBe(0)
  })

  it('refuses "nothing to save" with invalid-input and an empty echo', async () => {
    const harness = createHarness()
    const taskId = await seedProjectAndTask(harness)

    const result = await harness.handler(
      'task/fields.update',
      fieldsPayload(taskId, 'field-empty', 'fver1:0', 'ver1:0'),
      SIGNAL,
    )

    const failure = failureOf(result)
    expect(failure.code).toBe('invalid-input')
    expect(failure.details['keptInput']).toEqual({ title: null, goal: null })
  })

  it('maps an unknown task to not-found', async () => {
    const harness = createHarness()

    const result = await harness.handler(
      'task/fields.update',
      fieldsPayload('missing', 'field-1', 'fver1:0', 'ver1:0', { title: 'X' }),
      SIGNAL,
    )

    expect(failureOf(result).code).toBe('not-found')
  })

  it('refuses missing/malformed fver1/ver1 baselines with invalid-payload before the port', async () => {
    const harness = createHarness()
    const taskId = await seedProjectAndTask(harness)
    let calls = 0
    const port: HostBoardPort = {
      ...harness.adapter,
      updateTaskFields: async () => {
        calls += 1
        return { ok: false, code: 'save-failed', message: 'the port must not be called' }
      },
    }
    const handler = createBoardChannelHandler(port)
    const cases: Record<string, unknown>[] = [
      { taskId, requestId: 'f', expectedStatusVersion: 'ver1:0', title: 'X' },
      { taskId, requestId: 'f', expectedFieldsVersion: 'fver1:01', expectedStatusVersion: 'ver1:0', title: 'X' },
      { taskId, requestId: 'f', expectedFieldsVersion: 'fver1:0', title: 'X' },
      { taskId, requestId: 'f', expectedFieldsVersion: 'fver1:0', expectedStatusVersion: 'ver1:-1', title: 'X' },
      { taskId, requestId: 'f', expectedFieldsVersion: '3', expectedStatusVersion: 'ver1:0', title: 'X' },
    ]
    for (const payload of cases) {
      const result = await handler('task/fields.update', payload, SIGNAL)
      expect(failureOf(result).code, `payload ${JSON.stringify(payload)}`).toBe('invalid-payload')
    }
    // F5/SAVE-05: a malformed baseline never reaches the data layer.
    expect(calls).toBe(0)
    expect(harness.core.readTask({ taskId })?.title).toBe('Task A')
  })

  it('maps a failed save to save-failed with current and the echoed input', async () => {
    const harness = createHarness()
    const taskId = await seedProjectAndTask(harness)
    harness.storageFaults.write = (table, key) =>
      table === AIKANBAN_TABLES.scopeState && key === scopeKey('task', taskId)
        ? new Error('injected field write failure')
        : undefined

    const result = await harness.handler(
      'task/fields.update',
      fieldsPayload(taskId, 'field-fail', 'fver1:0', 'ver1:0', { title: '新标题' }),
      SIGNAL,
    )

    const failure = failureOf(result)
    expect(failure.code).toBe('save-failed')
    expect(currentOf(failure)).toEqual({ status: 'todo', statusVersion: 'ver1:0' })
    expect(failure.details['keptInput']).toEqual({ title: '新标题', goal: null })
    expect(harness.core.readTask({ taskId })?.title).toBe('Task A')
  })

  it('answers saved + re-read failure with the task and a null snapshot', async () => {
    const harness = createHarness({ armAfterWrite: true })
    const taskId = await seedProjectAndTask(harness)

    const result = await harness.handler(
      'task/fields.update',
      fieldsPayload(taskId, 'field-1', 'fver1:0', 'ver1:0', { title: '新标题' }),
      SIGNAL,
    )

    const value = updateValueOf(result)
    expect(value.outcome).toBe('saved')
    expect(value.snapshot).toBeNull()
    expect(value.fieldsRevision).toBe(1)
    expect(harness.core.readTask({ taskId })?.title).toBe('新标题')
  })

  it('answers unavailable before the data layer is ready and forwards afterwards', async () => {
    const harness = createHarness()
    const state = { ready: false, reason: null as string | null }
    const delayed = createDelayedBoardPort(
      { coreReady: () => state.ready, failureReason: () => state.reason },
      harness.adapter,
    )
    const handler = createBoardChannelHandler(delayed)
    const taskId = await seedProjectAndTask(harness)

    const before = await handler(
      'task/fields.update',
      fieldsPayload(taskId, 'field-1', 'fver1:0', 'ver1:0', { title: 'X' }),
      SIGNAL,
    )
    expect(failureOf(before).code).toBe('unavailable')
    expect(harness.core.readTask({ taskId })?.title).toBe('Task A')

    state.ready = true
    const after = await handler(
      'task/fields.update',
      fieldsPayload(taskId, 'field-1', 'fver1:0', 'ver1:0', { title: 'X' }),
      SIGNAL,
    )
    expect(updateValueOf(after).outcome).toBe('saved')
  })
})

/* ------------------------------------------------------------------ *
 * activity/read (slice B, F01-R07/SAVE-08)
 * ------------------------------------------------------------------ */

describe('activity/read: newest first, scope isolation and empty legality', () => {
  it('returns a task scope newest first with string-only details', async () => {
    const harness = createHarness()
    const taskId = await seedProjectAndTask(harness)
    expect((await harness.handler('task/status.set', setPayload(taskId, 'doing', 'op-1', 'ver1:0'), SIGNAL)).ok).toBe(true)
    expect((await harness.handler(
      'task/fields.update',
      fieldsPayload(taskId, 'field-1', 'fver1:0', 'ver1:1', { title: '新标题' }),
      SIGNAL,
    )).ok).toBe(true)

    const entries = activityOf(await harness.handler('activity/read', { scopeKind: 'task', scopeId: taskId }, SIGNAL))

    expect(entries.map((entry) => entry.code)).toEqual(['task-title-changed', 'task-status-changed', 'task-created'])
    for (const entry of entries) {
      expect(entry.scopeKind).toBe('task')
      expect(entry.scopeId).toBe(taskId)
      expect(typeof entry.activityId).toBe('string')
      expect(entry.at.length).toBeGreaterThan(0)
      expect(typeof entry.summary).toBe('string')
      for (const value of Object.values(entry.details)) expect(typeof value).toBe('string')
    }
    expect(entries[1]?.details).toMatchObject({ from: 'todo', to: 'doing', requestId: 'op-1' })
  })

  it('honours limit (newest N) and treats unknown scopes as legal empty histories', async () => {
    const harness = createHarness()
    const taskId = await seedProjectAndTask(harness)
    await harness.handler('task/status.set', setPayload(taskId, 'doing', 'op-1', 'ver1:0'), SIGNAL)
    await harness.handler(
      'task/fields.update',
      fieldsPayload(taskId, 'field-1', 'fver1:0', 'ver1:1', { title: '新标题' }),
      SIGNAL,
    )

    const limited = activityOf(await harness.handler('activity/read', { scopeKind: 'task', scopeId: taskId, limit: 2 }, SIGNAL))
    expect(limited.map((entry) => entry.code)).toEqual(['task-title-changed', 'task-status-changed'])
    expect(activityOf(await harness.handler('activity/read', { scopeKind: 'task', scopeId: taskId, limit: 0 }, SIGNAL))).toEqual([])

    // An unknown task/project id is an empty history, not not-found and not an error.
    expect(activityOf(await harness.handler('activity/read', { scopeKind: 'task', scopeId: 'nope' }, SIGNAL))).toEqual([])
    expect(activityOf(await harness.handler('activity/read', { scopeKind: 'project', scopeId: 'nope' }, SIGNAL))).toEqual([])
  })

  it('keeps project and task histories separate', async () => {
    const harness = createHarness()
    const taskId = await seedProjectAndTask(harness)

    const projectEntries = activityOf(await harness.handler('activity/read', { scopeKind: 'project', scopeId: 'ws-1' }, SIGNAL))
    const taskEntries = activityOf(await harness.handler('activity/read', { scopeKind: 'task', scopeId: taskId }, SIGNAL))

    expect(projectEntries.map((entry) => entry.code)).toEqual(['project-registered'])
    expect(projectEntries[0]?.details).toMatchObject({ projectId: 'ws-1', path: 'C:/demo' })
    expect(taskEntries.map((entry) => entry.code)).toEqual(['task-created'])
    // No cross-contamination: a task's creation is not project history.
    expect(projectEntries.some((entry) => entry.code === 'task-created')).toBe(false)
  })

  it('refuses an invalid scope or limit at the handler with invalid-payload', async () => {
    const harness = createHarness()
    let reads = 0
    const port: HostBoardPort = {
      ...harness.adapter,
      readActivity: async () => {
        reads += 1
        return { ok: true, entries: [] }
      },
    }
    const handler = createBoardChannelHandler(port)
    const cases: Record<string, unknown>[] = [
      {},
      { scopeKind: 'board', scopeId: 'x' },
      { scopeKind: 'task', scopeId: '' },
      { scopeKind: 'task', scopeId: 'x', limit: -1 },
      { scopeKind: 'task', scopeId: 'x', limit: 1.5 },
    ]
    for (const payload of cases) {
      const result = await handler('activity/read', payload, SIGNAL)
      expect(failureOf(result).code, `payload ${JSON.stringify(payload)}`).toBe('invalid-payload')
    }
    expect(reads).toBe(0)
  })

  it('maps direct invalid scope/limit port calls to invalid-input (adapter branch)', async () => {
    const harness = createHarness()

    await expect(harness.adapter.readActivity({ scopeKind: 'board', scopeId: 'x' } as never)).resolves.toMatchObject({
      ok: false,
      code: 'invalid-input',
    })
    await expect(harness.adapter.readActivity({ scopeKind: 'task', scopeId: '' })).resolves.toMatchObject({
      ok: false,
      code: 'invalid-input',
    })
    await expect(harness.adapter.readActivity({ scopeKind: 'task', scopeId: 'x', limit: -2 })).resolves.toMatchObject({
      ok: false,
      code: 'invalid-input',
    })
  })

  it('turns a throwing data layer into read-failed without throwing the handler', async () => {
    const harness = createHarness()
    const throwing: HostBoardPort = {
      ...harness.adapter,
      readActivity: async () => { throw new Error('activity store exploded') },
    }
    const handler = createBoardChannelHandler(throwing)

    const result = await handler('activity/read', { scopeKind: 'task', scopeId: 'task-1' }, SIGNAL)

    const failure = failureOf(result)
    expect(failure.code).toBe('read-failed')
    expect(failure.message).toContain('activity store exploded')
  })

  it('answers unavailable before the data layer is ready and forwards afterwards', async () => {
    const harness = createHarness()
    const state = { ready: false, reason: 'domain not opened' }
    const delayed = createDelayedBoardPort(
      { coreReady: () => state.ready, failureReason: () => state.reason },
      harness.adapter,
    )
    const handler = createBoardChannelHandler(delayed)
    const taskId = await seedProjectAndTask(harness)

    const before = await handler('activity/read', { scopeKind: 'task', scopeId: taskId }, SIGNAL)
    expect(failureOf(before).code).toBe('unavailable')
    expect(failureOf(before).message).toContain('domain not opened')

    state.ready = true
    const after = activityOf(await handler('activity/read', { scopeKind: 'task', scopeId: taskId }, SIGNAL))
    expect(after.map((entry) => entry.code)).toEqual(['task-created'])
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
      // Slice B: the payload guards of the three management endpoints run
      // before the port, so none of these may write or throw.
      { endpoint: 'task/create', payload: {}, code: 'invalid-payload' },
      { endpoint: 'task/create', payload: null, code: 'invalid-payload' },
      { endpoint: 'task/create', payload: { projectId: 'ws-1', requestId: 'r', title: 5 }, code: 'invalid-payload' },
      { endpoint: 'task/fields.update', payload: { taskId, requestId: 'r', expectedFieldsVersion: 'fver1:0' }, code: 'invalid-payload' },
      { endpoint: 'task/fields.update', payload: { taskId, requestId: 'r', expectedFieldsVersion: 'fver1:0', expectedStatusVersion: 'ver1:0', title: null }, code: 'invalid-payload' },
      { endpoint: 'task/fields.update', payload: { taskId, requestId: 'r', expectedFieldsVersion: 'fver1:01', expectedStatusVersion: 'ver1:0' }, code: 'invalid-payload' },
      { endpoint: 'task/fields.update', payload: { taskId, requestId: 'r', expectedFieldsVersion: 'fver1:0', expectedStatusVersion: 'ver1:-1' }, code: 'invalid-payload' },
      { endpoint: 'activity/read', payload: { scopeKind: 'board', scopeId: 'x' }, code: 'invalid-payload' },
      { endpoint: 'activity/read', payload: { scopeKind: 'task', scopeId: '' }, code: 'invalid-payload' },
      { endpoint: 'activity/read', payload: { scopeKind: 'task', scopeId: taskId, limit: -1 }, code: 'invalid-payload' },
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
    const seededTaskId = await seedProjectAndTask(harness)

    const before = await handler('board/read', { projectId: 'ws-1' }, SIGNAL)
    expect(failureOf(before).code).toBe('unavailable')
    const writeBefore = await handler('task/status.set', setPayload('t1', 'doing', 'op-1', 'ver1:0'), SIGNAL)
    expect(failureOf(writeBefore).code).toBe('unavailable')
    const createBefore = await handler('task/create', createPayload('ws-1', 'create-delayed', 'Delayed'), SIGNAL)
    expect(failureOf(createBefore).code).toBe('unavailable')
    const activityBefore = await handler('activity/read', { scopeKind: 'task', scopeId: seededTaskId }, SIGNAL)
    expect(failureOf(activityBefore).code).toBe('unavailable')

    state.ready = true
    const after = snapshotOf(successOf(await handler('board/read', { projectId: 'ws-1' }, SIGNAL)))
    expect(after.project.projectId).toBe('ws-1')
    expect(after.tasks).toHaveLength(1)
    const created = createValueOf(await handler('task/create', createPayload('ws-1', 'create-delayed', 'Delayed'), SIGNAL))
    expect(created.outcome).toBe('created')
    expect(activityOf(await handler('activity/read', { scopeKind: 'task', scopeId: seededTaskId }, SIGNAL)).length).toBeGreaterThan(0)
  })
})

/* ------------------------------------------------------------------ *
 * F03 manual summaries and project overviews
 *
 * The same harness as above: the REAL core, the REAL adapter and the REAL
 * handler. The wire parser judges every success payload, so these tests also
 * prove the browser-facing contract is well-formed.
 * ------------------------------------------------------------------ */

function summaryContent(body: string): { sections: readonly { id: string; title: string; body: string }[] } {
  return { sections: [{ id: 'progress', title: '进展', body }] }
}

function summaryReadOf(result: BoardRpcResult): SummaryViewValue | null {
  const parsed = parseSummaryReadValue(successOf(result))
  if (parsed === null) throw new Error('the host returned a summary/read value the wire parser rejects')
  return parsed.summary
}

function summarySaveOf(result: BoardRpcResult): SummarySaveValue {
  const parsed = parseSummarySaveValue(successOf(result))
  if (parsed === null) throw new Error('the host returned a summary/save value the wire parser rejects')
  return parsed
}

/** A `summary/save` payload carrying the view's SAVE-05 baseline. */
function summarySavePayload(
  view: SummaryViewValue,
  updateId: string,
  body: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    scopeKind: view.scopeKind,
    scopeId: view.scopeId,
    updateId,
    expectedRevision: view.revision,
    expectedApplicabilityRevision: view.applicabilityRevision,
    expectedSummaryVersionId: view.baseline.summaryVersionId,
    ...body,
  }
}

async function readSummaryVia(
  handler: BoardRpcHandler,
  scopeKind: 'task' | 'project',
  scopeId: string,
): Promise<SummaryViewValue | null> {
  return summaryReadOf(await handler('summary/read', { scopeKind, scopeId }, SIGNAL))
}

function summaryDraftSaveOf(result: BoardRpcResult): SummaryDraftSaveValue {
  const parsed = parseSummaryDraftSaveValue(successOf(result))
  if (parsed === null) throw new Error('the host returned a summary/draft.save value the wire parser rejects')
  return parsed
}

describe('summary/read: independent initialisation and explicit unknowns (F03-R01)', () => {
  it('shows a legal empty task summary without needing any conversation or completed task', async () => {
    const harness = createHarness()
    const taskId = await seedProjectAndTask(harness)

    const view = await readSummaryVia(harness.handler, 'task', taskId)

    expect(view).not.toBeNull()
    expect(view).toMatchObject({
      scopeKind: 'task',
      scopeId: taskId,
      current: null,
      history: [],
      draft: null,
      needsRecheck: false,
    })
    expect(view?.baseline).toEqual({
      revision: view?.revision,
      applicabilityRevision: view?.applicabilityRevision,
      summaryVersionId: null,
    })
    expect(view?.recheck).toEqual({ pending: false, reasons: [], markedAt: null })
  })

  it('answers a registry-only project with an empty overview and registers nothing else', async () => {
    const harness = createHarness()

    const view = await readSummaryVia(harness.handler, 'project', 'ws-1')

    expect(view).toMatchObject({
      scopeKind: 'project',
      scopeId: 'ws-1',
      current: null,
      history: [],
      draft: null,
    })
    expect(view?.baseline.summaryVersionId).toBeNull()
    // Reading established the project scope, but no summary version and no task.
    expect(harness.core.listProjects().map((project) => project.projectId)).toEqual(['ws-1'])
    expect(harness.core.readBoard({ projectId: 'ws-1', workScope: { availability: 'ok' } })).toMatchObject({
      status: 'ok',
      tasks: [],
    })
  })

  it('distinguishes an unknown task (not-found) from an unregistered project (unknown-project)', async () => {
    const harness = createHarness()

    const missingTask = await harness.handler('summary/read', { scopeKind: 'task', scopeId: 'task-missing' }, SIGNAL)
    expect(failureOf(missingTask).code).toBe('not-found')

    const withoutRegistry = createHarness({ registry: false })
    const missingProject = await withoutRegistry.handler(
      'summary/read',
      { scopeKind: 'project', scopeId: 'ws-1' },
      SIGNAL,
    )
    expect(failureOf(missingProject).code).toBe('unknown-project')
  })

  it('refuses an invalid scope at the handler (invalid-payload) and at the port (invalid-input)', async () => {
    const harness = createHarness()

    const malformed: unknown[] = [{}, null, { scopeKind: 'board', scopeId: 'x' }, { scopeKind: 'task', scopeId: '' }]
    for (const payload of malformed) {
      const result = await harness.handler('summary/read', payload, SIGNAL)
      expect(failureOf(result).code, `payload ${JSON.stringify(payload)}`).toBe('invalid-payload')
    }

    const direct = await harness.adapter.readSummary({ scopeKind: 'board' as never, scopeId: 'x' })
    expect(direct).toMatchObject({ ok: false, code: 'invalid-input' })
  })
})

describe('summary/save: versions, baselines and idempotency (F03-R02/R03/R07)', () => {
  it('writes the first manual version, leaves the task untouched and records summary-saved', async () => {
    const harness = createHarness()
    const taskId = await seedProjectAndTask(harness)
    const taskBefore = harness.core.readTask({ taskId: taskId })
    const empty = await readSummaryVia(harness.handler, 'task', taskId)
    if (empty === null) throw new Error('the task scope must be readable')

    const result = await harness.handler(
      'summary/save',
      summarySavePayload(empty, 'sum-1', { content: summaryContent('第一步完成') }),
      SIGNAL,
    )
    const saved = summarySaveOf(result)
    if (saved.outcome !== 'committed') throw new Error(`expected committed, got ${saved.outcome}`)

    expect(saved.changeKind).toBe('created')
    expect(saved.revision).toBe(empty.revision + 1)
    expect(saved.view).not.toBeNull()
    const view = saved.view as SummaryViewValue
    expect(view.current).not.toBeNull()
    expect(view.current?.content.sections).toEqual([{ id: 'progress', title: '进展', body: '第一步完成' }])
    expect(view.current?.origin).toBe('user')
    expect(view.current?.changeKind).toBe('created')
    expect(view.history).toHaveLength(1)
    expect(view.baseline.summaryVersionId).toBe(saved.versionId)

    // F03-R03: the task's own fields and statuses did not move, and no record
    // version appeared — only the summary chain changed.
    const taskAfter = harness.core.readTask({ taskId: taskId })
    expect(taskAfter).toMatchObject({
      title: taskBefore?.title,
      goal: taskBefore?.goal,
      status: taskBefore?.status,
      fieldsRevision: taskBefore?.fieldsRevision,
      statusRevision: taskBefore?.statusRevision,
    })
    const state = harness.core.readScopeState({ scopeKind: 'task', scopeId: taskId })
    expect(Object.keys(state?.chains.taskRecord ?? {})).toHaveLength(0)

    // The activity code is the browser-readable one the client will map.
    const entries = activityOf(
      await harness.handler('activity/read', { scopeKind: 'task', scopeId: taskId }, SIGNAL),
    )
    const savedEntry = entries.find((entry) => entry.code === 'summary-saved')
    if (savedEntry === undefined) throw new Error('the save must append one summary-saved activity entry')
    expect(savedEntry.details).toMatchObject({
      updateId: 'sum-1',
      versionId: saved.versionId,
      changeKind: 'created',
      generator: 'manual',
    })
  })

  it('treats a replayed updateId as already applied (one version), and does not consume drafts', async () => {
    const harness = createHarness()
    const taskId = await seedProjectAndTask(harness)
    const empty = await readSummaryVia(harness.handler, 'task', taskId)
    if (empty === null) throw new Error('the task scope must be readable')
    const first = summarySaveOf(
      await harness.handler(
        'summary/save',
        summarySavePayload(empty, 'sum-replay', { content: summaryContent('一次性内容') }),
        SIGNAL,
      ),
    )
    if (first.outcome !== 'committed') throw new Error('expected the first save to commit')

    const draft = await harness.core.saveDraft({
      kind: 'summaryDraft',
      scopeKind: 'task',
      scopeId: taskId,
      objectId: taskId,
      content: summaryContent('草稿内容'),
    })
    // The replay carries a consumeDraftIds it must NOT honour: no commit happens.
    const replay = summarySaveOf(
      await harness.handler(
        'summary/save',
        summarySavePayload(empty, 'sum-replay', {
          content: summaryContent('一次性内容'),
          consumeDraftIds: [draft.draftId],
        }),
        SIGNAL,
      ),
    )
    expect(replay.outcome).toBe('already-applied')
    if (replay.outcome !== 'already-applied') throw new Error('narrowing')
    expect(replay.versionId).toBe(first.versionId)
    expect(replay.consumedDraftIds).toEqual([])
    expect(replay.view?.history).toHaveLength(1)
    expect(harness.core.getDraft(draft.draftId)?.state).toBe('editing')
  })

  it('writes a modified version on a second substantive save (newest first history)', async () => {
    const harness = createHarness()
    const taskId = await seedProjectAndTask(harness)
    const empty = await readSummaryVia(harness.handler, 'task', taskId)
    if (empty === null) throw new Error('the task scope must be readable')
    const first = summarySaveOf(
      await harness.handler('summary/save', summarySavePayload(empty, 'sum-1', { content: summaryContent('一') }), SIGNAL),
    )
    if (first.outcome !== 'committed' || first.view === null) throw new Error('expected a committed first save')

    const second = summarySaveOf(
      await harness.handler(
        'summary/save',
        summarySavePayload(first.view, 'sum-2', { content: summaryContent('二') }),
        SIGNAL,
      ),
    )
    if (second.outcome !== 'committed' || second.view === null) throw new Error('expected a committed second save')
    expect(second.changeKind).toBe('modified')
    expect(second.revision).toBe(first.revision + 1)
    expect(second.view.history).toHaveLength(2)
    expect(second.view.history[0].versionId).toBe(second.versionId)
    expect(second.view.history[1].versionId).toBe(first.versionId)
    expect(second.view.current?.content.sections[0].body).toBe('二')
  })

  it('answers no-change for an identical body under a fresh baseline, without a new version', async () => {
    const harness = createHarness()
    const taskId = await seedProjectAndTask(harness)
    const empty = await readSummaryVia(harness.handler, 'task', taskId)
    if (empty === null) throw new Error('the task scope must be readable')
    const first = summarySaveOf(
      await harness.handler('summary/save', summarySavePayload(empty, 'sum-1', { content: summaryContent('同一内容') }), SIGNAL),
    )
    if (first.outcome !== 'committed' || first.view === null) throw new Error('expected a committed first save')

    const unchanged = summarySaveOf(
      await harness.handler(
        'summary/save',
        summarySavePayload(first.view, 'sum-2', { content: summaryContent('同一内容') }),
        SIGNAL,
      ),
    )
    expect(unchanged.outcome).toBe('no-change')
    if (unchanged.outcome !== 'no-change') throw new Error('narrowing')
    expect(unchanged.summaryVersionId).toBe(first.versionId)
    expect(unchanged.revision).toBe(first.revision)
    expect(unchanged.view?.history).toHaveLength(1)
  })

  it('refuses a stale baseline with both baselines and does not write a version', async () => {
    const harness = createHarness()
    const taskId = await seedProjectAndTask(harness)
    const empty = await readSummaryVia(harness.handler, 'task', taskId)
    if (empty === null) throw new Error('the task scope must be readable')
    const first = summarySaveOf(
      await harness.handler('summary/save', summarySavePayload(empty, 'sum-1', { content: summaryContent('一') }), SIGNAL),
    )
    if (first.outcome !== 'committed' || first.view === null) throw new Error('expected a committed first save')

    const stale = await harness.handler(
      'summary/save',
      summarySavePayload(empty, 'sum-stale', { content: summaryContent('二') }),
      SIGNAL,
    )
    const failure = failureOf(stale)
    expect(failure.code).toBe('stale-baseline')
    const details = parseSummarySaveFailureDetails(failure.details)
    expect(details).not.toBeNull()
    expect(details?.baseline?.expected.revision).toBe(empty.revision)
    expect(details?.baseline?.actual.revision).toBe(first.view.revision)
    expect(details?.baseline?.actual.summaryVersionId).toBe(first.versionId)
    // Nothing was written: the official body is still the first version.
    expect(harness.core.readSummary({ scopeKind: 'task', scopeId: taskId })?.current?.versionId).toBe(first.versionId)
  })

  it('clears the official body as a cleared version (the summary chain keeps history)', async () => {
    const harness = createHarness()
    const taskId = await seedProjectAndTask(harness)
    const empty = await readSummaryVia(harness.handler, 'task', taskId)
    if (empty === null) throw new Error('the task scope must be readable')
    const first = summarySaveOf(
      await harness.handler('summary/save', summarySavePayload(empty, 'sum-1', { content: summaryContent('一') }), SIGNAL),
    )
    if (first.outcome !== 'committed' || first.view === null) throw new Error('expected a committed first save')

    const cleared = summarySaveOf(
      await harness.handler(
        'summary/save',
        summarySavePayload(first.view, 'sum-clear', { cleared: true }),
        SIGNAL,
      ),
    )
    if (cleared.outcome !== 'committed' || cleared.view === null) throw new Error('expected a committed clear')
    expect(cleared.changeKind).toBe('cleared')
    expect(cleared.view.current?.content.sections).toEqual([])
    expect(cleared.view.history).toHaveLength(2)
  })

  it('consumes an active manual draft only after a commit, and surfaces it while active', async () => {
    const harness = createHarness()
    const taskId = await seedProjectAndTask(harness)
    const draft = await harness.core.saveDraft({
      kind: 'summaryDraft',
      scopeKind: 'task',
      scopeId: taskId,
      objectId: taskId,
      content: summaryContent('草稿内容'),
    })
    const view = await readSummaryVia(harness.handler, 'task', taskId)
    if (view === null) throw new Error('the task scope must be readable')
    expect(view.draft?.draftId).toBe(draft.draftId)
    expect(view.draft?.state).toBe('editing')

    const saved = summarySaveOf(
      await harness.handler(
        'summary/save',
        summarySavePayload(view, 'sum-draft', {
          content: summaryContent('正式内容'),
          consumeDraftIds: [draft.draftId],
        }),
        SIGNAL,
      ),
    )
    if (saved.outcome !== 'committed') throw new Error('expected the draft-backed save to commit')
    expect(saved.consumedDraftIds).toContain(draft.draftId)
    expect(saved.view?.draft).toBeNull()
    expect(harness.core.getDraft(draft.draftId)?.state).toBe('saved')
  })

  it('saves a project overview through the same path, without requiring tasks', async () => {
    const harness = createHarness()
    const empty = await readSummaryVia(harness.handler, 'project', 'ws-1')
    if (empty === null) throw new Error('the project scope must be readable')

    const saved = summarySaveOf(
      await harness.handler(
        'summary/save',
        summarySavePayload(empty, 'overview-1', { content: summaryContent('项目总体进展') }),
        SIGNAL,
      ),
    )
    if (saved.outcome !== 'committed' || saved.view === null) throw new Error('expected a committed overview')
    expect(saved.changeKind).toBe('created')
    expect(saved.view.current?.content.sections[0].body).toBe('项目总体进展')

    const reread = await readSummaryVia(harness.handler, 'project', 'ws-1')
    expect(reread?.current?.versionId).toBe(saved.versionId)
    expect(reread?.history).toHaveLength(1)
  })

  it('maps unknown scopes and content+cleared to explicit failures (never a save)', async () => {
    const harness = createHarness()

    const valid = {
      scopeKind: 'task',
      scopeId: 'task-missing',
      updateId: 'sum-x',
      expectedRevision: 0,
      expectedApplicabilityRevision: 0,
      expectedSummaryVersionId: null,
      content: summaryContent('x'),
    }
    expect(failureOf(await harness.handler('summary/save', valid, SIGNAL)).code).toBe('not-found')

    const withoutRegistry = createHarness({ registry: false })
    const unknownProject = await withoutRegistry.handler(
      'summary/save',
      { ...valid, scopeKind: 'project', scopeId: 'ws-1' },
      SIGNAL,
    )
    expect(failureOf(unknownProject).code).toBe('unknown-project')

    const taskId = await seedProjectAndTask(harness)
    const view = await readSummaryVia(harness.handler, 'task', taskId)
    if (view === null) throw new Error('the task scope must be readable')
    const both = await harness.handler(
      'summary/save',
      summarySavePayload(view, 'sum-both', { content: summaryContent('x'), cleared: true }),
      SIGNAL,
    )
    expect(failureOf(both).code).toBe('invalid-input')

    const malformedPayloads: unknown[] = [
      {},
      { ...summarySavePayload(view, 'sum-ok', { content: summaryContent('x') }), expectedRevision: -1 },
      { ...summarySavePayload(view, '', { content: summaryContent('x') }) },
    ]
    for (const payload of malformedPayloads) {
      const result = await harness.handler('summary/save', payload, SIGNAL)
      expect(failureOf(result).code, `payload ${JSON.stringify(payload)}`).toBe('invalid-payload')
    }
  })

  it('answers committed with view:null when the post-write re-read fails, never a save error', async () => {
    const harness = createHarness()
    const taskId = await seedProjectAndTask(harness)
    const baseline = harness.core.readSummary({ scopeKind: 'task', scopeId: taskId })
    if (baseline === null) throw new Error('the task summary must be readable')
    const payload = summarySavePayload(
      {
        scopeKind: 'task',
        scopeId: taskId,
        revision: baseline.revision,
        applicabilityRevision: baseline.applicabilityRevision,
        baseline: {
          revision: baseline.baseline.revision,
          applicabilityRevision: baseline.baseline.applicabilityRevision,
          summaryVersionId: baseline.baseline.summaryVersionId,
        },
      } as SummaryViewValue,
      'sum-reread',
      { content: summaryContent('已落地') },
    )

    const flaky = new Proxy(harness.core, {
      get(target, property, receiver) {
        if (property === 'readSummary') {
          return (): never => {
            throw new Error('injected summary re-read failure')
          }
        }
        return Reflect.get(target, property, receiver)
      },
    })
    const adapter = createHostBoardPort({
      core: () => flaky,
      workspaceRegistry: () => harness.registry.registry,
    })
    const handler = createBoardChannelHandler(adapter)

    const result = await handler('summary/save', payload, SIGNAL)
    const saved = summarySaveOf(result)
    expect(saved.outcome).toBe('committed')
    if (saved.outcome !== 'committed') throw new Error('narrowing')
    expect(saved.view).toBeNull()
    // The write is durable even though the view could not be refreshed.
    expect(harness.core.readSummary({ scopeKind: 'task', scopeId: taskId })?.current?.content.sections[0].body).toBe(
      '已落地',
    )
  })

  it('answers unavailable before the data layer is ready', async () => {
    const harness = createHarness()
    const taskId = await seedProjectAndTask(harness)
    const offline = createHostBoardPort({ core: () => null, workspaceRegistry: () => harness.registry.registry })
    const handler = createBoardChannelHandler(offline)

    const read = await handler('summary/read', { scopeKind: 'task', scopeId: taskId }, SIGNAL)
    expect(failureOf(read).code).toBe('unavailable')
    const save = await handler(
      'summary/save',
      {
        scopeKind: 'task',
        scopeId: taskId,
        updateId: 'sum-offline',
        expectedRevision: 0,
        expectedApplicabilityRevision: 0,
        expectedSummaryVersionId: null,
        content: summaryContent('x'),
      },
      SIGNAL,
    )
    expect(failureOf(save).code).toBe('unavailable')
  })
})

describe('the delayed-ready wrapper for manual summaries', () => {
  it('answers unavailable before ready and forwards both endpoints afterwards', async () => {
    const harness = createHarness()
    const taskId = await seedProjectAndTask(harness)
    const state = { ready: false, reason: null as string | null }
    const delayed = createDelayedBoardPort(
      { coreReady: () => state.ready, failureReason: () => state.reason },
      harness.adapter,
    )
    const handler = createBoardChannelHandler(delayed)

    const readBefore = await handler('summary/read', { scopeKind: 'task', scopeId: taskId }, SIGNAL)
    expect(failureOf(readBefore).code).toBe('unavailable')
    const saveBefore = await handler(
      'summary/save',
      {
        scopeKind: 'task',
        scopeId: taskId,
        updateId: 'sum-delayed',
        expectedRevision: 0,
        expectedApplicabilityRevision: 0,
        expectedSummaryVersionId: null,
        content: summaryContent('x'),
      },
      SIGNAL,
    )
    expect(failureOf(saveBefore).code).toBe('unavailable')

    state.ready = true
    const view = await readSummaryVia(handler, 'task', taskId)
    expect(view).not.toBeNull()
    if (view === null) throw new Error('narrowing')
    const saved = summarySaveOf(
      await handler('summary/save', summarySavePayload(view, 'sum-delayed', { content: summaryContent('就绪') }), SIGNAL),
    )
    expect(saved.outcome).toBe('committed')
  })
})

describe('summary/draft.save: the manual candidate never becomes a version (F03-R07)', () => {
  it('stores a task draft with its own slot and leaves official content untouched', async () => {
    const harness = createHarness()
    const taskId = await seedProjectAndTask(harness)
    const before = await readSummaryVia(harness.handler, 'task', taskId)
    if (before === null) throw new Error('the task summary must be readable')
    const taskBefore = harness.core.readTask({ taskId })

    const saved = summaryDraftSaveOf(
      await harness.handler(
        'summary/draft.save',
        { scopeKind: 'task', scopeId: taskId, content: summaryContent('草稿一'), updateId: 'draft-update-1' },
        SIGNAL,
      ),
    )

    expect(saved.draft.state).toBe('editing')
    expect(saved.draft.updateId).toBe('draft-update-1')
    expect(saved.draft.content.sections[0]?.body).toBe('草稿一')
    expect(saved.draft.base).toEqual({
      scopeRevision: before.revision,
      applicabilityRevision: before.applicabilityRevision,
    })

    const after = await readSummaryVia(harness.handler, 'task', taskId)
    expect(after).not.toBeNull()
    // A draft save neither appends a version nor bumps the scope revision.
    expect(after?.revision).toBe(before.revision)
    expect(after?.current).toBeNull()
    expect(after?.history).toEqual([])
    expect(after?.draft?.draftId).toBe(saved.draft.draftId)
    expect(after?.draft?.content.sections[0]?.body).toBe('草稿一')
    // The task fields and status are untouched as well.
    expect(harness.core.readTask({ taskId })).toEqual(taskBefore)
  })

  it('re-saving the same scope upserts one draft id and keeps the newest body', async () => {
    const harness = createHarness()
    const taskId = await seedProjectAndTask(harness)

    const first = summaryDraftSaveOf(
      await harness.handler('summary/draft.save', { scopeKind: 'task', scopeId: taskId, content: summaryContent('一') }, SIGNAL),
    )
    const second = summaryDraftSaveOf(
      await harness.handler('summary/draft.save', { scopeKind: 'task', scopeId: taskId, content: summaryContent('二') }, SIGNAL),
    )

    expect(second.draft.draftId).toBe(first.draft.draftId)
    expect(second.draft.content.sections[0]?.body).toBe('二')
    const view = await readSummaryVia(harness.handler, 'task', taskId)
    expect(view?.draft?.content.sections[0]?.body).toBe('二')
  })

  it('saves a project overview draft on a registry-only project', async () => {
    const harness = createHarness()

    const saved = summaryDraftSaveOf(
      await harness.handler(
        'summary/draft.save',
        { scopeKind: 'project', scopeId: harness.projectId, content: summaryContent('总览草稿') },
        SIGNAL,
      ),
    )

    expect(saved.draft.content.sections[0]?.body).toBe('总览草稿')
    const view = await readSummaryVia(harness.handler, 'project', harness.projectId)
    expect(view?.current).toBeNull()
    expect(view?.draft?.draftId).toBe(saved.draft.draftId)
  })

  it('keeps a draft active until the matching committed save consumes it', async () => {
    const harness = createHarness()
    const taskId = await seedProjectAndTask(harness)
    const draft = summaryDraftSaveOf(
      await harness.handler('summary/draft.save', { scopeKind: 'task', scopeId: taskId, content: summaryContent('候选正文') }, SIGNAL),
    ).draft

    const view = await readSummaryVia(harness.handler, 'task', taskId)
    if (view === null) throw new Error('the task summary must be readable')
    const committed = summarySaveOf(
      await harness.handler(
        'summary/save',
        summarySavePayload(view, 'sum-consume', { content: summaryContent('候选正文'), consumeDraftIds: [draft.draftId] }),
        SIGNAL,
      ),
    )

    expect(committed.outcome).toBe('committed')
    if (committed.outcome !== 'committed') throw new Error('narrowing')
    expect(committed.consumedDraftIds).toEqual([draft.draftId])
    expect(harness.core.getDraft(draft.draftId)?.state).toBe('saved')
    const after = await readSummaryVia(harness.handler, 'task', taskId)
    expect(after?.current?.content.sections[0]?.body).toBe('候选正文')
    expect(after?.draft).toBeNull()
  })

  it('refuses unknown scopes and malformed payloads without writing a draft', async () => {
    const harness = createHarness()
    await seedProjectAndTask(harness)

    const missingTask = await harness.handler(
      'summary/draft.save',
      { scopeKind: 'task', scopeId: 'task-missing', content: summaryContent('x') },
      SIGNAL,
    )
    expect(failureOf(missingTask).code).toBe('not-found')

    const unknownProject = await harness.handler(
      'summary/draft.save',
      { scopeKind: 'project', scopeId: 'ws-missing', content: summaryContent('x') },
      SIGNAL,
    )
    expect(failureOf(unknownProject).code).toBe('unknown-project')

    const malformed = await harness.handler(
      'summary/draft.save',
      { scopeKind: 'task', scopeId: 'task-1' },
      SIGNAL,
    )
    expect(failureOf(malformed).code).toBe('invalid-payload')
  })

  it('answers unavailable before the data layer is ready', async () => {
    const harness = createHarness()
    const taskId = await seedProjectAndTask(harness)
    const offline = createHostBoardPort({ core: () => null, workspaceRegistry: () => harness.registry.registry })
    const handler = createBoardChannelHandler(offline)

    const result = await handler(
      'summary/draft.save',
      { scopeKind: 'task', scopeId: taskId, content: summaryContent('x') },
      SIGNAL,
    )
    expect(failureOf(result).code).toBe('unavailable')
  })
})
