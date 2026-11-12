/**
 * Wire contract guards (Q1=B / Q2=A).
 *
 * These tests pin the boundary the two halves agree on:
 * - `board/read` carries an explicit `projectId`; a missing/empty id is
 *   malformed, never "the current project";
 * - every write carries a canonical `ver1:<n>` baseline;
 * - undo carries two distinct identities (this undo vs the write being undone);
 * - a task snapshot carries the numeric baseline and its undo credential, and a
 *   malformed/missing one is refused rather than defaulted.
 */
import { describe, expect, it } from 'vitest'

import {
  BOARD_ENDPOINT_LIST,
  BOARD_ENDPOINTS,
  BOARD_FAILURE_CODES,
  encodeFieldsVersion,
  encodeStatusVersion,
  isBoardFailureCode,
  parseActivityPayload,
  parseActivityValue,
  parseBoardSnapshotValue,
  parseBoardTask,
  parseCreateTaskFailureDetails,
  parseCreateTaskPayload,
  parseCreateTaskValue,
  parseFieldsBaselineValue,
  parseFieldsVersion,
  parseKeptFieldInput,
  parseKeptTaskInput,
  parseProjectListPayload,
  parseProjectListValue,
  parseReadBoardPayload,
  parseReorderPayload,
  parseSetStatusPayload,
  parseStatusVersion,
  parseSummaryDraftSavePayload,
  parseSummaryDraftSaveValue,
  parseSummaryReadPayload,
  parseSummaryReadValue,
  parseSummarySaveFailureDetails,
  parseSummarySavePayload,
  parseSummarySaveValue,
  parseUndoStatusPayload,
  parseUpdateFieldsFailureDetails,
  parseUpdateFieldsPayload,
  parseUpdateFieldsValue,
} from '../src/wire.js'

const PROJECT = {
  projectId: 'ws-1',
  title: 'Demo',
  workScopeAvailability: 'ok' as const,
  workScopeAllowed: true,
}

const COLUMNS = [
  { status: 'todo', label: '未开始', collapsedByDefault: false },
  { status: 'doing', label: '进行中', collapsedByDefault: false },
]

const TASK = {
  taskId: 'task-1',
  projectId: 'ws-1',
  title: 'First task',
  goal: 'Ship it',
  status: 'todo',
  statusLabel: '未开始',
  order: 0,
  statusRevision: 4,
  undoTarget: { statusVersion: 'ver1:3', appliedUpdateId: 'op-7' },
}

const SNAPSHOT = {
  project: PROJECT,
  tasks: [TASK],
  columns: COLUMNS,
  boardToken: 'tok-1',
  capabilities: { statusChange: true, reorder: true, undo: true },
}

describe('status version encoding (ver1:<n>)', () => {
  it('round-trips canonical encodings', () => {
    expect(encodeStatusVersion(0)).toBe('ver1:0')
    expect(encodeStatusVersion(7)).toBe('ver1:7')
    expect(parseStatusVersion('ver1:0')).toBe(0)
    expect(parseStatusVersion('ver1:7')).toBe(7)
    expect(parseStatusVersion(encodeStatusVersion(42))).toBe(42)
  })

  it('refuses everything that is not canonical, never defaulting to 0', () => {
    const malformed: unknown[] = [
      '', '0', 'ver1:', 'ver1:-1', 'ver1:01', 'ver1:1.5', 'ver1: 1', 'ver1:1e3', 'v1:2', '2',
      0, 1, null, undefined, {}, [],
    ]
    for (const value of malformed) {
      expect(parseStatusVersion(value), `accepted ${JSON.stringify(value)}`).toBeNull()
    }
  })

  it('refuses to encode something that is not a non-negative integer revision', () => {
    expect(() => encodeStatusVersion(-1)).toThrow(RangeError)
    expect(() => encodeStatusVersion(1.5)).toThrow(RangeError)
    expect(() => encodeStatusVersion(Number.NaN)).toThrow(RangeError)
  })
})

describe('payload guards: explicit project and required baselines', () => {
  it('requires a non-empty projectId on board/read', () => {
    expect(parseReadBoardPayload(null)).toBeNull()
    expect(parseReadBoardPayload(undefined)).toBeNull()
    expect(parseReadBoardPayload({})).toBeNull()
    expect(parseReadBoardPayload({ projectId: '' })).toBeNull()
    expect(parseReadBoardPayload({ projectId: 5 })).toBeNull()
    expect(parseReadBoardPayload({ projectId: 'ws-1' })).toEqual({ projectId: 'ws-1' })
  })

  it('requires expectedStatusVersion on status.set and reorder', () => {
    const setBase = { taskId: 'task-1', next: 'doing', operationId: 'op-1' }
    expect(parseSetStatusPayload(setBase)).toBeNull()
    expect(parseSetStatusPayload({ ...setBase, expectedStatusVersion: '' })).toBeNull()
    expect(parseSetStatusPayload({ ...setBase, expectedStatusVersion: 'ver1:0' })).toMatchObject({
      taskId: 'task-1',
      expectedStatusVersion: 'ver1:0',
    })

    const reorderBase = { taskId: 'task-1', status: 'todo', toIndex: 1, operationId: 'op-2' }
    expect(parseReorderPayload(reorderBase)).toBeNull()
    expect(parseReorderPayload({ ...reorderBase, expectedStatusVersion: 'ver1:2' })).toMatchObject({
      toIndex: 1,
      expectedStatusVersion: 'ver1:2',
    })
  })

  it('requires both undo identities and a baseline on status.undo', () => {
    const base = { taskId: 'task-1', operationId: 'undo-1', expectedStatusVersion: 'ver1:3' }
    expect(parseUndoStatusPayload(base)).toBeNull()
    expect(parseUndoStatusPayload({ ...base, appliedUpdateId: '' })).toBeNull()
    expect(parseUndoStatusPayload({ ...base, appliedUpdateId: 'op-prev' })).toMatchObject({
      operationId: 'undo-1',
      appliedUpdateId: 'op-prev',
      expectedStatusVersion: 'ver1:3',
    })
  })
})

