/**
 * The `storageDomain` declaration the core expects the host to open, plus the
 * record-key derivation and the record validators.
 *
 * Layout choice (`single`) is an evidence-backed decision, not a default:
 *  - under `single` the whole unit is one document, and a document that is
 *    malformed or stamped with a foreign version FAILS the open. Under
 *    `per-record` such a document silently reads as an ABSENT record, which
 *    would present a corrupted task summary as an empty one and violate
 *    REC-05 ("数据读取/恢复损坏不当空项目覆盖");
 *  - `invalidRecords: 'backup-and-skip'` is documented as being for
 *    *disposable derived data* and is inert under `single` (the unit exposes
 *    no `backupRecord`), so it must not be declared here;
 *  - the atomicity boundary is identical in both layouts (one `put` publishes
 *    exactly one document), so `single` costs nothing in correctness.
 * See `experiments/storage-domain-atomicity.mjs` E1/E5 and ADR-002.
 *
 * @module @aikanban/core/domain-spec
 */

import { encodeKey } from './keys.ts';
import type { DraftRecord, ObjectKind, ScopeKind, ScopeStateRecord } from './types.ts';

/** Domain name; must match `UNIT_NAME_RE` = `/^[a-z][a-z0-9_]*$/`. */
export const AIKANBAN_DOMAIN_NAME = 'aikanban_core';
/** Current domain format version. */
export const AIKANBAN_DOMAIN_VERSION = 1;
/** Medium layout. See the module docstring for why this is `single`. */
export const AIKANBAN_DOMAIN_LAYOUT = 'single' as const;

/** Table names; also matched against `UNIT_NAME_RE`. */
export const AIKANBAN_TABLES = {
  /** One record per scope: the mutable head of every pair in that scope. */
  scopeState: 'scope_state',
  /** One record per active draft slot. */
  drafts: 'drafts',
} as const;

export type TableName = (typeof AIKANBAN_TABLES)[keyof typeof AIKANBAN_TABLES];

/** Every table the spec declares, in declaration order. */
export const AIKANBAN_TABLE_LIST: readonly TableName[] = [AIKANBAN_TABLES.scopeState, AIKANBAN_TABLES.drafts];

/** Key of the single head record of one scope. */
export function scopeKey(scopeKind: ScopeKind, scopeId: string): string {
  return `scope1_${scopeKind}_${encodeKey(scopeId)}`;
}

/** Key of one draft slot. The slot identity IS the key, so one slot holds at most one draft (OBJ-07). */
export function draftKey(input: { kind: string; scopeKind: ScopeKind; scopeId: string; objectId: string }): string {
  return `draft1_${input.kind}_${input.scopeKind}_${encodeKey(input.scopeId)}_${encodeKey(input.objectId)}`;
}

/** Deterministic version id: retrying the same confirmation derives the same id, never a second version. */
export function versionIdOf(input: { updateId: string; objectKind: ObjectKind; objectId: string }): string {
  return `v1_${input.objectKind}_${encodeKey(input.objectId)}_${encodeKey(input.updateId)}`;
}

/** Deterministic amendment id. */
export function amendmentIdOf(input: { updateId: string; scopeKind: ScopeKind; scopeId: string; conclusionId: string }): string {
  return `a1_${input.scopeKind}_${encodeKey(input.scopeId)}_${encodeKey(input.conclusionId)}_${encodeKey(input.updateId)}`;
}

/** The pair each scope kind is allowed to confirm, and which member maps to which object kind. */
export function pairShapeOf(scopeKind: ScopeKind): {
  readonly record: ObjectKind;
  readonly summary: ObjectKind;
  readonly recheckTarget: 'taskSummary' | 'projectOverview';
} {
  return scopeKind === 'task'
    ? { record: 'taskRecord', summary: 'taskSummary', recheckTarget: 'taskSummary' }
    : { record: 'projectRecord', summary: 'projectOverview', recheckTarget: 'projectOverview' };
}

const CONCLUSION_STATES = new Set(['current', 'superseded', 'negated', 'pending']);
const CHANGE_KINDS = new Set(['created', 'modified', 'cleared']);
const DRAFT_KINDS = new Set(['taskRecord', 'projectRecord', 'summaryDraft', 'overviewDraft']);
const DRAFT_STATES = new Set(['editing', 'ready', 'needsRecheck', 'saved', 'abandoned', 'failed']);
const ORIGINS = new Set(['ai', 'user', 'ai+user']);
const OBJECT_KINDS = new Set(['taskRecord', 'taskSummary', 'projectRecord', 'projectOverview']);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === 'string';

