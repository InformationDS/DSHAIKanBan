/**
 * AIKanBan S0 host-integration probe (task-3, items a–d).
 *
 * This is a *throwaway observable harness*, not shipped plugin code. It mounts
 * into an isolated `dsh --profile headless` host whose `DSH_HOME` lives inside
 * the workspace, drives the three integration paths, and writes one JSON report
 * plus stderr lines. It never runs unless deliberately triggered (the host is
 * started by a human/agent, nothing auto-starts it) and it alters no session
 * other than the two throwaway sessions it creates inside that isolated home.
 *
 * Verified-against sources (read, not guessed):
 * - `@deepseek-ai/dsh-time-context/lib/index.js` — the official `{prepend:true}`
 *   `agent/pre-step` + `sessionProjections` reference implementation mirrored here.
 * - `@deepseek-ai/dsh-api-session-controller/lib/index.js` — `prompt` (line ~736),
 *   `hasPromptRequest` idempotency (~940), the subagent guard in `resolve` (~221).
 * - `@deepseek-ai/dsh-api-session-controller/lib/index.js` `create` (~571):
 *   `create({workspaceId})` sets `cwd = workspace.path` **and** attaches.
 * - `@deepseek-ai/dsh-workspace/lib/types/entity.js` — `sessionIds` getter filter,
 *   `attachSession` validation, `status()`.
 * - `@deepseek-ai/dsh-session` `ctx.sessions.create(id, {meta:{origin:'subagent'}})`.
 *
 * @module @aikanban/probe
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

/** Cordis plugin name; also the `source.plugin` marker of every injected context block. */
export const name = 'aikanban-probe'

/** Services that must exist before the probe can observe anything. */
export const inject = ['sessionController', 'sessionProjections', 'workspaceRegistry', 'sessions']

/** Validated probe configuration (supplied by the `--patch` overlay). */
export const Config = z.object({
	/** Absolute path of the JSON report to write. */
	reportPath: z.string(),
	/** Workspace path expected to resolve to the real AIKanBan workspace fixture. */
	primaryWorkspacePath: z.string(),
	/** Second real workspace path (used for the "one path, one workspace" check). */
	secondaryWorkspacePath: z.string(),
	/** A path that does not exist (used for the `resolveByPath` rejection check). */
	missingWorkspacePath: z.string(),
	/** An existing directory used to create a throwaway duplicate-title workspace. */
	fixtureWorkspacePath: z.string(),
	/** The task text dispatched to the probe session. */
	probePrompt: z.string(),
	/** Milliseconds to wait for one dispatched turn to reach `turn/end`. */
	turnTimeoutMs: z.number().default(180000)
})

/** Marker embedded in every injected context block so the durable log can be grepped. */
const INJECT_MARK = 'AIKANBAN-PROBE-CONTEXT'

/** ISO timestamp helper. */
const now = () => new Date().toISOString()

/** Bounded sleep. */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Best-effort plain-JSON projection of a thrown value. */
function errorShape(error) {
	return {
		name: error?.name ?? typeof error,
		message: String(error?.message ?? error),
		code: error?.code ?? null,
		details: error?.details ?? null,
		stack: typeof error?.stack === 'string' ? error.stack.split('\n').slice(0, 12).join('\n') : null
	}
}

/** Flatten one message content array into a single searchable string. */
function contentText(content) {
	if (!Array.isArray(content)) return ''
	return content.map((block) => (block && block.type === 'text' ? block.text : `[${block?.type ?? '?'}]`)).join('')
}

/**
 * Register the probe plugin.
 *
 * @param ctx - plugin context carrying the host services named in {@link inject}.
 * @param config - validated {@link Config}.
 */