describe('snapshot guards: baseline and undo credential', () => {  it('parses a snapshot carrying statusRevision and undoTarget', () => {
    const parsed = parseBoardSnapshotValue(SNAPSHOT)
    expect(parsed).not.toBeNull()
    expect(parsed?.tasks[0]?.statusRevision).toBe(4)
    expect(parsed?.tasks[0]?.undoTarget).toEqual({ statusVersion: 'ver1:3', appliedUpdateId: 'op-7' })
  })

  it('accepts an explicit null undoTarget as "nothing to undo"', () => {
    const parsed = parseBoardTask({ ...TASK, undoTarget: null })
    expect(parsed).not.toBeNull()
    expect(parsed?.undoTarget).toBeNull()
  })

  it('refuses a task without statusRevision', () => {
    const { statusRevision: _omitted, ...withoutRevision } = TASK
    expect(parseBoardTask(withoutRevision)).toBeNull()
    expect(parseBoardTask({ ...TASK, statusRevision: -1 })).toBeNull()
    expect(parseBoardTask({ ...TASK, statusRevision: 1.5 })).toBeNull()
  })

  it('refuses a task whose undoTarget is missing or malformed', () => {
    const { undoTarget: _omitted, ...withoutTarget } = TASK
    expect(parseBoardTask(withoutTarget)).toBeNull()
    expect(parseBoardTask({ ...TASK, undoTarget: { appliedUpdateId: 'op-7' } })).toBeNull()
    expect(parseBoardTask({ ...TASK, undoTarget: { statusVersion: '3', appliedUpdateId: 'op-7' } })).toBeNull()
    expect(parseBoardTask({ ...TASK, undoTarget: { statusVersion: 'ver1:3', appliedUpdateId: '' } })).toBeNull()
  })
})

describe('project list guards: a candidate set, never a "current project"', () => {
  it('accepts only an object payload; a listing carries no selection', () => {
    expect(parseProjectListPayload({})).toEqual({})
    // A missing payload, a list, a bare string and an id are all malformed:
    // listing has no way to express "read the current project" (Q1=B).
    for (const value of [null, undefined, [], ['ws-1'], 'ws-1', 5]) {
      expect(parseProjectListPayload(value), `accepted ${JSON.stringify(value)}`).toBeNull()
    }
  })

  it('parses id/title/path items, keeps an empty list legal, and refuses malformed entries', () => {
    const projects = [
      { projectId: 'ws-1', title: 'Demo', path: 'C:/demo' },
      { projectId: 'ws-2', title: 'Demo', path: 'D:/two' },
    ]
    expect(parseProjectListValue({ projects })).toEqual({ projects })
    // An empty candidate set is a successful answer, not an error.
    expect(parseProjectListValue({ projects: [] })).toEqual({ projects: [] })

    const malformed: unknown[] = [
      null,
      undefined,
      {},
      { projects: 'not-an-array' },
      { projects: [null] },
      { projects: [{ projectId: '', title: 't', path: 'p' }] },
      { projects: [{ projectId: 7, title: 't', path: 'p' }] },
      // Missing title / path: the selector needs both to disambiguate.
      { projects: [{ projectId: 'ws-1', path: 'p' }] },
      { projects: [{ projectId: 'ws-1', title: 't' }] },
      { projects: [{ projectId: 'ws-1', title: 't', path: 7 }] },
    ]
    for (const value of malformed) {
      expect(parseProjectListValue(value), `accepted ${JSON.stringify(value)}`).toBeNull()
    }
  })
})

/* ------------------------------------------------------------------ *
 * Slice B: management endpoints, fver1 and the 9th failure code
 * ------------------------------------------------------------------ */

