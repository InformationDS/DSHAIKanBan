/**
 * F02/F03 protocol round trip — the evidence ADR-005 asks for.
 *
 * ## What this proves, and what it does not
 *
 * It proves our **two halves agree**: the browser half's real adapter
 * (`createChannelBoardSource`, taken from the *built* `lib/client.js`) drives the
 * host half's real handler (`createBoardChannelHandler`, taken from the *built*
 * `lib/index.js`) through a carrier that implements DSH's documented envelope
 * rules, and every endpoint name, payload shape and failure code lines up.
 *
 * It does **not** prove the network hop. The physical carrier, the route mount,
 * the Host/Origin check and the browser token belong to
 * `@deepseek-ai/dsh-client-connection`; observing those needs a live page and a
 * profile install, which this project deliberately does not do in-session
 * (ADR-005 stays 提议 until such a call is observed).
 *
 * ## The carrier rules, quoted
 *
 * From `dsh-client-connection/lib/index.js`:
 * - `register()` mounts a prefix route at the channel and runs
 *   `this.requestRejection(req)` first, answering 401/403 before dispatch.
 * - `rpcFetchHandler()`: POST only, `content-type: application/json` else 415,
 *   envelope parsed as a client request, `message.method` must equal the URL's
 *   endpoint, then `handler(endpoint, payload, request.signal)`.
 * - The response envelope is `{type:'server-response', rpcId, result}` where
 *   `result` is DSH's `ConnectionRpcResult`.
 * - A thrown handler error becomes HTTP 500, which the browser caller reports as
 *   `transport failure … HTTP 500` — hence "never throw" in the host half.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { describe, expect, it } from 'vitest'

const HOST_ENTRY = fileURLToPath(new URL('../lib/index.js', import.meta.url))
const CLIENT_BUNDLE = fileURLToPath(new URL('../lib/client.js', import.meta.url))
const PLUGIN_ID = '@aikanban/dsh-aikanban'

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const PROJECT = {
  projectId: 'ws-1',
  title: 'Demo project',
  workScopeAvailability: 'ok' as const,
  workScopeAllowed: true,
}

const TODO_TASK = {
  taskId: 'task-1',
  projectId: 'ws-1',
  title: 'First task',
  goal: 'Ship F02',
  status: 'todo',
  statusLabel: '未开始',
  order: 0,
  // Required by the wire now: the write baseline and the undo credential.
  statusRevision: 0,
  undoTarget: null,
}

const DOING_TASK = {
  taskId: 'task-2',
  projectId: 'ws-1',
  title: 'Second task',
  goal: '',
  status: 'doing',
  statusLabel: '进行中',
  order: 1,
  summaryProgress: { line: '已接通数据通道', versionId: 'v3', confirmedAt: '2026-10-14T00:00:00.000Z' },
  statusRevision: 3,
  undoTarget: { statusVersion: 'ver1:2', appliedUpdateId: 'op-prev' },
}

const COLUMNS = [
  { status: 'todo', label: '未开始', collapsedByDefault: false },
  { status: 'doing', label: '进行中', collapsedByDefault: false },
  { status: 'blocked', label: '已阻塞', collapsedByDefault: false },
  { status: 'done', label: '已完成', collapsedByDefault: false },
  { status: 'cancelled', label: '已取消', collapsedByDefault: true },
]

const CAPABILITIES = { statusChange: true, reorder: true, undo: true }

/** Slice-B activity rows: newest first, details are always strings. */
const ACTIVITY = [
  {
    activityId: 'act-2',
    at: '2026-11-11T01:00:00.000Z',
    scopeKind: 'task',
    scopeId: 'task-1',
    code: 'task-title-changed',
    summary: '标题已更新',
    details: { taskId: 'task-1', from: 'First task', to: 'Renamed', requestId: 'field-1' },
  },
  {
    activityId: 'act-1',
    at: '2026-11-11T00:00:00.000Z',
    scopeKind: 'task',
    scopeId: 'task-1',
    code: 'task-created',
    summary: '任务已创建',
    details: { projectId: 'ws-1', taskId: 'task-1', status: 'todo', goal: 'Ship F02' },
  },
]

/** A snapshot as the host half sends it. */
function snapshot(tasks: readonly unknown[] = [TODO_TASK, DOING_TASK]) {
  return { project: PROJECT, tasks, columns: COLUMNS, boardToken: 'tok-1', capabilities: CAPABILITIES }
}

/* ------------------------------------------------------------------ *
 * F03 manual summary fixtures
 * ------------------------------------------------------------------ */

const SUMMARY_CONTENT = {
  sections: [{ id: 'progress', title: '进展', body: '已接通数据通道' }],
  conclusions: [],
}

const SUMMARY_VERSION = {
  versionId: 'sumv-1',
  seq: 1,
  confirmedAt: '2026-11-12T00:00:00.000Z',
  origin: 'user',
  changeKind: 'created',
  previousVersionId: null,
  content: SUMMARY_CONTENT,
  conclusions: [],
  readToken: 'read-token-1',
}

const SUMMARY_VIEW = {
  scopeKind: 'task',
  scopeId: 'task-1',
  revision: 2,
  applicabilityRevision: 0,
  baseline: { revision: 2, applicabilityRevision: 0, summaryVersionId: 'sumv-1' },
  current: SUMMARY_VERSION,
  history: [SUMMARY_VERSION],
  draft: null,
  needsRecheck: false,
  recheck: { pending: false, reasons: [], markedAt: null },
}

