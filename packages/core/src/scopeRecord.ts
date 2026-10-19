/**
 * Shared scope-head record helpers.
 *
 * A scope (one task or one project) owns exactly one mutable head record in
 * `scope_state`. ADR-002 puts everything a management action changes into that
 * one record so that one `put` publishes a whole consistent result: the paired
 * content (versions, chains, pointers, applicability), the F01 user fields, the
 * activity history and the 待核对 markers.
 *
 * These helpers are pure and shared by `core.ts` (paired confirmation) and
 * `planning.ts` (F01 project/task management), so both paths agree on
 * normalization, change classification inputs and recheck semantics. Nothing
 * here touches storage except `readScopeRecord`.
 *
 * @module @aikanban/core/scope-record
 */

import { pairShapeOf, scopeKey } from './domainSpec.ts';
import type { StoragePort } from './port.ts';
import type {
  ActivityCode,
  ActivityEntry,
  DraftRecord,
  DraftState,
  ObjectContent,
  ObjectKind,
  RecheckFlag,
  RecheckReason,
  RecheckTarget,
  RecheckView,
  ScopeKind,
  ScopeStateRecord,
  VersionEntry,
} from './types.ts';

/** The body of an object that has never been confirmed. */
export const EMPTY_CONTENT: ObjectContent = { sections: [], conclusions: [] };

/** Draft states that still hold a candidate in flight (OBJ-06/07). */
export const CANDIDATE_STATES: ReadonlySet<DraftState> = new Set<DraftState>(['editing', 'ready', 'needsRecheck', 'failed']);

/** Draft states that count towards 待确认 (OBJ-07: 已确认/已放弃/整理中 do not). */
const CONFIRMABLE_STATES: ReadonlySet<DraftState> = new Set<DraftState>(['ready', 'needsRecheck']);

/** OBJ-07: whether a draft state counts as confirmable work. */
export function isConfirmableDraftState(state: DraftState): boolean {
  return CONFIRMABLE_STATES.has(state);
}

/** A cleared 待核对 marker. */
export function emptyFlag(): RecheckFlag {
  return { pending: false, reasons: [], markedAt: null };
}

/** Defensive copy of a 待核对 marker (the stored record must never be mutated in place). */
export function copyFlag(flag: RecheckFlag): RecheckFlag {
  return { pending: flag.pending, reasons: [...flag.reasons], markedAt: flag.markedAt };
}

/** A brand-new scope head: no content, no user fields, no activity. */
export function emptyScope(kind: ScopeKind, id: string, at: string): ScopeStateRecord {
  return {
    schemaVersion: 1,
    scope: { kind, id },
    revision: 0,
    applicabilityRevision: 0,
    lastCommittedUpdateId: null,
    lastConfirmedAt: null,
    links: { conversations: {}, outcomeTasks: {} },
    current: { taskRecord: {}, taskSummary: {}, projectRecord: {}, projectOverview: {} },
    chains: { taskRecord: {}, taskSummary: {}, projectRecord: {}, projectOverview: {} },
    amendments: [],
    recheck: { taskSummary: emptyFlag(), projectOverview: emptyFlag() },
    activity: [],
    task: null,
    project: null,
    createdAt: at,
    updatedAt: at,
  };
}

/**
 * Backfill the fields added after S0 (F01 user fields and activity history).
 *
 * The domain stays at `version: 1`: the change is additive and optional, so a
 * document written by S0 still validates and reads correctly. Bumping the
 * version instead would make an existing document fail to open -- exactly the
 * data loss REC-05 forbids.
 */
export function normalizeScope(record: ScopeStateRecord | undefined): ScopeStateRecord | undefined {
  if (record === undefined) return undefined;
  const raw = record as Partial<ScopeStateRecord>;
  const task = raw.task ?? null;
  const project = raw.project ?? null;
  return {
    ...record,
    activity: raw.activity ?? [],
    task:
      task === null
        ? null
        : {
            ...task,
            pendingFieldDraft: task.pendingFieldDraft ?? null,
            recentFieldUpdateIds: task.recentFieldUpdateIds ?? [],
            // F02 additions: a record written before the status machine existed
            // has no history to undo and an empty idempotency window.
            recentStatusUpdateIds: task.recentStatusUpdateIds ?? [],
            lastStatusChange: task.lastStatusChange ?? null,
          },
    project:
      project === null
        ? null
        : {
            ...project,
            // F02: no saved column preference yet, and no order was ever written.
            boardOrder: project.boardOrder ?? { todo: [], doing: [], blocked: [], done: [], cancelled: [] },
            orderRevision: project.orderRevision ?? 0,
          },
  };
}

/** Read and normalize one scope head. */
export function readScopeRecord(
  port: StoragePort,
  table: string,
  scopeKind: ScopeKind,
  scopeId: string,
): ScopeStateRecord | undefined {
  return normalizeScope(port.get<ScopeStateRecord>(table, scopeKey(scopeKind, scopeId)));
}

/** Read and normalize every scope head in the table. */
export function readAllScopeRecords(port: StoragePort, table: string): readonly ScopeStateRecord[] {
  const out: ScopeStateRecord[] = [];
  for (const [, record] of port.entries<ScopeStateRecord>(table)) {
    const normalized = normalizeScope(record);
    if (normalized !== undefined) out.push(normalized);
  }
  return out;
}

/** The append-only version chain of one object. */
export function chainOf(scope: ScopeStateRecord, objectKind: ObjectKind, objectId: string): readonly VersionEntry[] {
  return scope.chains[objectKind][objectId] ?? [];
}