describe('slice-B endpoints and the invalid-input failure code', () => {
  it('publishes the three management endpoints without moving the existing five', () => {
    expect(BOARD_ENDPOINTS.readBoard).toBe('board/read')
    expect(BOARD_ENDPOINTS.listProjects).toBe('project/list')
    expect(BOARD_ENDPOINTS.setStatus).toBe('task/status.set')
    expect(BOARD_ENDPOINTS.reorder).toBe('task/reorder')
    expect(BOARD_ENDPOINTS.undoStatusChange).toBe('task/status.undo')
    expect(BOARD_ENDPOINTS.taskCreate).toBe('task/create')
    expect(BOARD_ENDPOINTS.taskFieldsUpdate).toBe('task/fields.update')
    expect(BOARD_ENDPOINTS.activityRead).toBe('activity/read')
    for (const endpoint of Object.values(BOARD_ENDPOINTS)) {
      expect(BOARD_ENDPOINT_LIST).toContain(endpoint)
    }
  })

  it('adds invalid-input as the ninth code and keeps the original eight unchanged', () => {
    // The code table is part of the contract: both halves enumerate it, and an
    // unknown host code is narrowed to save-failed/read-failed. Slice B added
    // exactly one code, so the count is pinned instead of implied.
    expect(BOARD_FAILURE_CODES).toHaveLength(9)
    expect(BOARD_FAILURE_CODES).toEqual([
      'invalid-reason',
      'invalid-input',
      'not-found',
      'save-failed',
      'stale-baseline',
      'unknown-result',
      'read-failed',
      'unknown-project',
      'unavailable',
    ])
    for (const code of ['invalid-reason', 'not-found', 'save-failed', 'stale-baseline', 'unknown-result', 'read-failed', 'unknown-project', 'unavailable', 'invalid-input']) {
      expect(isBoardFailureCode(code), `refused the known code ${code}`).toBe(true)
    }
    expect(isBoardFailureCode('invalid-payload')).toBe(false)
    expect(isBoardFailureCode('')).toBe(false)
  })
})

describe('fields version encoding (fver1:<n>)', () => {
  it('round-trips canonical encodings and keeps the two prefixes distinct', () => {
    expect(encodeFieldsVersion(0)).toBe('fver1:0')
    expect(encodeFieldsVersion(7)).toBe('fver1:7')
    expect(parseFieldsVersion('fver1:0')).toBe(0)
    expect(parseFieldsVersion('fver1:7')).toBe(7)
    expect(parseFieldsVersion(encodeFieldsVersion(42))).toBe(42)
    // A status encoding is not a fields encoding and vice versa.
    expect(parseFieldsVersion('ver1:3')).toBeNull()
    expect(parseStatusVersion('fver1:3')).toBeNull()
  })

  it('refuses everything that is not canonical, never defaulting to 0', () => {
    const malformed: unknown[] = [
      '', '0', 'fver1:', 'fver1:-1', 'fver1:01', 'fver1:1.5', 'fver1: 1', 'fver1:1e3', 'fv1:2', '2',
      0, 1, null, undefined, {}, [],
    ]
    for (const value of malformed) {
      expect(parseFieldsVersion(value), `accepted ${JSON.stringify(value)}`).toBeNull()
    }
  })

  it('refuses to encode something that is not a non-negative integer revision', () => {
    expect(() => encodeFieldsVersion(-1)).toThrow(RangeError)
    expect(() => encodeFieldsVersion(1.5)).toThrow(RangeError)
    expect(() => encodeFieldsVersion(Number.NaN)).toThrow(RangeError)
  })
})

describe('task/create payload guard', () => {
  it('accepts the minimal and the fully specified payload', () => {
    expect(parseCreateTaskPayload({ projectId: 'ws-1', requestId: 'op-1', title: 'Task' })).toEqual({
      projectId: 'ws-1',
      requestId: 'op-1',
      title: 'Task',
    })
    expect(parseCreateTaskPayload({
      projectId: 'ws-1',
      requestId: 'op-1',
      title: 'Task',
      goal: 'Goal',
      initialStatus: 'blocked',
      blockedReason: 'waiting',
      ignoredExtra: 'not referenced',
    })).toEqual({
      projectId: 'ws-1',
      requestId: 'op-1',
      title: 'Task',
      goal: 'Goal',
      initialStatus: 'blocked',
      blockedReason: 'waiting',
    })
    // A blank title is shape-valid: core owns the rule and echoes the refusal.
    expect(parseCreateTaskPayload({ projectId: 'ws-1', requestId: 'op-1', title: '' })).not.toBeNull()
  })

  it('refuses a missing/empty address or a wrongly typed field', () => {
    const malformed: unknown[] = [
      null,
      undefined,
      'task/create',
      [],
      {},
      { projectId: '', requestId: 'op-1', title: 'T' },
      { projectId: 'ws-1', requestId: '', title: 'T' },
      { projectId: 'ws-1', title: 'T' },
      { projectId: 'ws-1', requestId: 'op-1' },
      { projectId: 'ws-1', requestId: 'op-1', title: 5 },
      { projectId: 'ws-1', requestId: 'op-1', title: 'T', goal: null },
      { projectId: 'ws-1', requestId: 'op-1', title: 'T', initialStatus: '' },
      { projectId: 'ws-1', requestId: 'op-1', title: 'T', blockedReason: 5 },
    ]
    for (const value of malformed) {
      expect(parseCreateTaskPayload(value), `accepted ${JSON.stringify(value)}`).toBeNull()
    }
  })
})