const SUMMARY_COMMITTED = {
  outcome: 'committed',
  revision: 3,
  applicabilityRevision: 0,
  versionId: 'sumv-2',
  changeKind: 'modified',
  consumedDraftIds: [],
  draftUpdateFailures: [],
  needsRecheck: false,
  view: SUMMARY_VIEW,
}

const SUMMARY_DRAFT = {
  draftId: 'draft-1',
  state: 'editing',
  updateId: 'draft-update-1',
  updatedAt: '2026-11-12T00:00:00.000Z',
  base: { scopeRevision: 2, applicabilityRevision: 0 },
  content: SUMMARY_CONTENT,
}

/* ------------------------------------------------------------------ *
 * The carrier (DSH's documented rules, in-process)
 * ------------------------------------------------------------------ */

interface Registration {
  id: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  factory: (require: (spec: string) => unknown) => Record<string, any>
}

interface RpcFailure {
  ok: false
  error: { code: string; message: string; details: Record<string, unknown> }
}

/**
 * A carrier that behaves like `dsh-client-connection`'s route plus browser
 * caller: envelope validation in, envelope validation out, and an HTTP-shaped
 * failure when the handler throws (which the real caller surfaces as
 * `transport failure … HTTP 500`).
 *
 * @param handler - the registered channel handler.
 * @param reject - simulates `requestRejection` before dispatch.
 * @returns the caller half plus the last envelope it sent.
 */
function carrier(handler: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<unknown>, reject: false | 401 | 403 = false) {
  const sent: { channel: string; endpoint: string; envelope: { type: string; rpcId: string; method: string; payload: unknown } }[] = []
  const call = async (channel: string, endpoint: string, payload: unknown): Promise<unknown> => {
    if (!/^\/[A-Za-z0-9._~-]+$/.test(channel)) throw new Error(`connection: invalid RPC target ${channel}`)
    // The route rejects before dispatch (Host/Origin + browser token).
    if (reject !== false) throw new Error(`transport failure for ${channel}/${endpoint}: HTTP ${reject}`)
    const rpcId = `rpc-${sent.length + 1}`
    const envelope = { type: 'client-request', rpcId, method: endpoint, payload: payload ?? null }
    sent.push({ channel, endpoint, envelope })
    const result = await handler(endpoint, envelope.payload, new AbortController().signal)
    // `fullResponse()`: the browser caller validates the echoed rpcId.
    return result
  }
  return { call, sent }
}

/**
 * Load the built host half.
 *
 * @returns the host module's exports.
 */
async function loadHostHalf() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return import(pathToFileURL(HOST_ENTRY).href) as Promise<Record<string, any>>
}

/**
 * Execute the built browser bundle the way the shell does, then materialize it.
 *
 * @returns the bundle's exports.
 */
function loadClientHalf() {
  const registrations: Registration[] = []
  const fakeWindow = {
    __ModuleLoader__: {
      mode: 'queue' as const,
      pendingQueue: [] as Registration[],
      load(registration: Registration) { registrations.push(registration) },
      create() { throw new Error('not used in this test') },
    },
  }
  const fakeReact = {
    createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }),
  }
  const source = readFileSync(CLIENT_BUNDLE, 'utf8')
  // eslint-disable-next-line no-new-func -- executing the artifact IS the test.
  new Function('window', 'document', source)(fakeWindow, undefined)

  expect(registrations).toHaveLength(1)
  const registration = registrations[0] as Registration
  expect(registration.id).toBe(PLUGIN_ID)
  return registration.factory((spec: string) => {
    if (spec === 'react' || spec === 'react/jsx-runtime') return fakeReact
    throw new Error(`bundle required "${spec}", which is not in the platform module table`)
  })
}

/* ------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------ */

describe('F02 channel: host-half registration', () => {
  it('registers the /aikanban channel and refuses to invent one without a connection service', async () => {
    const host = await loadHostHalf()
    const calls: { channel: string; handler: unknown }[] = []
    const connection = { rpc: { handle: (channel: string, handler: unknown) => { calls.push({ channel, handler }); return () => Promise.resolve() } } }

    const registration = host.registerBoardChannel(connection, {})
    expect(registration.ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.channel).toBe('/aikanban')
    expect(calls[0]?.handler).toBeTypeOf('function')

    // A composition without the connection service is a normal case, not a crash.
    expect(host.registerBoardChannel(undefined, {})).toEqual({ ok: false, reason: 'no-connection' })
    expect(host.isHostConnectionLike(connection)).toBe(true)
    expect(host.isHostConnectionLike({})).toBe(false)
  })
})