/** The current official version of one object, or null. */
export function currentEntryOf(scope: ScopeStateRecord, objectKind: ObjectKind, objectId: string): VersionEntry | null {
  const versionId = scope.current[objectKind][objectId];
  if (versionId === undefined) return null;
  return chainOf(scope, objectKind, objectId).find((entry) => entry.versionId === versionId) ?? null;
}

/** The current official version id of one object, or null. */
export function currentVersionIdOf(scope: ScopeStateRecord, objectKind: ObjectKind, objectId: string): string | null {
  return scope.current[objectKind][objectId] ?? null;
}

/** Keep only the known fields, so change detection never sees incidental keys. */
export function normalizeContent(content: ObjectContent): ObjectContent {
  return {
    sections: content.sections.map((section) => ({ id: section.id, title: section.title, body: section.body })),
    conclusions: (content.conclusions ?? []).map((conclusion) => ({
      id: conclusion.id,
      text: conclusion.text,
      statedState: conclusion.statedState,
    })),
  };
}

/** True when a body carries neither partitions nor conclusions. */
export function isEmptyContent(content: ObjectContent): boolean {
  return content.sections.length === 0 && (content.conclusions ?? []).length === 0;
}

/** Append a reason unless an identical one is already recorded. */
export function appendReason(reasons: readonly RecheckReason[], reason: RecheckReason): readonly RecheckReason[] {
  const duplicate = reasons.some((existing) => existing.code === reason.code && existing.detail === reason.detail);
  return duplicate ? reasons : [...reasons, reason];
}

/** Synchronous consistency view: persisted marker plus staleness derived from the drafts themselves. */
export function computeRecheck(
  scopeKind: ScopeKind,
  scopeId: string,
  scope: ScopeStateRecord,
  drafts: readonly DraftRecord[],
  at: string,
): RecheckView {
  const target = pairShapeOf(scopeKind).recheckTarget;
  const flags: Record<RecheckTarget, RecheckFlag> = {
    taskSummary: copyFlag(scope.recheck.taskSummary),
    projectOverview: copyFlag(scope.recheck.projectOverview),
  };
  const staleDrafts: { draftId: string; reason: string }[] = [];
  for (const draft of drafts) {
    if (draft.scopeKind !== scopeKind || draft.scopeId !== scopeId) continue;
    if (!CANDIDATE_STATES.has(draft.state)) continue;
    if (draft.base.scopeRevision === scope.revision && draft.base.applicabilityRevision === scope.applicabilityRevision) continue;
    const reason = `built on revision ${draft.base.scopeRevision}, official revision is ${scope.revision}`;
    staleDrafts.push({ draftId: draft.draftId, reason });
    const flag = flags[target];
    flags[target] = {
      pending: true,
      reasons: appendReason(flag.reasons, {
        code: 'draft-stale',
        detail: `draft ${draft.draftId} ${reason}`,
        updateId: draft.updateId,
        draftId: draft.draftId,
        at,
      }),
      markedAt: flag.markedAt ?? at,
    };
  }
  return { taskSummary: flags.taskSummary, projectOverview: flags.projectOverview, staleDrafts };
}

/** One important change, ready to be appended to a scope head. */
export interface ActivityInput {
  readonly code: ActivityCode;
  readonly summary: string;
  readonly details?: Readonly<Record<string, string>>;
  readonly at: string;
}

/**
 * Append one activity entry and return the next head. Entry ids are derived
 * from the moment and the position, so an entry can never be confused with
 * another one in the same scope (F01-R07, SAVE-08).
 */
export function appendActivity(scope: ScopeStateRecord, input: ActivityInput): ScopeStateRecord {
  const activity = scope.activity ?? [];
  const entry: ActivityEntry = {
    activityId: `${input.at}#${activity.length + 1}`,
    at: input.at,
    scopeKind: scope.scope.kind,
    scopeId: scope.scope.id,
    code: input.code,
    summary: input.summary,
    details: input.details ?? {},
  };
  return { ...scope, activity: [...activity, entry] };
}

/**
 * Mark one summary as 待核对 (SAVE-04). Pure: the caller decides when the
 * marking is written, so it can be committed in the SAME `put` as the change
 * that caused it -- there is never a state where the field changed but the
 * marker is missing.
 */
export function markRecheck(scope: ScopeStateRecord, target: RecheckTarget, reason: RecheckReason, at: string): ScopeStateRecord {
  const flag = scope.recheck[target];
  const nextFlag: RecheckFlag = {
    pending: true,
    reasons: appendReason(flag.reasons, reason),
    markedAt: flag.markedAt ?? at,
  };
  return {
    ...scope,
    recheck:
      target === 'taskSummary'
        ? { taskSummary: nextFlag, projectOverview: copyFlag(scope.recheck.projectOverview) }
        : { taskSummary: copyFlag(scope.recheck.taskSummary), projectOverview: nextFlag },
    updatedAt: at,
  };
}

/** Clear one 待核对 marker (F07-R05 手动核对完成): no version, no revision bump (SAVE-10). */
export function clearRecheckTarget(scope: ScopeStateRecord, target: RecheckTarget, at: string): ScopeStateRecord {
  return {
    ...scope,
    recheck:
      target === 'taskSummary'
        ? { taskSummary: emptyFlag(), projectOverview: copyFlag(scope.recheck.projectOverview) }
        : { taskSummary: copyFlag(scope.recheck.taskSummary), projectOverview: emptyFlag() },
    updatedAt: at,
  };
}