describe('task/fields.update payload guard', () => {
  const base = {
    taskId: 'task-1',
    requestId: 'field-1',
    expectedFieldsVersion: 'fver1:2',
    expectedStatusVersion: 'ver1:1',
  }

  it('keeps goal=null (clear) distinct from an absent goal (leave unchanged)', () => {
    expect(parseUpdateFieldsPayload({ ...base, title: 'New' })).toEqual({ ...base, title: 'New' })
    expect(parseUpdateFieldsPayload({ ...base, goal: null })).toEqual({ ...base, goal: null })
    expect(parseUpdateFieldsPayload({ ...base, goal: 'New goal' })).toEqual({ ...base, goal: 'New goal' })
    // Both may travel together; an empty object plus the baselines is shape-valid
    // (core owns the "nothing to save" refusal and echoes it as invalid-input).
    expect(parseUpdateFieldsPayload({ ...base, title: 'New', goal: null })).toEqual({ ...base, title: 'New', goal: null })
    expect(parseUpdateFieldsPayload(base)).toEqual(base)
    // The blank title is refused by core (invalid-title), not silently dropped here.
    expect(parseUpdateFieldsPayload({ ...base, title: '' })).not.toBeNull()
  })

  it('refuses missing baselines and wrongly typed fields', () => {
    const malformed: unknown[] = [
      null,
      undefined,
      [],
      {},
      { ...base, taskId: '' },
      { ...base, requestId: '' },
      { taskId: 'task-1', requestId: 'field-1', expectedStatusVersion: 'ver1:1' },
      { taskId: 'task-1', requestId: 'field-1', expectedFieldsVersion: 'fver1:2' },
      { ...base, expectedFieldsVersion: '' },
      { ...base, expectedStatusVersion: '' },
      { ...base, expectedFieldsVersion: 3 },
      { ...base, title: null },
      { ...base, title: 5 },
      { ...base, goal: 5 },
    ]
    for (const value of malformed) {
      expect(parseUpdateFieldsPayload(value), `accepted ${JSON.stringify(value)}`).toBeNull()
    }
  })
})

describe('activity payload guard', () => {
  it('accepts the two scopes and an optional non-negative limit', () => {
    expect(parseActivityPayload({ scopeKind: 'task', scopeId: 'task-1' })).toEqual({
      scopeKind: 'task',
      scopeId: 'task-1',
    })
    expect(parseActivityPayload({ scopeKind: 'project', scopeId: 'ws-1', limit: 5 })).toEqual({
      scopeKind: 'project',
      scopeId: 'ws-1',
      limit: 5,
    })
    // Zero is a legal cap (an explicitly empty page), not "no limit".
    expect(parseActivityPayload({ scopeKind: 'task', scopeId: 'task-1', limit: 0 })).toEqual({
      scopeKind: 'task',
      scopeId: 'task-1',
      limit: 0,
    })
  })

  it('refuses an unknown scope, a missing id and a malformed limit', () => {
    const malformed: unknown[] = [
      null,
      undefined,
      'task',
      [],
      {},
      { scopeKind: 'board', scopeId: 'x' },
      { scopeId: 'x' },
      { scopeKind: 'TASK', scopeId: 'x' },
      { scopeKind: 'task', scopeId: '' },
      { scopeKind: 'task', scopeId: 7 },
      { scopeKind: 'task', scopeId: 'x', limit: -1 },
      { scopeKind: 'task', scopeId: 'x', limit: 1.5 },
      { scopeKind: 'task', scopeId: 'x', limit: '2' },
    ]
    for (const value of malformed) {
      expect(parseActivityPayload(value), `accepted ${JSON.stringify(value)}`).toBeNull()
    }
  })
})