/** Structural check of a content body. */
export function isObjectContent(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!Array.isArray(value['sections'])) return false;
  for (const section of value['sections']) {
    if (!isRecord(section) || !isString(section['id']) || !isString(section['title']) || !isString(section['body'])) return false;
  }
  const conclusions = value['conclusions'];
  if (conclusions === undefined) return true;
  if (!Array.isArray(conclusions)) return false;
  return conclusions.every(
    (item) => isRecord(item) && isString(item['id']) && isString(item['text']) && CONCLUSION_STATES.has(String(item['statedState'])),
  );
}

const isVersionEntry = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  return (
    isString(value['versionId']) &&
    OBJECT_KINDS.has(String(value['objectKind'])) &&
    isString(value['objectId']) &&
    isString(value['scopeId']) &&
    typeof value['seq'] === 'number' &&
    isString(value['updateId']) &&
    isString(value['confirmedAt']) &&
    ORIGINS.has(String(value['origin'])) &&
    CHANGE_KINDS.has(String(value['changeKind'])) &&
    isObjectContent(value['content']) &&
    typeof value['revision'] === 'number' &&
    typeof value['applicabilityRevision'] === 'number'
  );
};

const isChainMap = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  for (const chain of Object.values(value)) {
    if (!Array.isArray(chain) || !chain.every(isVersionEntry)) return false;
  }
  return true;
};

const isCurrentMap = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  return Object.values(value).every((id) => isString(id));
};

const isRecheckFlag = (value: unknown): boolean =>
  isRecord(value) && typeof value['pending'] === 'boolean' && Array.isArray(value['reasons']);

const TASK_STATUS_VALUES = new Set(['todo', 'doing', 'blocked', 'done', 'cancelled']);
const WORK_SCOPE_VALUES = new Set(['ok', 'missing-dir', 'unknown']);

/** `undefined`/`null`/string only (records written before F01 simply omit the key). */
const isOptionalString = (value: unknown): boolean => value === undefined || value === null || isString(value);

/** F01-R07 / SAVE-08: one important-change entry. */
const isActivityEntry = (value: unknown): boolean =>
  isRecord(value) &&
  isString(value['activityId']) &&
  isString(value['at']) &&
  (value['scopeKind'] === 'task' || value['scopeKind'] === 'project') &&
  isString(value['scopeId']) &&
  isString(value['code']) &&
  isString(value['summary']) &&
  isRecord(value['details']);

/** F01-R05: the task's user fields, independent of records and summaries. */
const isTaskFields = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  if (!isString(value['projectId']) || !isString(value['title']) || !isString(value['goal'])) return false;
  if (!TASK_STATUS_VALUES.has(String(value['status']))) return false;
  if (!isOptionalString(value['blockedReason'])) return false;
  if (typeof value['archived'] !== 'boolean' || typeof value['order'] !== 'number') return false;
  if (
    typeof value['fieldsRevision'] !== 'number' ||
    typeof value['statusRevision'] !== 'number' ||
    typeof value['goalRevision'] !== 'number'
  ) {
    return false;
  }
  if (!Array.isArray(value['recentFieldUpdateIds'])) return false;
  // F02 additions; optional on read (older records omit them) but strict when present.
  const statusIds = value['recentStatusUpdateIds'];
  if (statusIds !== undefined && (!Array.isArray(statusIds) || !statusIds.every(isString))) return false;
  const lastChange = value['lastStatusChange'];
  if (lastChange !== undefined && lastChange !== null) {
    if (!isRecord(lastChange)) return false;
    if (!isString(lastChange['updateId']) || !isString(lastChange['at'])) return false;
    if (lastChange['kind'] !== 'transition' && lastChange['kind'] !== 'undo') return false;
    for (const snapshot of [lastChange['from'], lastChange['to']]) {
      if (!isRecord(snapshot) || !TASK_STATUS_VALUES.has(String(snapshot['status']))) return false;
      if (!isOptionalString(snapshot['blockedReason'])) return false;
    }
  }
  if (!isString(value['requestId']) || !isString(value['createdAt']) || !isString(value['updatedAt'])) return false;
  const draft = value['pendingFieldDraft'];
  if (draft !== undefined && draft !== null) {
    if (!isRecord(draft) || !isString(draft['requestId']) || !isString(draft['title']) || !isString(draft['goal'])) return false;
  }
  return true;
};

