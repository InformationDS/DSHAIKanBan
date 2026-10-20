/**
 * F02 protocol round trip — the evidence ADR-005 asks for.
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

/** A snapshot as the host half sends it. */
function snapshot(tasks: readonly unknown[] = [TODO_TASK, DOING_TASK]) {
  return { project: PROJECT, tasks, columns: COLUMNS, boardToken: 'tok-1', capabilities: CAPABILITIES }
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
      setStatus: async (input: unknown) => { calls.push({ port: 'setStatus', input }); return { ok: true as const, snapshot: snapshot(), undoable: true } },
      reorder: async (input: unknown) => { calls.push({ port: 'reorder', input }); return { ok: true as const, snapshot: snapshot(), undoable: true } },
      undoStatusChange: async (input: unknown) => { calls.push({ port: 'undo', input }); return { ok: true as const, snapshot: snapshot(), undoable: false } },
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

  it('refuses a board/read without a projectId: invalid-payload and no host read', async () => {
    const host = await loadHostHalf()
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
      input: { taskId: 'task-1', next: 'doing', operationId: 'op-1', expectedStatusVersion: 'ver1:0' },
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
      expectedStatusVersion: 'ver1:3',
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
})