describe('slice-B value guards: known result plus view freshness', () => {
  it('parses a created value whose snapshot is present or explicitly null', () => {
    const created = parseCreateTaskValue({ outcome: 'created', task: TASK, snapshot: SNAPSHOT })
    expect(created?.outcome).toBe('created')
    expect(created?.task.taskId).toBe('task-1')
    expect(created?.snapshot?.boardToken).toBe('tok-1')

    const replayed = parseCreateTaskValue({ outcome: 'already-created', task: TASK, snapshot: SNAPSHOT })
    expect(replayed?.outcome).toBe('already-created')

    // The creation landed but the view could not be refreshed: honest null, not
    // an empty board and not a failure value.
    const stale = parseCreateTaskValue({ outcome: 'created', task: TASK, snapshot: null })
    expect(stale).not.toBeNull()
    expect(stale?.snapshot).toBeNull()
  })

  it('refuses a created value with a missing/invalid snapshot or task', () => {
    const malformed: unknown[] = [
      null,
      {},
      { outcome: 'created', task: TASK },
      { outcome: 'created', task: TASK, snapshot: 'not-a-snapshot' },
      { outcome: 'saved', task: TASK, snapshot: SNAPSHOT },
      { outcome: 'created', snapshot: SNAPSHOT },
      { outcome: 'created', task: { taskId: 't' }, snapshot: SNAPSHOT },
    ]
    for (const value of malformed) {
      expect(parseCreateTaskValue(value), `accepted ${JSON.stringify(value)}`).toBeNull()
    }
  })

  it('parses saved / no-change / already-applied and requires changed + fieldsRevision', () => {
    const saved = parseUpdateFieldsValue({
      outcome: 'saved',
      task: TASK,
      changed: ['title', 'goal'],
      fieldsRevision: 3,
      snapshot: SNAPSHOT,
    })
    expect(saved).toMatchObject({ outcome: 'saved', changed: ['title', 'goal'], fieldsRevision: 3 })

    const unchanged = parseUpdateFieldsValue({
      outcome: 'no-change',
      task: TASK,
      changed: [],
      fieldsRevision: 2,
      snapshot: null,
    })
    expect(unchanged?.snapshot).toBeNull()

    const replayed = parseUpdateFieldsValue({
      outcome: 'already-applied',
      task: TASK,
      changed: [],
      fieldsRevision: 1,
      snapshot: SNAPSHOT,
    })
    expect(replayed?.outcome).toBe('already-applied')

    const malformed: unknown[] = [
      null,
      {},
      { outcome: 'saved', task: TASK, changed: [], snapshot: SNAPSHOT },
      { outcome: 'saved', task: TASK, changed: ['title'], fieldsRevision: -1, snapshot: SNAPSHOT },
      { outcome: 'saved', task: TASK, changed: ['title'], fieldsRevision: 1.5, snapshot: SNAPSHOT },
      { outcome: 'saved', task: TASK, changed: ['status'], fieldsRevision: 1, snapshot: SNAPSHOT },
      { outcome: 'saved', task: TASK, changed: 'title', fieldsRevision: 1, snapshot: SNAPSHOT },
      { outcome: 'created', task: TASK, changed: [], fieldsRevision: 1, snapshot: SNAPSHOT },
      { outcome: 'saved', task: TASK, changed: [], fieldsRevision: 1 },
    ]
    for (const value of malformed) {
      expect(parseUpdateFieldsValue(value), `accepted ${JSON.stringify(value)}`).toBeNull()
    }
  })

  it('parses activity entries newest-first, keeps details verbatim and allows an empty history', () => {
    const entry = {
      activityId: 'act-1',
      at: '2026-11-11T00:00:00.000Z',
      scopeKind: 'task' as const,
      scopeId: 'task-1',
      code: 'task-title-changed',
      summary: '标题已更新',
      details: { taskId: 'task-1', from: 'A', to: 'B' },
    }
    const parsed = parseActivityValue({ entries: [entry] })
    expect(parsed?.entries[0]).toEqual(entry)
    // An empty history is a legal success value, not an error.
    expect(parseActivityValue({ entries: [] })).toEqual({ entries: [] })

    const malformed: unknown[] = [
      null,
      {},
      { entries: 'none' },
      { entries: [null] },
      { entries: [{ ...entry, activityId: '' }] },
      { entries: [{ ...entry, scopeKind: 'board' }] },
      { entries: [{ ...entry, code: '' }] },
      { entries: [{ ...entry, details: { taskId: 1 } }] },
      { entries: [{ ...entry, details: null }] },
      { entries: [{ ...entry, at: '' }] },
    ]
    for (const value of malformed) {
      expect(parseActivityValue(value), `accepted ${JSON.stringify(value)}`).toBeNull()
    }
  })
})

describe('slice-B failure details guards', () => {
  it('parses a creation refusal echo', () => {
    const keptInput = { title: '  ', goal: 'g', initialStatus: 'blocked', blockedReason: null }
    expect(parseCreateTaskFailureDetails({ keptInput })).toEqual({ keptInput })
    expect(parseCreateTaskFailureDetails({ taskId: 'task-x', keptInput })).toEqual({ taskId: 'task-x', keptInput })
    // A malformed optional echo is dropped, never interpreted.
    expect(parseCreateTaskFailureDetails({ keptInput: { title: 'T' } })).toEqual({})
    expect(parseCreateTaskFailureDetails(null)).toBeNull()
  })

  it('parses the field-save echo, current status and both baselines', () => {
    const details = {
      current: { status: 'doing', statusVersion: 'ver1:4' },
      keptInput: { title: 'New', goal: null },
      baseline: {
        expected: { fieldsVersion: 'fver1:2', statusVersion: 'ver1:3' },
        actual: { fieldsVersion: 'fver1:3', statusVersion: 'ver1:4' },
      },
    }
    expect(parseUpdateFieldsFailureDetails(details)).toEqual(details)
    expect(parseUpdateFieldsFailureDetails({})).toEqual({})
    // A malformed baseline pair cannot be trusted as a version the UI shows.
    expect(parseUpdateFieldsFailureDetails({
      baseline: {
        expected: { fieldsVersion: 'fver1:02', statusVersion: 'ver1:3' },
        actual: { fieldsVersion: 'fver1:3', statusVersion: 'ver1:4' },
      },
    })).toBeNull()
    expect(parseUpdateFieldsFailureDetails({
      baseline: {
        expected: { fieldsVersion: 'fver1:2', statusVersion: '3' },
        actual: { fieldsVersion: 'fver1:3', statusVersion: 'ver1:4' },
      },
    })).toBeNull()
    expect(parseUpdateFieldsFailureDetails(null)).toBeNull()
  })

  it('parses kept inputs and baselines with their own strict grammars', () => {
    expect(parseKeptTaskInput({ title: '', goal: '', initialStatus: 'todo', blockedReason: null })).toEqual({
      title: '',
      goal: '',
      initialStatus: 'todo',
      blockedReason: null,
    })
    expect(parseKeptTaskInput({ title: '', goal: '', initialStatus: '', blockedReason: null })).toBeNull()
    expect(parseKeptTaskInput({ title: '', goal: '', initialStatus: 'todo', blockedReason: 5 })).toBeNull()

    expect(parseKeptFieldInput({ title: null, goal: 'x' })).toEqual({ title: null, goal: 'x' })
    expect(parseKeptFieldInput({ title: 5, goal: 'x' })).toBeNull()

    expect(parseFieldsBaselineValue({ fieldsVersion: 'fver1:0', statusVersion: 'ver1:0' })).toEqual({
      fieldsVersion: 'fver1:0',
      statusVersion: 'ver1:0',
    })
    expect(parseFieldsBaselineValue({ fieldsVersion: 'fver1:0' })).toBeNull()
    expect(parseFieldsBaselineValue('fver1:0')).toBeNull()
  })
})