/** ADR-003: project registration, work-scope observation and per-project board position. */
const isProjectFields = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  if (!isString(value['title']) || !isString(value['path'])) return false;
  const workScope = value['workScope'];
  if (!isRecord(workScope) || !WORK_SCOPE_VALUES.has(String(workScope['availability']))) return false;
  if (!isOptionalString(workScope['detail']) || !isOptionalString(workScope['observedAt'])) return false;
  const position = value['position'];
  if (!isRecord(position) || !isOptionalString(position['selectedTaskId']) || !isOptionalString(position['view'])) return false;
  // F02 additions; optional on read, strict when present.
  const boardOrder = value['boardOrder'];
  if (boardOrder !== undefined) {
    if (!isRecord(boardOrder)) return false;
    for (const status of TASK_STATUS_VALUES) {
      const ids = boardOrder[status];
      if (ids !== undefined && (!Array.isArray(ids) || !ids.every(isString))) return false;
    }
  }
  const orderRevision = value['orderRevision'];
  if (orderRevision !== undefined && typeof orderRevision !== 'number') return false;
  return isString(value['createdAt']) && isString(value['updatedAt']);
};

/** Validate a stored scope head record. Rejecting here is what makes a corrupt medium fail loud. */
export function isScopeStateRecord(value: unknown): value is ScopeStateRecord {
  if (!isRecord(value)) return false;
  const scope = value['scope'];
  if (!isRecord(scope) || (scope['kind'] !== 'task' && scope['kind'] !== 'project') || !isString(scope['id'])) return false;
  if (value['schemaVersion'] !== 1) return false;
  if (typeof value['revision'] !== 'number' || typeof value['applicabilityRevision'] !== 'number') return false;
  if (!isRecord(value['current']) || !isRecord(value['chains'])) return false;
  for (const kind of OBJECT_KINDS) {
    if (!isCurrentMap(value['current'][kind])) return false;
    if (!isChainMap(value['chains'][kind])) return false;
  }
  if (!Array.isArray(value['amendments'])) return false;
  if (!isRecord(value['recheck']) || !isRecheckFlag(value['recheck']['taskSummary']) || !isRecheckFlag(value['recheck']['projectOverview'])) return false;
  if (!isRecord(value['links'])) return false;
  // F01 additions. They are optional on read so an S0 document still opens
  // (bumping the domain version instead would make it fail to open = data loss),
  // but when present they are validated strictly, so corruption stays loud.
  const activity = value['activity'];
  if (activity !== undefined && (!Array.isArray(activity) || !activity.every(isActivityEntry))) return false;
  const task = value['task'];
  if (task !== undefined && task !== null && !isTaskFields(task)) return false;
  const project = value['project'];
  if (project !== undefined && project !== null && !isProjectFields(project)) return false;
  return isString(value['createdAt']) && isString(value['updatedAt']);
}

/** Validate a stored draft record. */
export function isDraftRecord(value: unknown): value is DraftRecord {
  if (!isRecord(value)) return false;
  if (!isString(value['draftId']) || !DRAFT_KINDS.has(String(value['kind'])) || !DRAFT_STATES.has(String(value['state']))) return false;
  if (value['scopeKind'] !== 'task' && value['scopeKind'] !== 'project') return false;
  if (!OBJECT_KINDS.has(String(value['objectKind'])) || !isString(value['objectId']) || !isString(value['scopeId'])) return false;
  if (!isObjectContent(value['content'])) return false;
  if (!isRecord(value['base']) || typeof value['base']['scopeRevision'] !== 'number') return false;
  return isString(value['createdAt']) && isString(value['updatedAt']);
}

/** The minimum zod surface `buildDomainSpec` needs. */
export interface ZodLike {
  /**
   * `z.custom(check)` from the host's own zod. The schema is erased to
   * `unknown` here because the core has no zod dependency; the returned value
   * is passed straight back into `defineDomain`/`open`.
   */
  custom(check: (value: unknown) => boolean, params?: { readonly message?: string }): unknown;
}

/** The spec shape `ctx.storageDomain.open` consumes (`DomainSpec` in dsh-storage-domain). */
export interface DomainSpecLike {
  readonly name: string;
  readonly version: number;
  readonly layout: 'single';
  readonly tables: Readonly<Record<TableName, { readonly valueSchema: unknown }>>;
}

/**
 * Build the domain spec from the host's own zod instance.
 *
 * @param zod - the host's zod module (`import z from 'zod'`); the core has no
 *   runtime dependency on zod, so the caller supplies it.
 * @returns a spec the host passes to `defineDomain` / `ctx.storageDomain.open`.
 */
export function buildDomainSpec(zod: ZodLike): DomainSpecLike {
  return {
    name: AIKANBAN_DOMAIN_NAME,
    version: AIKANBAN_DOMAIN_VERSION,
    layout: AIKANBAN_DOMAIN_LAYOUT,
    tables: {
      [AIKANBAN_TABLES.scopeState]: {
        valueSchema: zod.custom(isScopeStateRecord, { message: 'invalid aikanban scope_state record' }),
      },
      [AIKANBAN_TABLES.drafts]: {
        valueSchema: zod.custom(isDraftRecord, { message: 'invalid aikanban drafts record' }),
      },
    },
  };
}