describe('F02 channel: protocol round trip (built client bundle ↔ built host half)', () => {
  /** Build both halves wired through the carrier. */
  async function wire(portOverrides: Record<string, unknown> = {}) {
    const host = await loadHostHalf()
    const client = loadClientHalf()

    const calls: { port: string; input: unknown }[] = []
    const port = {
      readBoard: async (input: unknown) => ({ ok: true as const, snapshot: snapshot() }),
      listProjects: async () => {
        calls.push({ port: 'listProjects', input: undefined })
        return {
          ok: true as const,
          projects: [
            { projectId: 'ws-1', title: 'Demo project', path: 'C:/demo' },
            { projectId: 'ws-2', title: 'Demo project', path: 'D:/other' },
          ],
        }
      },
      setStatus: async (input: unknown) => { calls.push({ port: 'setStatus', input }); return { ok: true as const, snapshot: snapshot(), undoable: true } },
      reorder: async (input: unknown) => { calls.push({ port: 'reorder', input }); return { ok: true as const, snapshot: snapshot(), undoable: true } },
      undoStatusChange: async (input: unknown) => { calls.push({ port: 'undo', input }); return { ok: true as const, snapshot: snapshot(), undoable: false } },
      createTask: async (input: unknown) => {
        calls.push({ port: 'createTask', input })
        return {
          ok: true as const,
          outcome: 'created' as const,
          task: { ...TODO_TASK, fieldsRevision: 0 },
          snapshot: snapshot([{ ...TODO_TASK, fieldsRevision: 0 }, DOING_TASK]),
        }
      },
      linkConversation: async (input: unknown) => {
        calls.push({ port: 'linkConversation', input })
        return { ok: true as const, taskId: TODO_TASK.taskId, conversationId: 'conv-1', linkStatus: 'linked' as const }
      },
      updateTaskFields: async (input: unknown) => {
        calls.push({ port: 'updateFields', input })
        return {
          ok: true as const,
          outcome: 'saved' as const,
          task: { ...TODO_TASK, title: 'Renamed', fieldsRevision: 1 },
          changed: ['title'] as const,
          fieldsRevision: 1,
          snapshot: snapshot([{ ...TODO_TASK, title: 'Renamed', fieldsRevision: 1 }, DOING_TASK]),
        }
      },
      readActivity: async (input: unknown) => {
        calls.push({ port: 'readActivity', input })
        return { ok: true as const, entries: ACTIVITY }
      },
      readSummary: async (input: unknown) => {
        calls.push({ port: 'readSummary', input })
        return { ok: true as const, summary: SUMMARY_VIEW }
      },
      saveSummary: async (input: unknown) => {
        calls.push({ port: 'saveSummary', input })
        return { ok: true as const, value: SUMMARY_COMMITTED }
      },
      saveSummaryDraft: async (input: unknown) => {
        calls.push({ port: 'saveSummaryDraft', input })
        return { ok: true as const, draft: SUMMARY_DRAFT }
      },
      ...portOverrides,
    }

    const handler = host.createBoardChannelHandler(port)
    const transport = carrier(handler)
    const source = client.createChannelBoardSource({ rpc: { call: transport.call } })
    return { host, client, port, calls, handler, transport, source }
  }

  it('reads a board through the real handler and parses it in the real adapter', async () => {
    const { source, transport } = await wire()
    const result = await source.readBoard('ws-1')

    expect(transport.sent[0]?.channel).toBe('/aikanban')
    expect(transport.sent[0]?.endpoint).toBe('board/read')
    // Q1=B: the selected project travels on every read; no "current project".
    expect(transport.sent[0]?.envelope.payload).toEqual({ projectId: 'ws-1' })
    expect(result.ok, result.ok ? '' : `read failed: ${result.code} ${result.message}`).toBe(true)
    if (!result.ok) throw new Error(result.message)
    expect(result.snapshot.project.projectId).toBe('ws-1')
    expect(result.snapshot.tasks.map((task) => task.taskId)).toEqual(['task-1', 'task-2'])
    expect(result.snapshot.boardToken).toBe('tok-1')
    expect(result.snapshot.capabilities).toEqual(CAPABILITIES)
    // The summary line and the goal both survive the wire unchanged: the card
    // rule (summary first) is applied by the view model, not lost in transit.
    expect(result.snapshot.tasks[1]?.summaryProgress?.line).toBe('已接通数据通道')
    // Q2=A: the baseline and the undo credential survive the read.
    expect(result.snapshot.tasks[0]?.statusRevision).toBe(0)
    expect(result.snapshot.tasks[1]?.statusRevision).toBe(3)
    expect(result.snapshot.tasks[1]?.undoTarget).toEqual({ statusVersion: 'ver1:2', appliedUpdateId: 'op-prev' })
  })

  it('lists projects through the real handler with an empty payload and no selection', async () => {
    const { source, transport } = await wire()

    const result = await source.listProjects()

    expect(transport.sent[0]?.channel).toBe('/aikanban')
    expect(transport.sent[0]?.endpoint).toBe('project/list')
    // Q1=B: listing carries no project hint; the choice is a separate act.
    expect(transport.sent[0]?.envelope.payload).toEqual({})
    expect(result.ok, result.ok ? '' : `listing failed: ${result.code} ${result.message}`).toBe(true)
    if (!result.ok) throw new Error(result.message)
    expect(result.projects).toEqual([
      { projectId: 'ws-1', title: 'Demo project', path: 'C:/demo' },
      { projectId: 'ws-2', title: 'Demo project', path: 'D:/other' },
    ])
  })

  it('reports a failed project listing as a failure, never as an empty candidate set', async () => {
    const { source } = await wire({
      listProjects: async () => ({
        ok: false as const,
        code: 'unavailable' as const,
        message: '数据层尚未就绪，项目清单暂不可用。',
      }),
    })

    const result = await source.listProjects()

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('a failed listing was reported as an empty candidate set')
    expect(result.code).toBe('unavailable')
  })

  it('refuses a board/read without a projectId: invalid-payload and no host read', async () => {    const host = await loadHostHalf()
    let reads = 0
    const handler = host.createBoardChannelHandler({
      readBoard: async () => { reads += 1; return { ok: true, snapshot: snapshot([]) } },
      setStatus: async () => ({ ok: false, code: 'unavailable', message: 'x' }),
      reorder: async () => ({ ok: false, code: 'unavailable', message: 'x' }),
      undoStatusChange: async () => ({ ok: false, code: 'unavailable', message: 'x' }),
    })
    const result = await handler('board/read', {}, new AbortController().signal) as RpcFailure

    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('invalid-payload')
    expect(result.error.message).toContain('projectId')
    // The handler rejected before the port: no project was guessed and no read ran.
    expect(reads).toBe(0)
  })

  it('changes a status through the real write path and reports undoability', async () => {
    const { source, calls } = await wire()
    const result = await source.setStatus({ taskId: 'task-1', next: 'doing', operationId: 'op-1', expectedStatusVersion: 'ver1:0' })

    expect(result.ok, result.ok ? '' : `write failed: ${result.code} ${result.message}`).toBe(true)
    if (!result.ok) throw new Error(result.message)
    expect(result.undoable).toBe(true)
    expect(calls).toEqual([{
      port: 'setStatus',
      // The handler decodes `ver1:<n>` before the port; the data layer never
      // sees the wire encoding (s1-wiring.md §4.2/A3).
      input: { taskId: 'task-1', next: 'doing', operationId: 'op-1', expectedStatusRevision: 0 },
    }])
  })

  it('refuses a blocked transition without a reason and writes nothing', async () => {
    const { handler, calls } = await wire()
    const result = await handler(
      'task/status.set',
      { taskId: 'task-1', next: 'blocked', operationId: 'op-2', reason: '   ', expectedStatusVersion: 'ver1:0' },
      new AbortController().signal,
    ) as RpcFailure

    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('invalid-reason')
    expect(result.error.details).toEqual({})
    // The product rule is enforced at the boundary: no write reached the data layer.
    expect(calls).toEqual([])
  })

  it('maps a failed write to a code and the formal current value, never to success', async () => {
    const { source } = await wire({
      setStatus: async () => ({
        ok: false as const,
        code: 'stale-baseline' as const,
        message: '此前的修改已被其他操作更新。',
        current: { status: 'blocked', statusVersion: 'sv-9' },
      }),
    })
    const result = await source.setStatus({ taskId: 'task-1', next: 'done', operationId: 'op-3', expectedStatusVersion: 'ver1:0' })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('a failed write was reported as success')
    expect(result.code).toBe('stale-baseline')
    expect(result.current).toEqual({ status: 'blocked', statusVersion: 'sv-9' })
  })

  it('answers an unknown endpoint with a named code instead of throwing', async () => {
    const { handler } = await wire()
    const result = await handler('board/nope', {}, new AbortController().signal) as RpcFailure
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('unknown-endpoint')
    expect(result.error.message).toContain('board/read')
  })

  it('refuses a malformed payload with invalid-payload and writes nothing', async () => {
    const { handler, calls } = await wire()
    const result = await handler('task/status.set', { taskId: '', next: 'doing' }, new AbortController().signal) as RpcFailure
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('invalid-payload')
    expect(calls).toEqual([])
  })

  it('never throws when the data layer throws: reads fail, writes are unknown', async () => {
    const { handler } = await wire({
      readBoard: async () => { throw new Error('storage exploded') },
      setStatus: async () => { throw new Error('storage exploded') },
    })

    const read = await handler('board/read', { projectId: 'ws-1' }, new AbortController().signal) as RpcFailure
    expect(read.ok).toBe(false)
    expect(read.error.code).toBe('read-failed')

    const write = await handler('task/status.set', { taskId: 'task-1', next: 'doing', operationId: 'op-4', expectedStatusVersion: 'ver1:0' }, new AbortController().signal) as RpcFailure
    expect(write.ok).toBe(false)
    // REC-03: the outcome is unknown, so the UI asks the user to verify rather
    // than offering a blind retry.
    expect(write.error.code).toBe('unknown-result')
  })

  it('surfaces an unregistered project as its own read state, not an empty board', async () => {
    const { source } = await wire({
      readBoard: async () => ({ ok: false as const, code: 'unknown-project' as const, message: '项目信息不可用：该项目尚未登记。' }),
    })
    const result = await source.readBoard('ws-1')

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('an unregistered project was reported as a readable board')
    expect(result.code).toBe('unknown-project')
  })

  it('treats a malformed success payload as a failure, never as an empty board', async () => {
    const { source } = await wire({
      readBoard: async () => ({ ok: true as const, snapshot: { project: PROJECT, tasks: 'not-an-array' } }),
    })
    const result = await source.readBoard('ws-1')

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('a malformed snapshot produced a board')
    expect(result.code).toBe('read-failed')
  })

  it('rejects a task snapshot without the required baseline/undo fields', async () => {
    const { source } = await wire({
      readBoard: async () => ({
        ok: true as const,
        snapshot: snapshot([{ taskId: 'task-1', projectId: 'ws-1', title: 't', goal: '', status: 'todo', order: 0 }]),
      }),
    })
    const result = await source.readBoard('ws-1')

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('a snapshot without statusRevision/undoTarget was accepted')
    expect(result.code).toBe('read-failed')
  })

  it('reports a transport-level rejection (401/403) as a failure, not as data', async () => {
    const client = loadClientHalf()
    const transport = carrier(async () => ({ ok: true, value: snapshot() }), 403)
    const source = client.createChannelBoardSource({ rpc: { call: transport.call } })

    const read = await source.readBoard('ws-1')
    expect(read.ok).toBe(false)

    const write = await source.setStatus({ taskId: 'task-1', next: 'doing', operationId: 'op-5', expectedStatusVersion: 'ver1:0' })
    expect(write.ok).toBe(false)
    if (write.ok) throw new Error('a rejected write was reported as success')
    expect(write.code).toBe('unknown-result')
  })

  it('refuses a non-canonical baseline before the data layer, on all three write endpoints', async () => {
    const { handler, calls } = await wire()
    const signal = new AbortController().signal
    const cases: { endpoint: string; payload: Record<string, unknown> }[] = [
      { endpoint: 'task/status.set', payload: { taskId: 'task-1', next: 'doing', operationId: 'op-6', expectedStatusVersion: '3' } },
      { endpoint: 'task/status.set', payload: { taskId: 'task-1', next: 'doing', operationId: 'op-6', expectedStatusVersion: 'ver1:01' } },
      { endpoint: 'task/reorder', payload: { taskId: 'task-1', status: 'todo', toIndex: 1, operationId: 'op-7', expectedStatusVersion: 'ver1:-1' } },
      { endpoint: 'task/status.undo', payload: { taskId: 'task-1', operationId: 'undo-1', expectedStatusVersion: 'v1:2', appliedUpdateId: 'op-prev' } },
    ]
    for (const { endpoint, payload } of cases) {
      const result = await handler(endpoint, payload, signal) as RpcFailure
      expect(result.ok, `${endpoint} accepted ${String(payload['expectedStatusVersion'])}`).toBe(false)
      expect(result.error.code).toBe('invalid-payload')
    }
    // F5: the handler refused all of them before the port; nothing was written.
    expect(calls).toEqual([])
  })

  it('sends two distinct identities on undo: this undo and the write being undone', async () => {
    const { source, calls } = await wire()
    const result = await source.undoStatusChange({
      taskId: 'task-2',
      operationId: 'undo-1',
      expectedStatusVersion: 'ver1:3',
      appliedUpdateId: 'op-prev',
    })

    expect(result.ok, result.ok ? '' : `undo failed: ${result.code} ${result.message}`).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.port).toBe('undo')
    expect(calls[0]?.input).toEqual({
      taskId: 'task-2',
      operationId: 'undo-1',
      expectedStatusRevision: 3,
      appliedUpdateId: 'op-prev',
    })
  })

  it('rejects an undo payload that conflates the two identities (missing appliedUpdateId)', async () => {
    const { handler, calls } = await wire()
    const result = await handler(
      'task/status.undo',
      { taskId: 'task-1', operationId: 'op-8', expectedStatusVersion: 'ver1:0' },
      new AbortController().signal,
    ) as RpcFailure

    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('invalid-payload')
    expect(calls).toEqual([])
  })

  it('reports a transport failure as unknown-result exactly once and never invites a resubmission', async () => {
    const client = loadClientHalf()
    let attempts = 0
    // The transport itself throws (no structured result): REC-03 "unknown",
    // never "definitely unsaved" and never a second attempt by the adapter.
    const source = client.createChannelBoardSource({
      rpc: {
        call: async () => {
          attempts += 1
          throw new Error('socket dropped')
        },
      },
    })

    const result = await source.setStatus({ taskId: 'task-1', next: 'doing', operationId: 'op-9', expectedStatusVersion: 'ver1:0' })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('an unknown write was reported as success')
    expect(result.code).toBe('unknown-result')
    // One attempt: the adapter never retries a write by itself (F9/F10/D6).
    expect(attempts).toBe(1)
    // A7: the text must not tell the user to "retry later"; verification first.
    expect(result.message).not.toContain('后重试')
    expect(result.message).toContain('不要重复提交')
  })

  it('creates a task through the real bundle and parses the re-read snapshot', async () => {
    const { source, transport, calls } = await wire()

    const result = await source.createTask({ projectId: 'ws-1', requestId: 'create-1', title: 'New task', goal: 'g' })

    expect(transport.sent[0]?.endpoint).toBe('task/create')
    expect(transport.sent[0]?.envelope.payload).toEqual({
      projectId: 'ws-1',
      requestId: 'create-1',
      title: 'New task',
      goal: 'g',
    })
    expect(calls).toEqual([{
      port: 'createTask',
      input: { projectId: 'ws-1', requestId: 'create-1', title: 'New task', goal: 'g' },
    }])
    expect(result.ok, result.ok ? '' : `create failed: ${result.code} ${result.message}`).toBe(true)
    if (!result.ok) throw new Error(result.message)
    expect(result.outcome).toBe('created')
    expect(result.task.taskId).toBe('task-1')
    expect(result.snapshot?.tasks).toHaveLength(2)
  })

  it('keeps the creation echo on an invalid-input refusal', async () => {
    const rejection = {
      title: '   ',
      goal: '',
      initialStatus: 'todo',
      blockedReason: null,
    }
    const { source } = await wire({
      createTask: async () => ({
        ok: false as const,
        code: 'invalid-input' as const,
        message: '标题必填',
        keptInput: rejection,
      }),
    })

    const refused = await source.createTask({ projectId: 'ws-1', requestId: 'create-bad', title: '   ' })
    expect(refused.ok).toBe(false)
    if (refused.ok) throw new Error('a refused creation was reported as success')
    expect(refused.code).toBe('invalid-input')
    expect(refused.keptInput).toEqual(rejection)
  })

  it('attributes a conversation through the real bundle without creating a session', async () => {
    const { source, transport, calls } = await wire()

    const result = await source.linkConversation({ taskId: 'task-1', conversationId: 'conv-9', requestId: 'op-conv-1' })

    expect(transport.sent[0]?.endpoint).toBe('conversation/link')
    // No session is ever created by this endpoint: the payload only names the
    // task and the conversation the browser already opened.
    expect(transport.sent[0]?.envelope.payload).toEqual({
      taskId: 'task-1',
      conversationId: 'conv-9',
      requestId: 'op-conv-1',
    })
    expect(calls).toEqual([
      { port: 'linkConversation', input: { taskId: 'task-1', conversationId: 'conv-9', requestId: 'op-conv-1' } },
    ])
    expect(result).toEqual({ ok: true, taskId: 'task-1', conversationId: 'conv-1', linkStatus: 'linked' })
  })

  it('treats a repeat attribution as already-linked success, never a second conversation', async () => {
    const { source, transport } = await wire({
      linkConversation: async () => ({
        ok: true as const,
        taskId: 'task-1',
        conversationId: 'conv-9',
        linkStatus: 'already-linked' as const,
      }),
    })

    const result = await source.linkConversation({ taskId: 'task-1', conversationId: 'conv-9' })

    expect(transport.sent).toHaveLength(1)
    expect(result).toEqual({ ok: true, taskId: 'task-1', conversationId: 'conv-9', linkStatus: 'already-linked' })
  })

  it('refuses a conversation already owned by another task with save-failed', async () => {
    const { source } = await wire({
      linkConversation: async () => ({
        ok: false as const,
        code: 'save-failed' as const,
        message: '会话已归属其他任务，本次归属未写入。',
      }),
    })

    const result = await source.linkConversation({ taskId: 'task-2', conversationId: 'conv-9' })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('a refused rebind was reported as success')
    expect(result.code).toBe('save-failed')
    expect(result.message).toContain('其他任务')
  })

  it('surfaces an unknown task as not-found and never echoes a session', async () => {
    const { source } = await wire({
      linkConversation: async () => ({
        ok: false as const,
        code: 'not-found' as const,
        message: "任务 'task-404' 不存在；任务归属未写入。",
      }),
    })

    const result = await source.linkConversation({ taskId: 'task-404', conversationId: 'conv-9' })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('an unknown task was reported as linked')
    expect(result.code).toBe('not-found')
  })

  it('refuses a malformed conversation/link payload before the data layer', async () => {
    const { handler, calls } = await wire()
    const result = (await handler(
      'conversation/link',
      { taskId: '', conversationId: 'conv-9' },
      new AbortController().signal,
    )) as RpcFailure

    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('invalid-payload')
    // A retry that cannot name both ids cannot be attributed to anything.
    expect(result.error.message).toContain('No conversation was created')
    expect(calls).toEqual([])
  })

  it('never fabricates a link result from a malformed success value', async () => {
    const { source } = await wire({
      linkConversation: async () => ({ ok: true as const, taskId: 'task-1', conversationId: 'conv-9' }),
    })

    const result = await source.linkConversation({ taskId: 'task-1', conversationId: 'conv-9' })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('a malformed attribution produced a linked conversation')
    expect(result.code).toBe('unknown-result')
    expect(result.message).toContain('不要重新创建会话')
  })

  it('rejects a conversation/link request with empty local ids without touching the channel', async () => {
    const { source, transport } = await wire()

    const missingTask = await source.linkConversation({ taskId: '', conversationId: 'conv-9' })
    const missingConversation = await source.linkConversation({ taskId: 'task-1', conversationId: '' })

    expect(missingTask.ok).toBe(false)
    expect(missingConversation.ok).toBe(false)
    if (missingTask.ok || missingConversation.ok) throw new Error('an empty id was sent to the channel')
    expect(missingTask.code).toBe('invalid-input')
    expect(missingConversation.code).toBe('invalid-input')
    // The browser half creates the session before linking; a link call without
    // ids must never reach the host at all.
    expect(transport.sent).toHaveLength(0)
  })

  it('decodes both fver1/ver1 baselines before the data layer on task/fields.update', async () => {
    const { source, transport, calls } = await wire()

    const result = await source.updateTaskFields({
      taskId: 'task-1',
      requestId: 'field-1',
      expectedFieldsVersion: 'fver1:3',
      expectedStatusVersion: 'ver1:2',
      title: 'Renamed',
      goal: null,
    })

    expect(transport.sent[0]?.endpoint).toBe('task/fields.update')
    // The wire contract still carries the encoded baselines…
    expect(transport.sent[0]?.envelope.payload).toEqual({
      taskId: 'task-1',
      requestId: 'field-1',
      expectedFieldsVersion: 'fver1:3',
      expectedStatusVersion: 'ver1:2',
      title: 'Renamed',
      goal: null,
    })
    // …while the data layer only ever receives decoded numbers (SAVE-05).
    expect(calls[0]?.input).toEqual({
      taskId: 'task-1',
      requestId: 'field-1',
      expectedFieldsRevision: 3,
      expectedStatusRevision: 2,
      title: 'Renamed',
      goal: null,
    })
    expect(result.ok, result.ok ? '' : `save failed: ${result.code} ${result.message}`).toBe(true)
    if (!result.ok) throw new Error(result.message)
    expect(result.outcome).toBe('saved')
    expect(result.changed).toEqual(['title'])
    expect(result.fieldsRevision).toBe(1)
  })

  it('surfaces stale-baseline with current, both baselines and the kept input', async () => {
    const keptInput = { title: 'Renamed', goal: null }
    const baseline = {
      expected: { fieldsVersion: 'fver1:2', statusVersion: 'ver1:3' },
      actual: { fieldsVersion: 'fver1:3', statusVersion: 'ver1:4' },
    }
    const { source } = await wire({
      updateTaskFields: async () => ({
        ok: false as const,
        code: 'stale-baseline' as const,
        message: '字段保存被拒绝。',
        current: { status: 'doing', statusVersion: 'ver1:4' },
        keptInput,
        baseline,
      }),
    })

    const result = await source.updateTaskFields({
      taskId: 'task-1',
      requestId: 'field-2',
      expectedFieldsVersion: 'fver1:2',
      expectedStatusVersion: 'ver1:3',
      title: 'Renamed',
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('a stale save was reported as success')
    expect(result.code).toBe('stale-baseline')
    expect(result.current).toEqual({ status: 'doing', statusVersion: 'ver1:4' })
    expect(result.baseline).toEqual(baseline)
    expect(result.keptInput).toEqual(keptInput)
  })

  it('keeps a landed-but-unrefreshed save distinguishable from a failure', async () => {
    const { source } = await wire({
      updateTaskFields: async () => ({
        ok: true as const,
        outcome: 'saved' as const,
        task: { ...TODO_TASK, title: 'Renamed', fieldsRevision: 1 },
        changed: ['title'] as const,
        fieldsRevision: 1,
        snapshot: null,
      }),
    })

    const result = await source.updateTaskFields({
      taskId: 'task-1',
      requestId: 'field-3',
      expectedFieldsVersion: 'fver1:0',
      expectedStatusVersion: 'ver1:0',
      title: 'Renamed',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.message)
    expect(result.snapshot).toBeNull()
    expect(result.task.title).toBe('Renamed')
    expect(result.fieldsRevision).toBe(1)
  })

  it('reads activity history through the endpoint and preserves string-only details', async () => {
    const { source, transport, calls } = await wire()

    const result = await source.loadActivity({ scopeKind: 'project', scopeId: 'ws-1', limit: 2 })

    expect(transport.sent[0]?.endpoint).toBe('activity/read')
    expect(transport.sent[0]?.envelope.payload).toEqual({ scopeKind: 'project', scopeId: 'ws-1', limit: 2 })
    expect(calls).toEqual([{ port: 'readActivity', input: { scopeKind: 'project', scopeId: 'ws-1', limit: 2 } }])
    expect(result.ok, result.ok ? '' : `activity failed: ${result.code} ${result.message}`).toBe(true)
    if (!result.ok) throw new Error(result.message)
    expect(result.entries).toEqual(ACTIVITY)
    for (const entry of result.entries) {
      expect(entry.scopeKind).toBe('task')
      for (const value of Object.values(entry.details)) expect(typeof value).toBe('string')
    }
  })

  it('refuses an invalid activity scope before the data layer', async () => {
    const { handler, calls } = await wire()
    const result = await handler(
      'activity/read',
      { scopeKind: 'board', scopeId: 'x' },
      new AbortController().signal,
    ) as RpcFailure

    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('invalid-payload')
    expect(calls).toEqual([])
  })

  it('reports an unconfirmed creation attempt exactly once as unknown-result', async () => {
    const client = loadClientHalf()
    let attempts = 0
    const source = client.createChannelBoardSource({
      rpc: {
        call: async () => {
          attempts += 1
          throw new Error('socket dropped')
        },
      },
    })

    const result = await source.createTask({ projectId: 'ws-1', requestId: 'create-1', title: 'Task' })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('an unknown creation was reported as success')
    expect(result.code).toBe('unknown-result')
    expect(attempts).toBe(1)
    expect(result.message).not.toContain('后重试')
    expect(result.message).toContain('不要重复提交')
  })

  it('reads a manual summary through the endpoint with the scope only', async () => {
    const { source, transport, calls } = await wire()

    const result = await source.readSummary({ scopeKind: 'task', scopeId: 'task-1' })

    expect(transport.sent[0]?.endpoint).toBe('summary/read')
    expect(transport.sent[0]?.envelope.payload).toEqual({ scopeKind: 'task', scopeId: 'task-1' })
    expect(calls).toEqual([{ port: 'readSummary', input: { scopeKind: 'task', scopeId: 'task-1' } }])
    expect(result.ok, result.ok ? '' : `summary read failed: ${result.code} ${result.message}`).toBe(true)
    if (!result.ok) throw new Error(result.message)
    expect(result.summary).toEqual(SUMMARY_VIEW)
  })

  it('carries summary:null as a legal "no summary yet" answer', async () => {
    const { source } = await wire({ readSummary: async () => ({ ok: true, summary: null }) })

    const result = await source.readSummary({ scopeKind: 'project', scopeId: 'ws-1' })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.message)
    expect(result.summary).toBeNull()
  })

  it('saves a manual summary, encoding the baseline as plain revisions at the carrier', async () => {
    const { source, transport, calls } = await wire()

    const result = await source.saveSummary({
      scopeKind: 'task',
      scopeId: 'task-1',
      updateId: 'summary-1',
      expected: { revision: 2, applicabilityRevision: 0, summaryVersionId: 'sumv-1' },
      content: SUMMARY_CONTENT,
    })

    expect(transport.sent[0]?.endpoint).toBe('summary/save')
    expect(transport.sent[0]?.envelope.payload).toEqual({
      scopeKind: 'task',
      scopeId: 'task-1',
      updateId: 'summary-1',
      expectedRevision: 2,
      expectedApplicabilityRevision: 0,
      expectedSummaryVersionId: 'sumv-1',
      content: SUMMARY_CONTENT,
    })
    expect(calls).toEqual([
      {
        port: 'saveSummary',
        input: {
          scopeKind: 'task',
          scopeId: 'task-1',
          updateId: 'summary-1',
          expected: { revision: 2, applicabilityRevision: 0, summaryVersionId: 'sumv-1' },
          content: SUMMARY_CONTENT,
        },
      },
    ])
    expect(result.ok, result.ok ? '' : `summary save failed: ${result.code} ${result.message}`).toBe(true)
    if (!result.ok) throw new Error(result.message)
    expect(result.outcome).toBe('committed')
    expect(result.versionId).toBe('sumv-2')
    expect(result.view).toEqual(SUMMARY_VIEW)
  })

  it('keeps the committed save authoritative when the refreshed view is null', async () => {
    const { source } = await wire({
      saveSummary: async () => ({ ok: true as const, value: { ...SUMMARY_COMMITTED, view: null } }),
    })

    const result = await source.saveSummary({
      scopeKind: 'task',
      scopeId: 'task-1',
      updateId: 'summary-1',
      expected: { revision: 2, applicabilityRevision: 0, summaryVersionId: 'sumv-1' },
      content: SUMMARY_CONTENT,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.message)
    expect(result.outcome).toBe('committed')
    expect(result.versionId).toBe('sumv-2')
    expect(result.view).toBeNull()
  })

  it('carries both baselines on a stale summary save', async () => {
    const expected = { revision: 2, applicabilityRevision: 0, summaryVersionId: 'sumv-1' }
    const actual = { revision: 3, applicabilityRevision: 0, summaryVersionId: 'sumv-2' }
    const { source } = await wire({
      saveSummary: async () => ({
        ok: false as const,
        code: 'stale-baseline',
        message: 'the summary moved',
        baseline: { expected, actual },
      }),
    })

    const result = await source.saveSummary({
      scopeKind: 'task',
      scopeId: 'task-1',
      updateId: 'summary-1',
      expected,
      content: SUMMARY_CONTENT,
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('a stale baseline was reported as success')
    expect(result.code).toBe('stale-baseline')
    expect(result.baseline).toEqual({ expected, actual })
  })

  it('refuses a non-canonical summary baseline before the data layer', async () => {
    const { handler, calls } = await wire()

    const result = (await handler(
      'summary/save',
      {
        scopeKind: 'task',
        scopeId: 'task-1',
        updateId: 'summary-1',
        expectedRevision: -1,
        expectedApplicabilityRevision: 0,
        expectedSummaryVersionId: null,
        content: SUMMARY_CONTENT,
      },
      new AbortController().signal,
    )) as RpcFailure

    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('invalid-payload')
    expect(calls).toEqual([])
  })

  it('reports an unconfirmed summary save exactly once as unknown-result', async () => {
    const client = loadClientHalf()
    let attempts = 0
    const source = client.createChannelBoardSource({
      rpc: {
        call: async () => {
          attempts += 1
          throw new Error('socket dropped')
        },
      },
    })

    const result = await source.saveSummary({
      scopeKind: 'task',
      scopeId: 'task-1',
      updateId: 'summary-1',
      expected: { revision: 2, applicabilityRevision: 0, summaryVersionId: 'sumv-1' },
      content: SUMMARY_CONTENT,
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('an unknown save was reported as success')
    expect(result.code).toBe('unknown-result')
    expect(attempts).toBe(1)
    expect(result.message).not.toContain('后重试')
    expect(result.message).toContain('不要重复提交')
  })

  describe('F03 channel: manual draft save round trip', () => {
    it('carries the draft body to the port and returns the stored draft', async () => {
      const { source, transport, calls } = await wire()

      const result = await source.saveSummaryDraft({
        scopeKind: 'task',
        scopeId: 'task-1',
        content: SUMMARY_CONTENT,
        updateId: 'draft-update-1',
      })

      expect(transport.sent[0]?.endpoint).toBe('summary/draft.save')
      expect(transport.sent[0]?.envelope.payload).toEqual({
        scopeKind: 'task',
        scopeId: 'task-1',
        content: SUMMARY_CONTENT,
        updateId: 'draft-update-1',
      })
      expect(calls).toEqual([
        {
          port: 'saveSummaryDraft',
          input: { scopeKind: 'task', scopeId: 'task-1', content: SUMMARY_CONTENT, updateId: 'draft-update-1' },
        },
      ])
      expect(result.ok, result.ok ? '' : `${result.code} ${result.message}`).toBe(true)
      if (!result.ok) throw new Error(result.message)
      expect(result.draft).toEqual(SUMMARY_DRAFT)
    })

    it('refuses a draft payload without a body before the data layer', async () => {
      const { handler, calls } = await wire()

      const result = (await handler(
        'summary/draft.save',
        { scopeKind: 'task', scopeId: 'task-1' },
        new AbortController().signal,
      )) as RpcFailure

      expect(result.ok).toBe(false)
      expect(result.error.code).toBe('invalid-payload')
      expect(calls).toEqual([])
    })

    it('reports an unconfirmed draft save exactly once as unknown-result', async () => {
      const client = loadClientHalf()
      let attempts = 0
      const source = client.createChannelBoardSource({
        rpc: {
          call: async () => {
            attempts += 1
            throw new Error('socket dropped')
          },
        },
      })

      const result = await source.saveSummaryDraft({ scopeKind: 'task', scopeId: 'task-1', content: SUMMARY_CONTENT })

      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('an unknown draft save was reported as success')
      expect(result.code).toBe('unknown-result')
      expect(attempts).toBe(1)
      expect(result.message).not.toContain('后重试')
      expect(result.message).toContain('不要重复提交')
    })
  })
})