/* ------------------------------------------------------------------ *
 * F03: manual summaries and project overviews
 * ------------------------------------------------------------------ */

const SUMMARY_SECTION = { id: 's-1', title: '进展', body: '完成了第一步' }
const SUMMARY_CONCLUSION = {
  id: 'c-1',
  text: '可以继续',
  statedState: 'current' as const,
  state: 'current' as const,
  amendedBy: null,
}
const SUMMARY_CONTENT_INPUT = {
  sections: [SUMMARY_SECTION],
  conclusions: [SUMMARY_CONCLUSION],
}
const SUMMARY_CONTENT = {
  sections: [SUMMARY_SECTION],
  conclusions: [SUMMARY_CONCLUSION],
}
const SUMMARY_VERSION = {
  versionId: 'ver-1',
  seq: 1,
  confirmedAt: '2026-11-13T00:00:00.000Z',
  origin: 'user' as const,
  changeKind: 'created' as const,
  previousVersionId: null,
  content: SUMMARY_CONTENT,
  conclusions: [SUMMARY_CONCLUSION],
  readToken: 'read-1',
}
const SUMMARY_BASELINE = { revision: 1, applicabilityRevision: 0, summaryVersionId: 'ver-1' }
const SUMMARY_VIEW = {
  scopeKind: 'task' as const,
  scopeId: 'task-1',
  revision: 1,
  applicabilityRevision: 0,
  baseline: SUMMARY_BASELINE,
  current: SUMMARY_VERSION,
  history: [SUMMARY_VERSION],
  draft: null,
  needsRecheck: false,
  recheck: { pending: false, reasons: [], markedAt: null },
}
const SUMMARY_DRAFT = {
  draftId: 'draft-1',
  state: 'ready',
  updateId: null,
  updatedAt: '2026-11-13T00:00:00.000Z',
  base: { scopeRevision: 1, applicabilityRevision: 0 },
  content: SUMMARY_CONTENT,
}

