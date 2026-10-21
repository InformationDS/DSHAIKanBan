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
  encodeStatusVersion,
  parseBoardSnapshotValue,
  parseBoardTask,
  parseProjectListPayload,
  parseProjectListValue,
  parseReadBoardPayload,
  parseReorderPayload,
  parseSetStatusPayload,
  parseStatusVersion,
  parseUndoStatusPayload,
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