export function apply(ctx, config) {
	const report = {
		probe: name,
		startedAt: now(),
		host: {
			pid: process.pid,
			dshHome: process.env.DSH_HOME ?? null,
			cwd: process.cwd()
		},
		steps: [],
		preStepCalls: [],
		injectedContextText: null,
		verdict: {}
	}

	/** Record one probe step; a throw is captured, never fatal. */
	async function step(id, title, fn) {
		const entry = { id, title, startedAt: now(), ok: false, detail: null, data: null }
		report.steps.push(entry)
		try {
			const data = await fn()
			entry.ok = true
			entry.data = data === undefined ? null : data
			entry.detail = 'ok'
			process.stderr.write(`AIKANBAN-PROBE [ok] ${id} ${title}\n`)
		} catch (error) {
			entry.ok = false
			entry.detail = errorShape(error)
			process.stderr.write(`AIKANBAN-PROBE [FAIL] ${id} ${title}: ${String(error?.message ?? error)}\n`)
		}
		entry.finishedAt = now()
		return entry
	}

	function writeReport() {
		try {
			mkdirSync(dirname(config.reportPath), { recursive: true })
			writeFileSync(config.reportPath, `${JSON.stringify(report, null, 2)}\n`)
			process.stderr.write(`AIKANBAN-PROBE report written: ${config.reportPath}\n`)
		} catch (error) {
			process.stderr.write(`AIKANBAN-PROBE failed to write report: ${String(error)}\n`)
		}
	}

	/**
	 * Write the report and ask the launcher to shut the tree down through the
	 * ordinary `ctx.appExit` channel, so the isolated host terminates cleanly
	 * instead of hanging on the services it mounted.
	 */
	function finish() {
		writeReport()
		const exit = ctx.get('appExit')
		if (typeof exit === 'function') {
			process.stderr.write('AIKANBAN-PROBE requesting ctx.appExit(0)\n')
			exit(0)
		} else {
			process.stderr.write('AIKANBAN-PROBE no ctx.appExit available; probe left running\n')
		}
	}

	// ---------------------------------------------------------------- projection
	// Mirrors dsh-time-context: a pure fold that counts *durable* events carrying
	// this plugin's own source marker. This is the authoritative "exactly once"
	// counter because it only ever sees committed events.
	const probeStateSchema = z.object({
		injections: z.array(z.object({
			seq: z.number(),
			time: z.number(),
			text: z.string()
		})),
		dispatched: z.array(z.object({ seq: z.number(), text: z.string() })),
		steps: z.array(z.object({ turn: z.number(), step: z.number() })),
		turns: z.array(z.number())
	})
	ctx.sessionProjections.register({
		key: 'aikanbanProbe',
		stateVersion: 1,
		stateSchema: probeStateSchema,
		init: () => ({ injections: [], dispatched: [], steps: [], turns: [] }),
		apply: (state, event) => {
			if (event.type === 'turn/start') {
				return { ...state, turns: [...state.turns, event.data.turn] }
			}
			if (event.type === 'step/start') {
				return { ...state, steps: [...state.steps, { turn: event.data.turn, step: event.data.step }] }
			}
			if (event.type === 'user/message') {
				const source = event.data.source
				const injected = source.kind === 'plugin' && source.plugin === name
				const dispatched = source.kind === 'user' && typeof source.rpcId === 'string'
				if (!injected && !dispatched) return state
				return {
					...state,
					injections: injected
						? [...state.injections, { seq: event.seq, time: event.time, text: contentText(event.data.content) }]
						: state.injections,
					dispatched: dispatched
						? [...state.dispatched, { seq: event.seq, text: contentText(event.data.content) }]
						: state.dispatched
				}
			}
			return state
		}
	})

	// ------------------------------------------------------------- pre-step hook
	// Only the probe session receives injected context, so a mis-scheduled run can
	// never leak background text into an unrelated session.
	let injectIntoSessionId = null

	ctx.on('agent/pre-step', async ({ agent, turn, step: stepNo, signal }, next) => {
		const decision = await next()
		const call = {
			sessionId: String(agent.id),
			turn,
			step: stepNo,
			decisionKind: decision.kind,
			incomingMessages: decision.kind === 'enter' ? decision.messages.length : null,
			aborted: signal.aborted,
			injected: false,
			at: now()
		}
		report.preStepCalls.push(call)
		if (decision.kind === 'reject' || signal.aborted) return decision
		// `agent/pre-step` fires once per STEP, not once per prompt: gate explicitly.
		if (stepNo !== 1) return decision
		if (injectIntoSessionId === null || String(agent.id) !== injectIntoSessionId) return decision
		const text = [
			`${INJECT_MARK} (turn ${turn}, step ${stepNo})`,
			'AIKanBan probe background block: this text is injected context, not a human instruction.',
			`nonce=${report.startedAt}`
		].join('\n')
		report.injectedContextText = text
		call.injected = true
		call.injectedText = text
		return {
			...decision,
			messages: [...decision.messages, createUserMessage({
				content: [{ type: 'text', text }],
				source: {
					kind: 'plugin',
					plugin: name,
					form: 'snapshot',
					sections: [{ name, text }]
				}
			})]
		}
	}, { prepend: true })

	// --------------------------------------------------------------------- drive
	void (async () => {
		const probeSessionIds = {}
		let probeSession = null
		let agent = null

		// ---- item D/2: workspace (project) mapping -------------------------
		await step('workspace.list', 'List durable workspaces', async () => {
			const list = ctx.workspaceRegistry.list()
			return list.map((ws) => ({ id: String(ws.id), path: ws.path, title: ws.title, sessionCount: ws.sessionIds.length }))
		})

		await step('workspace.resolveByPath.primary', 'Resolve the real AIKanBan workspace by canonical path', async () => {
			const ws = await ctx.workspaceRegistry.resolveByPath(config.primaryWorkspacePath)
			if (ws === undefined) throw new Error(`no workspace owns ${config.primaryWorkspacePath}`)
			return { id: String(ws.id), path: ws.path, title: ws.title, status: await ws.status() }
		})

		await step('workspace.resolveByPath.secondary', 'Resolve the second real workspace by canonical path', async () => {
			const ws = await ctx.workspaceRegistry.resolveByPath(config.secondaryWorkspacePath)
			if (ws === undefined) throw new Error(`no workspace owns ${config.secondaryWorkspacePath}`)
			return { id: String(ws.id), path: ws.path, title: ws.title, status: await ws.status() }
		})

		await step('workspace.create.idempotent', 'Re-creating a workspace for an owned path reuses the entity', async () => {
			const before = await ctx.workspaceRegistry.resolveByPath(config.primaryWorkspacePath)
			const again = await ctx.workspaceRegistry.create(config.primaryWorkspacePath, 'AIKanBan')
			const total = ctx.workspaceRegistry.list().length
			return {
				beforeId: String(before.id),
				afterId: String(again.id),
				sameId: String(before.id) === String(again.id),
				titleAfterCreate: again.title,
				workspaceCount: total
			}
		})

		await step('workspace.create.duplicateTitle', 'Two distinct paths may share one display title', async () => {
			mkdirSync(config.fixtureWorkspacePath, { recursive: true })
			const created = await ctx.workspaceRegistry.create(config.fixtureWorkspacePath, 'AIKanBan')
			const live = ctx.workspaceRegistry.list().filter((ws) => ws.title === 'AIKanBan')
			return {
				fixtureId: String(created.id),
				fixturePath: created.path,
				workspacesTitledAIKanBan: live.map((ws) => ({ id: String(ws.id), path: ws.path })),
				distinctIds: new Set(live.map((ws) => String(ws.id))).size
			}
		})

		await step('workspace.resolveByPath.missing', 'A nonexistent path rejects instead of resolving', async () => {
			try {
				await ctx.workspaceRegistry.resolveByPath(config.missingWorkspacePath)
				throw new Error('resolveByPath unexpectedly resolved a nonexistent path')
			} catch (error) {
				return { rejected: true, error: errorShape(error) }
			}
		})

		await step('workspace.pathUnavailable', 'A workspace whose directory vanished reports missing-dir but keeps its record', async () => {
			const gone = config.fixtureWorkspacePath
			const ws = await ctx.workspaceRegistry.create(gone, 'AIKanBan')
			const { rmSync } = await import('node:fs')
			rmSync(gone, { recursive: true, force: true })
			return {
				id: String(ws.id),
				status: await ws.status(),
				stillListed: ctx.workspaceRegistry.list().some((row) => String(row.id) === String(ws.id)),
				resolveRejected: await ctx.workspaceRegistry.resolveByPath(gone).then(() => false, () => true)
			}
		})

		// ---- item A/B: create a session bound to the real workspace ---------
		const primary = await ctx.workspaceRegistry.resolveByPath(config.primaryWorkspacePath)
		if (primary === undefined) {
			report.verdict.fatal = 'primary workspace could not be resolved; probe aborted'
			finish()
			return
		}

		await step('session.create.byWorkspaceId', 'create({workspaceId}) sets cwd from the workspace and attaches', async () => {
			const created = await ctx.sessionController.create({ workspaceId: primary.id })
			probeSessionIds.main = String(created.sessionId)
			const attached = await ctx.workspaceRegistry.get(primary.id)
			const header = (await ctx.sessionController.inspect(created.sessionId)).meta
			return {
				sessionId: String(created.sessionId),
				agentPreset: created.agentPreset ?? null,
				headerCwd: header.cwd ?? null,
				headerOrigin: header.origin ?? null,
				attachedToWorkspace: attached.sessionIds.map(String).includes(String(created.sessionId))
			}
		})

		probeSession = ctx.sessions.get(probeSessionIds.main)
		if (probeSession === undefined) {
			report.verdict.fatal = 'probe session is not live; probe aborted'
			finish()
			return
		}
		injectIntoSessionId = probeSessionIds.main

		await step('session.resolveAgent', 'resolveAgent() yields the live Agent for the probe session', async () => {
			agent = await ctx.sessionController.resolveAgent(probeSessionIds.main)
			return { agentId: String(agent.id), hasSession: agent.session !== undefined }
		})

		// ---- item D/2 boundary: attachSession rejects a cwd mismatch --------
		await step('workspace.attachSession.cwdMismatch', 'attachSession rejects a session whose cwd is another workspace', async () => {
			const other = await ctx.workspaceRegistry.resolveByPath(config.secondaryWorkspacePath)
			if (other === undefined) throw new Error('secondary workspace missing')
			try {
				await other.attachSession(probeSessionIds.main)
				throw new Error('attachSession unexpectedly accepted a cwd mismatch')
			} catch (error) {
				return { rejected: true, error: errorShape(error) }
			}
		})

		await step('workspace.attachSession.noCwd', 'attachSession rejects a session whose header carries no cwd', async () => {
			// A session created in the store without `meta.cwd` has `header.cwd === undefined`.
			const bare = ctx.sessions.create(undefined, { meta: {} })
			try {
				await primary.attachSession(bare.id)
				throw new Error('attachSession unexpectedly accepted a cwd-less session')
			} catch (error) {
				return { bareSessionId: String(bare.id), headerCwd: bare.header.cwd ?? null, rejected: true, error: errorShape(error) }
			}
		})

		// ---- item C2: subagent-origin session must be refused ---------------
		await step('dispatch.subagentGuard', 'prompt() refuses an origin:subagent session', async () => {
			const child = ctx.sessions.create(undefined, { meta: { cwd: config.primaryWorkspacePath, origin: 'subagent' } })
			probeSessionIds.subagent = String(child.id)
			try {
				await ctx.sessionController.prompt({
					requestId: `aikanban-probe-subguard-${Date.now()}`,
					sessionId: child.id,
					mode: 'queue',
					content: [{ type: 'text', text: 'this dispatch must be refused' }]
				}, new AbortController().signal)
				throw new Error('prompt unexpectedly accepted a subagent-origin session')
			} catch (error) {
				const shape = errorShape(error)
				// Assert the DOCUMENTED refusal, not merely "something threw": a
				// TypeError here would otherwise masquerade as the guard working.
				if (shape.code !== 'session/agent-busy' || !shape.message.includes('owned by subagent routing')) {
					throw new Error(`expected session/agent-busy "owned by subagent routing", got ${JSON.stringify(shape)}`)
				}
				return { childSessionId: String(child.id), childOrigin: child.header.origin, refused: true, error: shape }
			}
		})

		// ---- item A: dispatch one visible message (queue mode) --------------
		const requestId = `aikanban-probe-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
		const promptText = `${config.probePrompt}\n\n[probe-request-id ${requestId}]`

		await step('dispatch.prompt.queue', 'sessionController.prompt(queue) accepts a marked visible message', async () => {
			// The service face is a Typert Remote façade: `prompt(request, signal)`
			// dereferences the signal before delegating, so a caller must supply one.
			const accepted = await ctx.sessionController.prompt({
				requestId,
				sessionId: probeSessionIds.main,
				mode: 'queue',
				content: [{ type: 'text', text: promptText }]
			}, new AbortController().signal)
			if (accepted?.accepted !== true) throw new Error(`prompt did not acknowledge: ${JSON.stringify(accepted)}`)
			return { accepted, requestId, promptText }
		})

		// A refused dispatch can never produce a turn, so do not burn the full timeout.
		const dispatchAccepted = report.steps.find((row) => row.id === 'dispatch.prompt.queue')?.ok === true
		const waitBudgetMs = dispatchAccepted ? config.turnTimeoutMs : 3000

		const waited = await step('readback.turnEnd', 'Wait for the dispatched turn to reach turn/end, then read events back', async () => {
			const deadline = Date.now() + waitBudgetMs
			let inspection = await ctx.sessionController.inspect(probeSessionIds.main)
			while (!inspection.events.some((event) => event.type === 'turn/end')) {
				if (Date.now() > deadline) break
				await sleep(500)
				inspection = await ctx.sessionController.inspect(probeSessionIds.main)
			}
			const events = inspection.events
			const dispatched = events.find((event) => event.type === 'user/message'
				&& event.data.source.kind === 'user' && event.data.source.rpcId === requestId)
			const assistant = events.filter((event) => event.type === 'assistant/message')
			const last = assistant.at(-1)
			const turnEnd = events.find((event) => event.type === 'turn/end')
			return {
				totalEvents: events.length,
				lastSeq: events.length === 0 ? null : events[events.length - 1].seq,
				inheritedEventCount: inspection.inheritedEventCount,
				turnEnded: turnEnd !== undefined,
				turnEndReason: turnEnd === undefined ? null : turnEnd.data.reason,
				dispatchedSeq: dispatched?.seq ?? null,
				dispatchedTextMatches: dispatched === undefined ? null : contentText(dispatched.data.content) === promptText,
				assistantTurns: assistant.map((event) => ({ seq: event.seq, turn: event.data.turn, step: event.data.step })),
				lastAssistantText: last === undefined ? null : contentText(last.data.message.content).slice(0, 800),
				eventDigest: events.map((event) => ({
					seq: event.seq,
					type: event.type,
					turn: event.data?.turn ?? null,
					step: event.data?.step ?? null,
					sourceKind: event.data?.source?.kind ?? null,
					sourcePlugin: event.data?.source?.plugin ?? null
				}))
			}
		})

		const readBack = report.steps.find((row) => row.id === 'readback.turnEnd')?.data ?? {}

		// ---- item C1: requestId idempotency ---------------------------------
		await step('dispatch.requestIdIdempotent', 'Re-using the same requestId is acknowledged but delivers nothing', async () => {
			// Gate on the real precondition: "no duplicate" is vacuous unless the
			// first dispatch actually landed as a durable user/message.
			if (!dispatchAccepted) throw new Error('precondition unmet: the first dispatch was refused, so idempotency is unobservable')
			if (readBack.dispatchedSeq === null || readBack.dispatchedSeq === undefined) {
				throw new Error('precondition unmet: the first dispatch left no durable user/message to deduplicate against')
			}
			const before = (await ctx.sessionController.inspect(probeSessionIds.main)).events
				.filter((event) => event.type === 'user/message').length
			const again = await ctx.sessionController.prompt({
				requestId,
				sessionId: probeSessionIds.main,
				mode: 'queue',
				content: [{ type: 'text', text: 'THIS SECOND DELIVERY MUST NOT APPEAR' }]
			}, new AbortController().signal)
			await sleep(1500)
			const events = (await ctx.sessionController.inspect(probeSessionIds.main)).events
			const after = events.filter((event) => event.type === 'user/message').length
			const leaked = events.some((event) => event.type === 'user/message'
				&& contentText(event.data.content).includes('THIS SECOND DELIVERY MUST NOT APPEAR'))
			return {
				secondAccepted: again,
				userMessagesBefore: before,
				userMessagesAfter: after,
				duplicateCreated: after !== before,
				secondPayloadLeaked: leaked
			}
		})

		// ---- item D: exactly-once + multi-step + turn-outline ---------------
		await step('readback.followSnapshot', 'follow() streams an opening snapshot carrying the dispatched turn', async () => {
			if (!dispatchAccepted) throw new Error('precondition unmet: nothing was dispatched, so the log has no turn to stream')
			const controller = new AbortController()
			const frames = []
			const openAt = Date.now()
			// `follow` is the client-facing durable-log stream; its first frame is the
			// complete opening snapshot. Abort after the baseline so the tail never
			// keeps this one-shot host alive.
			const iterate = async () => {
				for await (const frame of ctx.sessionController.follow(
					{ address: { kind: 'session', sessionId: probeSessionIds.main } },
					controller.signal
				)) {
					frames.push(frame)
					if (frames.length >= 1) break
				}
			}
			await Promise.race([
				iterate(),
				sleep(20000).then(() => { controller.abort() })
			])
			controller.abort()
			const snapshot = frames.find((frame) => frame.type === 'snapshot')
			if (snapshot === undefined) throw new Error(`no snapshot frame; frames=${JSON.stringify(frames.map((f) => f.type))}`)
			const recordTypes = snapshot.records.map((record) => record.event.type)
			return {
				elapsedMs: Date.now() - openAt,
				frameTypes: frames.map((frame) => frame.type),
				cursor: snapshot.cursor,
				recordCount: snapshot.records.length,
				recordTypes,
				hasDispatchedMessage: snapshot.records.some((record) => record.event.type === 'user/message'
					&& record.event.data.source.kind === 'user' && record.event.data.source.rpcId === requestId),
				hasMore: snapshot.hasMore,
				projectionKeysAtSnapshot: Object.keys(snapshot.projections?.values ?? {})
			}
		})

		await step('readback.page', 'page() reads a cold-safe history page through the last event', async () => {
			if (!dispatchAccepted) throw new Error('precondition unmet: nothing was dispatched, so there is nothing to page')
			const inspection = await ctx.sessionController.inspect(probeSessionIds.main)
			const last = inspection.events.at(-1)
			const page = await ctx.sessionController.page({
				address: { kind: 'session', sessionId: probeSessionIds.main },
				throughSeq: last.seq,
				maxMessages: 20
			}, new AbortController().signal)
			if (!Array.isArray(page?.records)) throw new Error(`page() returned no records: ${JSON.stringify(page)}`)
			return {
				throughSeq: last.seq,
				recordCount: page.records.length,
				hasMore: page.hasMore,
				types: page.records.map((record) => record.event.type),
				includesTurnEnd: page.records.some((record) => record.event.type === 'turn/end'),
				includesInjectedBlock: page.records.some((record) => record.event.type === 'user/message'
					&& record.event.data.source.kind === 'plugin' && record.event.data.source.plugin === name)
			}
		})

		await step('inject.projectionExactlyOnce', 'Durable log carries the injected block exactly once', async () => {
			if (!dispatchAccepted) throw new Error('precondition unmet: nothing was dispatched, so no injection could occur')
			const events = (await ctx.sessionController.inspect(probeSessionIds.main)).events
			const injected = events.filter((event) => event.type === 'user/message'
				&& event.data.source.kind === 'plugin' && event.data.source.plugin === name)
			const projectionState = ctx.sessionProjections.stateOf(probeSession, 'aikanbanProbe')
			if (injected.length !== 1) throw new Error(`expected exactly 1 durable injected user/message, found ${injected.length}`)
			if ((projectionState?.injections.length ?? -1) !== 1) {
				throw new Error(`projection counted ${String(projectionState?.injections.length)} injections, expected 1`)
			}
			return {
				injectedEventCount: injected.length,
				injectedSeqs: injected.map((event) => event.seq),
				projectionInjectionCount: projectionState?.injections.length ?? null,
				projectionInjections: projectionState?.injections ?? null,
				dispatchedSeqs: projectionState?.dispatched.map((row) => row.seq) ?? null,
				projectionSteps: projectionState?.steps ?? null,
				projectionTurns: projectionState?.turns ?? null,
				markerPresentInLog: injected.some((event) => contentText(event.data.content).includes(INJECT_MARK)),
				injectedSourceForm: injected[0]?.data.source.form ?? null
			}
		})

		await step('inject.multiStepOnlyOnce', 'Pre-step fired per step; injection committed only at step 1', async () => {
			if (!dispatchAccepted) throw new Error('precondition unmet: nothing was dispatched, so no step could run')
			const calls = report.preStepCalls.filter((call) => call.sessionId === probeSessionIds.main)
			const injectedCalls = calls.filter((call) => call.injected)
			const projectionState = ctx.sessionProjections.stateOf(probeSession, 'aikanbanProbe')
			if (calls.length === 0) throw new Error('precondition unmet: agent/pre-step never fired')
			if (injectedCalls.length !== 1) throw new Error(`injected at ${injectedCalls.length} steps, expected 1`)
			if (injectedCalls[0].step !== 1) throw new Error(`injected at step ${injectedCalls[0].step}, expected step 1`)
			return {
				preStepCallCount: calls.length,
				preStepCalls: calls.map((call) => ({ turn: call.turn, step: call.step, injected: call.injected, incomingMessages: call.incomingMessages })),
				injectedCallCount: injectedCalls.length,
				distinctStepsSeen: [...new Set(calls.map((call) => `${call.turn}/${call.step}`))],
				multiStepObserved: new Set(calls.map((call) => `${call.turn}/${call.step}`)).size > 1,
				projectionStepCount: projectionState?.steps.length ?? null,
				projectionInjectionCount: projectionState?.injections.length ?? null
			}
		})

		await step('inject.turnOutline', 'turnOutline neither shows the injected block as a prompt nor merges it', async () => {
			if (!dispatchAccepted) throw new Error('precondition unmet: nothing was dispatched, so no turn exists to outline')
			const snapshot = ctx.sessionProjections.snapshot(probeSession)
			const outline = snapshot.values.turnOutline
			if (outline === undefined) throw new Error('the turnOutline projection is not registered in this host')
			const dispatchedPreview = promptText.split('\n')[0].slice(0, 20)
			const rows = outline
			if (!rows.some((row) => row.prompt.includes(dispatchedPreview))) {
				throw new Error(`no outline entry carries the dispatched prompt preview; got ${JSON.stringify(rows)}`)
			}
			if (rows.some((row) => row.prompt.includes(INJECT_MARK))) {
				throw new Error('the injected context block leaked into the turn outline as a prompt')
			}
			return {
				asOfSeq: snapshot.asOfSeq,
				availableKeys: Object.keys(snapshot.values),
				outline: rows,
				outlinePromptLooksLikeDispatch: rows.some((row) => row.prompt.includes(dispatchedPreview)),
				outlinePromptContainsInjectMark: rows.some((row) => row.prompt.includes(INJECT_MARK)),
				dispatchedPreview
			}
		})

		// ---- report ----------------------------------------------------------
		const projectionFinal = ctx.sessionProjections.stateOf(probeSession, 'aikanbanProbe')
		const stepById = (id) => report.steps.find((row) => row.id === id)
		report.verdict = {
			dispatchAccepted: stepById('dispatch.prompt.queue')?.ok ?? false,
			readBackTurnEnded: stepById('readback.turnEnd')?.data?.turnEnded ?? false,
			readBackDispatchedSeq: stepById('readback.turnEnd')?.data?.dispatchedSeq ?? null,
			readBackTextMatches: stepById('readback.turnEnd')?.data?.dispatchedTextMatches ?? null,
			assistantReplyCount: stepById('readback.turnEnd')?.data?.assistantTurns?.length ?? 0,
			turnEndReason: stepById('readback.turnEnd')?.data?.turnEndReason ?? null,
			requestIdIdempotent: stepById('dispatch.requestIdIdempotent')?.ok === true
				&& stepById('dispatch.requestIdIdempotent')?.data?.duplicateCreated === false
				&& stepById('dispatch.requestIdIdempotent')?.data?.secondPayloadLeaked === false,
			subagentRefused: stepById('dispatch.subagentGuard')?.ok ?? false,
			injectedExactlyOnce: stepById('inject.projectionExactlyOnce')?.ok === true
				&& (projectionFinal?.injections.length ?? 0) === 1,
			injectionOnlyAtStepOne: stepById('inject.multiStepOnlyOnce')?.ok === true,
			multiStepObserved: stepById('inject.multiStepOnlyOnce')?.data?.multiStepObserved ?? false,
			outlineClean: stepById('inject.turnOutline')?.ok === true,
			workspaceMappingAllOk: report.steps.filter((row) => row.id.startsWith('workspace.') || row.id.startsWith('session.create')).every((row) => row.ok),
			probeSessionId: probeSessionIds.main ?? null,
			probeSessionCwd: probeSession?.header.cwd ?? null,
			subagentFixtureSessionId: probeSessionIds.subagent ?? null
		}
		report.finishedAt = now()
		finish()
		process.stderr.write(`AIKANBAN-PROBE DONE ${JSON.stringify(report.verdict)}\n`)
	})().catch((error) => {
		report.verdict.fatal = errorShape(error)
		report.finishedAt = now()
		finish()
		process.stderr.write(`AIKANBAN-PROBE FATAL ${String(error?.stack ?? error)}\n`)
	})
}