describe('F03 summary endpoints and payload guards', () => {
  it('publishes summary/read and summary/save without touching the existing endpoints', () => {
    expect(BOARD_ENDPOINTS.summaryRead).toBe('summary/read')
    expect(BOARD_ENDPOINTS.summarySave).toBe('summary/save')
    expect(BOARD_ENDPOINTS.summaryDraftSave).toBe('summary/draft.save')
    for (const endpoint of Object.values(BOARD_ENDPOINTS)) {
      expect(BOARD_ENDPOINT_LIST).toContain(endpoint)
    }
    // Eleven endpoint names; the failure-code table is unchanged at nine.
    expect(BOARD_ENDPOINT_LIST).toHaveLength(11)
    expect(BOARD_FAILURE_CODES).toHaveLength(9)
  })

  it('requires an explicit task/project scope on summary/read', () => {
    expect(parseSummaryReadPayload({ scopeKind: 'task', scopeId: 'task-1' })).toEqual({
      scopeKind: 'task',
      scopeId: 'task-1',
    })
    expect(parseSummaryReadPayload({ scopeKind: 'project', scopeId: 'ws-1', ignored: true })).toEqual({
      scopeKind: 'project',
      scopeId: 'ws-1',
    })
    const malformed: unknown[] = [
      null,
      undefined,
      [],
      {},
      { scopeKind: 'board', scopeId: 'x' },
      { scopeId: 'x' },
      { scopeKind: 'task', scopeId: '' },
      { scopeKind: 'task', scopeId: 7 },
      { scopeKind: 'TASK', scopeId: 'task-1' },
    ]
    for (const value of malformed) {
      expect(parseSummaryReadPayload(value), `accepted ${JSON.stringify(value)}`).toBeNull()
    }
  })

  it('parses the summary/save payload with its baseline and optional body/clear/draft ids', () => {
    const base = {
      scopeKind: 'task' as const,
      scopeId: 'task-1',
      updateId: 'sum-1',
      expectedRevision: 1,
      expectedApplicabilityRevision: 0,
      expectedSummaryVersionId: 'ver-1',
    }
    expect(parseSummarySavePayload({ ...base, content: SUMMARY_CONTENT_INPUT })).toEqual({
      ...base,
      content: SUMMARY_CONTENT_INPUT,
    })
    // A body without conclusions is shape-valid; core normalises it.
    expect(parseSummarySavePayload({ ...base, content: { sections: [SUMMARY_SECTION] } })).not.toBeNull()
    expect(parseSummarySavePayload({ ...base, cleared: true })).toEqual({ ...base, cleared: true })
    // The parser keeps content+cleared together: core owns the XOR rule.
    expect(parseSummarySavePayload({ ...base, content: SUMMARY_CONTENT_INPUT, cleared: true })).not.toBeNull()
    // A duplicate draft id is de-duplicated, not rejected.
    expect(parseSummarySavePayload({ ...base, content: SUMMARY_CONTENT_INPUT, consumeDraftIds: ['d-1', 'd-1', 'd-2'] })).toMatchObject({
      consumeDraftIds: ['d-1', 'd-2'],
    })
    // expectedSummaryVersionId null is the "no official body yet" baseline.
    expect(parseSummarySavePayload({ ...base, expectedSummaryVersionId: null, content: SUMMARY_CONTENT_INPUT })).not.toBeNull()
  })

  it('refuses a malformed summary/save payload instead of defaulting a baseline', () => {
    const base = {
      scopeKind: 'task' as const,
      scopeId: 'task-1',
      updateId: 'sum-1',
      expectedRevision: 1,
      expectedApplicabilityRevision: 0,
      expectedSummaryVersionId: 'ver-1' as string | null,
      content: SUMMARY_CONTENT_INPUT,
    }
    const malformed: unknown[] = [
      null,
      {},
      { ...base, scopeKind: 'board' },
      { ...base, scopeId: '' },
      { ...base, updateId: '' },
      { ...base, expectedRevision: -1 },
      { ...base, expectedRevision: 1.5 },
      { ...base, expectedApplicabilityRevision: '0' },
      { ...base, expectedSummaryVersionId: '' },
      { ...base, expectedSummaryVersionId: 0 },
      { ...base, cleared: false },
      { ...base, cleared: 'yes' },
      { ...base, content: { sections: 'none' } },
      { ...base, content: { sections: [{ id: '', title: 't', body: 'b' }] } },
      { ...base, content: { sections: [SUMMARY_SECTION], conclusions: [{ ...SUMMARY_CONCLUSION, state: 'board' }] } },
      { ...base, consumeDraftIds: 'd-1' },
      { ...base, consumeDraftIds: [''] },
      { ...base, consumeDraftIds: ['d-1', 7] },
    ]
    for (const value of malformed) {
      expect(parseSummarySavePayload(value), `accepted ${JSON.stringify(value)}`).toBeNull()
    }
  })

  it('parses summary/read values, including the explicit "no body yet" null', () => {
    expect(parseSummaryReadValue({ summary: null })).toEqual({ summary: null })
    expect(parseSummaryReadValue({ summary: SUMMARY_VIEW })).toEqual({ summary: SUMMARY_VIEW })

    // A draft and a pending recheck flag travel with the view.
    const withDraft = {
      ...SUMMARY_VIEW,
      draft: SUMMARY_DRAFT,
      needsRecheck: true,
      recheck: {
        pending: true,
        reasons: [{ code: 'draft-stale', detail: '基线已变化', updateId: null, draftId: 'draft-1', at: '2026-11-13T00:00:00.000Z' }],
        markedAt: '2026-11-13T00:00:00.000Z',
      },
    }
    expect(parseSummaryReadValue({ summary: withDraft })).toEqual({ summary: withDraft })
  })

  it('refuses a malformed summary/read value rather than showing an empty editor', () => {
    const malformed: unknown[] = [
      null,
      undefined,
      {},
      { summary: 'none' },
      { summary: { ...SUMMARY_VIEW, scopeKind: 'board' } },
      { summary: { ...SUMMARY_VIEW, scopeId: '' } },
      { summary: { ...SUMMARY_VIEW, revision: -1 } },
      { summary: { ...SUMMARY_VIEW, baseline: { revision: 1, applicabilityRevision: 0 } } },
      { summary: { ...SUMMARY_VIEW, history: 'none' } },
      { summary: { ...SUMMARY_VIEW, history: [null] } },
      { summary: { ...SUMMARY_VIEW, current: { versionId: 'ver-1' } } },
      { summary: { ...SUMMARY_VIEW, draft: { draftId: 'd', state: 'unknown' } } },
      { summary: { ...SUMMARY_VIEW, recheck: null } },
      { summary: { ...SUMMARY_VIEW, recheck: { pending: 'no', reasons: [], markedAt: null } } },
    ]
    for (const value of malformed) {
      expect(parseSummaryReadValue(value), `accepted ${JSON.stringify(value)}`).toBeNull()
    }
  })

  it('parses all three save outcomes and accepts view:null as "landed, re-read failed"', () => {
    const committed = {
      outcome: 'committed',
      revision: 2,
      applicabilityRevision: 0,
      versionId: 'ver-2',
      changeKind: 'modified',
      consumedDraftIds: ['draft-1'],
      draftUpdateFailures: [],
      needsRecheck: false,
      view: SUMMARY_VIEW,
    }
    expect(parseSummarySaveValue(committed)).toEqual(committed)
    // The write landed but the re-read failed: an honest null, not a save error.
    expect(parseSummarySaveValue({ ...committed, view: null })).toEqual({ ...committed, view: null })

    const replayed = {
      outcome: 'already-applied',
      revision: 2,
      applicabilityRevision: 0,
      appliedRevision: 2,
      appliedAt: '2026-11-13T00:00:00.000Z',
      versionId: 'ver-2',
      consumedDraftIds: [],
      view: null,
    }
    expect(parseSummarySaveValue(replayed)).toEqual(replayed)

    const unchanged = { outcome: 'no-change', revision: 2, summaryVersionId: 'ver-2', view: SUMMARY_VIEW }
    expect(parseSummarySaveValue(unchanged)).toEqual(unchanged)
    expect(parseSummarySaveValue({ ...unchanged, summaryVersionId: null })).toEqual({ ...unchanged, summaryVersionId: null })

    const malformed: unknown[] = [
      null,
      {},
      { ...committed, outcome: 'saved' },
      { ...committed, outcome: undefined },
      { ...committed, revision: -1 },
      { ...committed, versionId: '' },
      { ...committed, changeKind: 'unchanged' },
      { ...committed, consumedDraftIds: 'draft-1' },
      { ...committed, draftUpdateFailures: [7] },
      { ...committed, needsRecheck: 'no' },
      { ...committed, view: 'none' },
      { ...replayed, appliedRevision: 1.5 },
      { ...replayed, appliedAt: '' },
      { ...unchanged, revision: -1 },
      { ...unchanged, summaryVersionId: '' },
      { ...unchanged, view: undefined },
    ]
    for (const value of malformed) {
      expect(parseSummarySaveValue(value), `accepted ${JSON.stringify(value)}`).toBeNull()
    }
  })

  it('parses both baseline halves from a stale-baseline failure without weakening the grammar', () => {
    const details = {
      baseline: {
        expected: { revision: 1, applicabilityRevision: 0, summaryVersionId: 'ver-1' },
        actual: { revision: 2, applicabilityRevision: 0, summaryVersionId: 'ver-2' },
      },
    }
    expect(parseSummarySaveFailureDetails(details)).toEqual(details)
    expect(parseSummarySaveFailureDetails({})).toEqual({})
    expect(parseSummarySaveFailureDetails({
      baseline: {
        expected: { revision: -1, applicabilityRevision: 0, summaryVersionId: null },
        actual: { revision: 2, applicabilityRevision: 0, summaryVersionId: 'ver-2' },
      },
    })).toBeNull()
    expect(parseSummarySaveFailureDetails({
      baseline: {
        expected: { revision: 1, applicabilityRevision: 0, summaryVersionId: '' },
        actual: { revision: 2, applicabilityRevision: 0, summaryVersionId: 'ver-2' },
      },
    })).toBeNull()
    expect(parseSummarySaveFailureDetails({
      baseline: {
        expected: { revision: 1, applicabilityRevision: 0, summaryVersionId: null },
      },
    })).toBeNull()
  })
})

describe('F03 manual draft save (summary/draft.save)', () => {
  it('parses the draft body without any official baseline', () => {
    expect(parseSummaryDraftSavePayload({ scopeKind: 'task', scopeId: 'task-1', content: SUMMARY_CONTENT_INPUT })).toEqual({
      scopeKind: 'task',
      scopeId: 'task-1',
      content: SUMMARY_CONTENT_INPUT,
    })
    expect(
      parseSummaryDraftSavePayload({
        scopeKind: 'project',
        scopeId: 'ws-1',
        content: SUMMARY_CONTENT_INPUT,
        updateId: 'draft-1',
      }),
    ).toEqual({ scopeKind: 'project', scopeId: 'ws-1', content: SUMMARY_CONTENT_INPUT, updateId: 'draft-1' })
    // A body without conclusions is shape-valid; core normalises it.
    expect(
      parseSummaryDraftSavePayload({ scopeKind: 'task', scopeId: 'task-1', content: { sections: [SUMMARY_SECTION] } }),
    ).not.toBeNull()
  })

  it('refuses a malformed draft payload instead of inventing a scope or a body', () => {
    const base = { scopeKind: 'task' as const, scopeId: 'task-1', content: SUMMARY_CONTENT_INPUT }
    const malformed: unknown[] = [
      null,
      undefined,
      [],
      {},
      { ...base, scopeKind: 'board' },
      { ...base, scopeId: '' },
      { ...base, scopeId: 7 },
      { ...base, content: null },
      { ...base, content: {} },
      { ...base, content: { sections: 'none' } },
      { ...base, content: { sections: [{ id: '', title: 't', body: 'b' }] } },
      { ...base, updateId: '' },
      { ...base, updateId: 7 },
      { ...base, cleared: true },
    ]
    for (const value of malformed) {
      expect(parseSummaryDraftSavePayload(value), `accepted ${JSON.stringify(value)}`).toBeNull()
    }
  })

  it('parses the stored draft as the success value and refuses a version-shaped body', () => {
    expect(parseSummaryDraftSaveValue({ draft: SUMMARY_DRAFT })).toEqual({ draft: SUMMARY_DRAFT })
    const malformed: unknown[] = [
      null,
      {},
      { draft: null },
      { draft: { draftId: '', state: 'editing' } },
      { draft: { ...SUMMARY_DRAFT, draftId: '' } },
      { draft: { ...SUMMARY_DRAFT, state: 'unknown' } },
      { draft: { ...SUMMARY_DRAFT, content: null } },
      { draft: SUMMARY_VERSION },
    ]
    for (const value of malformed) {
      expect(parseSummaryDraftSaveValue(value), `accepted ${JSON.stringify(value)}`).toBeNull()
    }
  })
})

