/**
 * The AIKanBan core model.
 *
 * Central claim, and the reason for this package's shape: **one confirmation is
 * exactly one `put`**. Both members of a pair (record + summary, or project
 * record + overview), their new version entries, the advanced current pointer
 * and any applicability corrections are all written as parts of ONE scope-head
 * record. The measured storage contract (ADR-002) is that a single `put`
 * publishes exactly one document atomically and that two `put`s are never one
 * transaction, so this is the only construction in which "记录成功但概况失败"
 * ("the record saved but the summary failed") cannot happen.
 *
 * Concurrency is handled without any lock: a confirmation carries an identity
 * (`updateId`) and the baseline it was reviewed against, and the whole
 * decision (idempotency, baseline, the 概况待核对 save gate, change
 * classification) runs inside the port's atomic read-modify-write transform.
 *
 * @module @aikanban/core/core
 */

import { AIKANBAN_TABLES, amendmentIdOf, draftKey, pairShapeOf, scopeKey, versionIdOf } from './domainSpec.ts';
import { canonicalJson, collapseWhitespace, fingerprint } from './keys.ts';
import { CoreError } from './port.ts';
import type { StoragePort } from './port.ts';
import { createPlanningApi } from './planning.ts';
import type { PlanningApi } from './planning.ts';
import {
  CANDIDATE_STATES,
  EMPTY_CONTENT,
  appendActivity,
  appendReason,
  chainOf,
  computeRecheck,
  copyFlag,
  currentEntryOf,
  currentVersionIdOf,
  emptyFlag,
  emptyScope,
  isEmptyContent,
  normalizeContent,
  normalizeScope,
  readScopeRecord,
} from './scopeRecord.ts';
import type {
  AmendmentEntry,
  AmendmentInput,
  AmendOutcome,
  BaselineExpectation,
  BaselineIssue,
  BaselineResult,
  ChangeKind,
  ConclusionView,
  ConfirmInput,
  ConfirmOutcome,
  CoreOptions,
  DraftKind,
  DraftRecord,
  FieldsBaseline,
  KanbanCore,
  LinkOutcome,
  MemberInput,
  MemberKey,
  ObjectContent,
  ObjectKind,
  ObjectView,
  Origin,
  PairView,
  RecheckFlag,
  RecheckReason,
  RecheckTarget,
  ScopeKind,
  ScopeStateRecord,
  SourceRef,
  VersionEntry,
} from './types.ts';

/** How a member's input relates to the object's current official body. */
type MemberChange = 'none' | 'cosmetic' | 'substantive' | 'unstated';

interface MemberPlan {
  readonly key: MemberKey;
  readonly objectKind: ObjectKind;
  readonly objectId: string;
  readonly input: MemberInput;
  readonly change: MemberChange;
  /** A version is written for this member. */
  readonly versioned: boolean;
  readonly changeKind: ChangeKind;
  readonly nextContent: ObjectContent;
  readonly confirmUnchanged: boolean;
}

/** Decide what a member input means for its object (SAVE-02: no duplicate versions; clearing is a change). */
function planMember(
  key: MemberKey,
  objectKind: ObjectKind,
  objectId: string,
  input: MemberInput,
  current: VersionEntry | null,
): MemberPlan {
  const currentContent = normalizeContent(current?.content ?? EMPTY_CONTENT);
  const base = { key, objectKind, objectId, input, confirmUnchanged: input.confirmUnchanged === true };
  if (input.cleared === true) {
    if (isEmptyContent(currentContent)) {
      return { ...base, change: 'none', versioned: false, changeKind: 'modified', nextContent: currentContent };
    }
    return { ...base, change: 'substantive', versioned: true, changeKind: current === null ? 'created' : 'cleared', nextContent: EMPTY_CONTENT };
  }
  if (input.content !== undefined) {
    const next = normalizeContent(input.content);
    if (canonicalJson(next) === canonicalJson(currentContent)) {
      return { ...base, change: 'none', versioned: false, changeKind: 'modified', nextContent: next };
    }
    const cosmeticOnly = canonicalJson(collapseWhitespace(next)) === canonicalJson(collapseWhitespace(currentContent));
    if (cosmeticOnly && input.allowCosmeticVersion !== true) {
      // SAVE-04/F07-R02: a formatting-only edit needs no reconciliation and by
      // default is not turned into a version; the caller is told it happened.
      return { ...base, change: 'cosmetic', versioned: false, changeKind: 'modified', nextContent: next };
    }
    const changeKind: ChangeKind = current === null ? 'created' : isEmptyContent(next) ? 'cleared' : 'modified';
    return { ...base, change: cosmeticOnly ? 'cosmetic' : 'substantive', versioned: true, changeKind, nextContent: next };
  }
  if (input.confirmUnchanged === true) {
    return { ...base, change: 'none', versioned: false, changeKind: 'modified', nextContent: currentContent };
  }
  // Nothing stated: the caller is silent about this member. Whether that is a
  // rejection, a no-change, or a blocked reconciliation is decided by the
  // confirmation as a whole (see `evaluate`).
  return { ...base, change: 'unstated', versioned: false, changeKind: 'modified', nextContent: currentContent };
}

/** Effective conclusions: a confirmed correction always outranks the body's own wording (APP-01/05). */
function effectiveConclusions(
  scope: ScopeStateRecord,
  objectKind: ObjectKind,
  objectId: string,
  content: ObjectContent,
): readonly ConclusionView[] {
  const applicable = scope.amendments.filter(
    (amendment) =>
      amendment.target.objectKind === objectKind &&
      amendment.target.objectId === objectId &&
      amendment.appliesTo.scopeKind === scope.scope.kind &&
      amendment.appliesTo.scopeId === scope.scope.id,
  );
  return (content.conclusions ?? []).map<ConclusionView>((conclusion) => {
    let latest: AmendmentEntry | null = null;
    for (const amendment of applicable) {
      if (amendment.target.conclusionId !== conclusion.id) continue;
      if (latest === null || amendment.seq >= latest.seq) latest = amendment;
    }
    return {
      id: conclusion.id,
      text: conclusion.text,
      statedState: conclusion.statedState,
      state: latest?.state ?? conclusion.statedState,
      amendedBy: latest?.amendmentId ?? null,
      amendment:
        latest === null
          ? null
          : {
              affectedFragments: latest.affectedFragments,
              substitute: latest.substitute,
              sourceVersionIds: latest.sourceVersionIds,
              note: latest.note,
              appliesTo: latest.appliesTo,
              confirmedAt: latest.confirmedAt,
            },
    };
  });
}

function toObjectView(scope: ScopeStateRecord, entry: VersionEntry): ObjectView {
  const conclusions = effectiveConclusions(scope, entry.objectKind, entry.objectId, entry.content);
  return {
    objectKind: entry.objectKind,
    objectId: entry.objectId,
    versionId: entry.versionId,
    seq: entry.seq,
    confirmedAt: entry.confirmedAt,
    origin: entry.origin,
    source: entry.source,
    coveredStage: entry.coveredStage,
    aiDraft: entry.aiDraft,
    userResult: entry.userResult,
    previousVersionId: entry.previousVersionId,
    readSourceVersionIds: entry.readSourceVersionIds,
    restoredFrom: entry.restoredFrom,
    content: entry.content,
    conclusions,
    readToken: fingerprint({
      versionId: entry.versionId,
      applicabilityRevision: entry.applicabilityRevision,
      states: conclusions.map((conclusion) => [conclusion.id, conclusion.state]),
    }),
  };
}

function recheckTargetsOf(scopeKind: ScopeKind): readonly RecheckTarget[] {
  const target = pairShapeOf(scopeKind).recheckTarget;
  return [target];
}

/**
 * SAVE-05 / F01-R06: did the task fields move after the review was opened?
 * The confirmation itself never writes task fields, so a stale field baseline
 * only has to be *reported* (AT-29: 相关范围需核对, 记录确认不回滚字段).
 */
function fieldsBaselineReport(
  scope: ScopeStateRecord,
  expected: FieldsBaseline | undefined,
): { readonly fieldsChangedSinceBaseline: boolean; readonly fieldsBaseline: FieldsBaseline | null } {
  const task = scope.task ?? null;
  if (task === null) return { fieldsChangedSinceBaseline: false, fieldsBaseline: null };
  const actual: FieldsBaseline = { fieldsRevision: task.fieldsRevision, statusRevision: task.statusRevision };
  return {
    fieldsChangedSinceBaseline:
      expected !== undefined &&
      (expected.fieldsRevision !== actual.fieldsRevision || expected.statusRevision !== actual.statusRevision),
    fieldsBaseline: actual,
  };
}

interface EvalInput {
  readonly scopeKind: ScopeKind;
  readonly scopeId: string;
  readonly recordObjectId: string;
  readonly updateId: string;
  readonly expected: BaselineExpectation;
  readonly origin: Origin;
  readonly source: SourceRef;
  readonly at: string;
  readonly record: MemberInput;
  readonly summary: MemberInput;
  readonly amendments: readonly AmendmentInput[];
  readonly restoredFrom: { readonly versionId: string; readonly at: string } | null;
}

/** One member's contribution to a commit. */
interface MemberVersionPayload {
  readonly member: MemberKey;
  readonly entry: VersionEntry;
}

type EvalResult =
  | { readonly kind: 'reject'; readonly code: 'invalid-input' | 'unsupported-pair' | 'unknown-conclusion' | 'nothing-to-confirm'; readonly message: string }
  | {
      readonly kind: 'already-applied';
      readonly appliedRevision: number;
      readonly appliedApplicabilityRevision: number;
      readonly appliedAt: string;
      readonly versions: readonly { readonly member: MemberKey; readonly versionId: string; readonly seq: number }[];
      readonly amendmentIds: readonly string[];
    }
  | {
      readonly kind: 'baseline-changed';
      readonly actual: BaselineExpectation;
      readonly issues: readonly BaselineIssue[];
      readonly blockedMembers: readonly MemberKey[];
    }
  | {
      readonly kind: 'recheck-pending';
      readonly target: RecheckTarget;
      readonly reasons: readonly RecheckReason[];
      readonly blockedMembers: readonly MemberKey[];
    }
  | {
      readonly kind: 'no-change';
      readonly unchanged: readonly MemberKey[];
      readonly cosmeticOnly: readonly MemberKey[];
    }
  | {
      readonly kind: 'commit';
      readonly next: ScopeStateRecord;
      readonly versions: readonly { readonly member: MemberKey; readonly versionId: string; readonly seq: number }[];
      readonly amendmentIds: readonly string[];
      readonly changed: readonly MemberKey[];
      readonly cleared: readonly MemberKey[];
      readonly unchanged: readonly MemberKey[];
      readonly cosmeticOnly: readonly MemberKey[];
      readonly clearsRecheck: boolean;
    };

/**
 * The whole confirmation decision. Pure and synchronous: it is called once on a
 * pre-flight snapshot (so a doomed confirmation performs no write at all) and
 * again inside the port's atomic transform (where it is authoritative).
 */
function evaluate(input: EvalInput, scope: ScopeStateRecord, drafts: readonly DraftRecord[]): EvalResult {
  const shape = pairShapeOf(input.scopeKind);
  const members: { readonly key: MemberKey; readonly objectKind: ObjectKind; readonly objectId: string; readonly input: MemberInput }[] = [
    { key: 'record', objectKind: shape.record, objectId: input.recordObjectId, input: input.record },
    { key: 'summary', objectKind: shape.summary, objectId: input.scopeId, input: input.summary },
  ];

  // --- idempotency: the same updateId can only ever produce one result (SAVE-06, F08-R06).
  const priorVersions: { member: MemberKey; versionId: string; seq: number; revision: number; at: string }[] = [];
  for (const member of members) {
    for (const entry of chainOf(scope, member.objectKind, member.objectId)) {
      if (entry.updateId !== input.updateId) continue;
      priorVersions.push({
        member: member.key,
        versionId: entry.versionId,
        seq: entry.seq,
        revision: entry.revision,
        at: entry.confirmedAt,
      });
    }
  }
  const priorAmendments = scope.amendments.filter((amendment) => amendment.updateId === input.updateId);
  if (priorVersions.length > 0 || priorAmendments.length > 0) {
    const revisions = [
      ...priorVersions.map((version) => version.revision),
      ...priorAmendments.map((amendment) => amendment.revision),
    ];
    const times = [...priorVersions.map((version) => version.at), ...priorAmendments.map((amendment) => amendment.confirmedAt)].sort();
    return {
      kind: 'already-applied',
      appliedRevision: revisions.length === 0 ? scope.revision : Math.max(...revisions),
      appliedApplicabilityRevision: Math.max(
        scope.applicabilityRevision,
        ...priorAmendments.map((amendment) => amendment.applicabilityRevision),
      ),
      appliedAt: times[times.length - 1] ?? input.at,
      versions: priorVersions.map((version) => ({ member: version.member, versionId: version.versionId, seq: version.seq })),
      amendmentIds: priorAmendments.map((amendment) => amendment.amendmentId),
    };
  }

  // --- baseline: SAVE-05 / F08-R02, covering content AND applicability.
  const actualBaseVersionIds: Partial<Record<MemberKey, string | null>> = {};
  for (const member of members) actualBaseVersionIds[member.key] = currentVersionIdOf(scope, member.objectKind, member.objectId);
  const issues: BaselineIssue[] = [];
  if (scope.revision !== input.expected.revision) {
    issues.push({ code: 'revision-changed', member: null, detail: `expected revision ${input.expected.revision}, official revision is ${scope.revision}` });
  }
  if (scope.applicabilityRevision !== input.expected.applicabilityRevision) {
    issues.push({
      code: 'applicability-changed',
      member: null,
      detail: `expected applicability revision ${input.expected.applicabilityRevision}, official is ${scope.applicabilityRevision}`,
    });
  }
  for (const member of members) {
    const expectedId = input.expected.baseVersionIds[member.key];
    if (expectedId === undefined) continue;
    const actualId = actualBaseVersionIds[member.key] ?? null;
    if (expectedId !== actualId) {
      issues.push({
        code: 'member-base-changed',
        member: member.key,
        detail: `member '${member.key}' base version expected ${String(expectedId)}, official is ${String(actualId)}`,
      });
    }
  }
  if (issues.length > 0) {
    return {
      kind: 'baseline-changed',
      actual: { revision: scope.revision, applicabilityRevision: scope.applicabilityRevision, baseVersionIds: actualBaseVersionIds },
      issues,
      blockedMembers: members.map((member) => member.key),
    };
  }

  // A confirmation must state something. Silence on BOTH sides is refused up
  // front; silence on ONE side is refused by `planMember`, because F07-R06
  // requires the summary side to be either updated or explicitly reviewed.
  const recordStated = input.record.content !== undefined || input.record.cleared === true || input.record.confirmUnchanged === true;
  const summaryStated = input.summary.content !== undefined || input.summary.cleared === true || input.summary.confirmUnchanged === true;
  if (!recordStated && !summaryStated && input.amendments.length === 0) {
    return { kind: 'reject', code: 'nothing-to-confirm', message: 'neither member states a candidate and there are no corrections' };
  }

  // --- classify both members against the official bodies at this queue slot.
  let plans: MemberPlan[];
  try {
    plans = members.map((member) => planMember(member.key, member.objectKind, member.objectId, member.input, currentEntryOf(scope, member.objectKind, member.objectId)));
  } catch (error) {
    if (error instanceof CoreError) return { kind: 'reject', code: 'invalid-input', message: error.message };
    throw error;
  }
  const recordPlan = plans[0];
  const summaryPlan = plans[1];
  if (recordPlan === undefined || summaryPlan === undefined) {
    return { kind: 'reject', code: 'invalid-input', message: 'both members of the pair must be planned' };
  }

  // --- applicability corrections, resolved against the post-commit bodies (APP-04).
  const payloadFor = (member: MemberKey): { plan: MemberPlan; content: ObjectContent } => {
    const plan = member === 'record' ? recordPlan : summaryPlan;
    const content = plan.versioned ? plan.nextContent : normalizeContent(currentEntryOf(scope, plan.objectKind, plan.objectId)?.content ?? EMPTY_CONTENT);
    return { plan, content };
  };
  const newAmendments: AmendmentEntry[] = [];
  for (const amendment of input.amendments) {
    const targetMember: MemberKey = amendment.targetMember ?? 'summary';
    const { plan, content } = payloadFor(targetMember);
    if (!(content.conclusions ?? []).some((conclusion) => conclusion.id === amendment.conclusionId)) {
      return {
        kind: 'reject',
        code: 'unknown-conclusion',
        message: `conclusion '${amendment.conclusionId}' is not part of member '${targetMember}' (${plan.objectKind})`,
      };
    }
    newAmendments.push({
      amendmentId: amendmentIdOf({
        updateId: input.updateId,
        scopeKind: input.scopeKind,
        scopeId: input.scopeId,
        conclusionId: `${targetMember}_${amendment.conclusionId}`,
      }),
      updateId: input.updateId,
      appliesTo: { scopeKind: input.scopeKind, scopeId: input.scopeId },
      target: { objectKind: plan.objectKind, objectId: plan.objectId, conclusionId: amendment.conclusionId },
      state: amendment.state,
      affectedFragments: amendment.affectedFragments ?? [],
      substitute: amendment.substitute ?? null,
      sourceVersionIds: amendment.sourceVersionIds ?? [],
      note: amendment.note ?? null,
      confirmedAt: input.at,
      seq: scope.amendments.length + newAmendments.length + 1,
      revision: scope.revision,
      applicabilityRevision: scope.applicabilityRevision + 1,
    });
  }

  // --- SAVE-04 / F07-R06 save gate: 概况待核对 (or a substantive record change)
  // blocks the official save until the summary side is reconciled -- either by
  // carrying a fresh summary candidate, or by the user explicitly confirming
  // that the summary needs no change (F07-R05).
  const target = shape.recheckTarget;
  const recheck = computeRecheck(input.scopeKind, input.scopeId, scope, drafts, input.at);
  const recordSubstantive = recordPlan.change === 'substantive' && recordPlan.versioned;
  const summaryResolved = summaryPlan.versioned || summaryPlan.confirmUnchanged;
  if ((recheck[target].pending || recordSubstantive) && !summaryResolved) {
    const reasons = recheck[target].pending
      ? recheck[target].reasons
      : [
          {
            code: 'record-changed' as const,
            detail: `member 'record' changed substantively (${recordPlan.changeKind}) and member 'summary' was not reconciled in the same confirmation`,
            updateId: input.updateId,
            draftId: null,
            at: input.at,
          },
        ];
    return { kind: 'recheck-pending', target, reasons, blockedMembers: ['record', 'summary'] };
  }

  // F06-R07: a summary may legitimately change while the record does not, but
  // the record side must still be stated, so silence never hides an unreviewed
  // record.
  if (summaryPlan.versioned && recordPlan.change === 'unstated') {
    return {
      kind: 'reject',
      code: 'invalid-input',
      message: "member 'record' must be stated (content, cleared, or confirmUnchanged) when the summary is being updated",
    };
  }

  const changed: MemberKey[] = [];
  const cleared: MemberKey[] = [];
  const unchanged: MemberKey[] = [];
  const cosmeticOnly: MemberKey[] = [];
  for (const plan of plans) {
    if (plan.versioned) {
      changed.push(plan.key);
      if (plan.changeKind === 'cleared') cleared.push(plan.key);
    } else {
      unchanged.push(plan.key);
      if (plan.change === 'cosmetic') cosmeticOnly.push(plan.key);
    }
  }

  if (changed.length === 0 && newAmendments.length === 0) {
    return { kind: 'no-change', unchanged, cosmeticOnly };
  }

  // --- build the next head record: everything a confirmation changes, in one value.
  const chains: Record<ObjectKind, Record<string, readonly VersionEntry[]>> = {
    taskRecord: { ...scope.chains.taskRecord },
    taskSummary: { ...scope.chains.taskSummary },
    projectRecord: { ...scope.chains.projectRecord },
    projectOverview: { ...scope.chains.projectOverview },
  };
  const current: Record<ObjectKind, Record<string, string>> = {
    taskRecord: { ...scope.current.taskRecord },
    taskSummary: { ...scope.current.taskSummary },
    projectRecord: { ...scope.current.projectRecord },
    projectOverview: { ...scope.current.projectOverview },
  };
  const revision = scope.revision + (changed.length > 0 ? 1 : 0);
  const applicabilityRevision = scope.applicabilityRevision + (newAmendments.length > 0 ? 1 : 0);
  const payloads: MemberVersionPayload[] = [];
  for (const plan of plans) {
    if (!plan.versioned) continue;
    const chain = chains[plan.objectKind][plan.objectId] ?? [];
    const versionId = versionIdOf({ updateId: input.updateId, objectKind: plan.objectKind, objectId: plan.objectId });
    const entry: VersionEntry = {
      versionId,
      objectKind: plan.objectKind,
      objectId: plan.objectId,
      scopeKind: input.scopeKind,
      scopeId: input.scopeId,
      seq: chain.length + 1,
      updateId: input.updateId,
      confirmedAt: input.at,
      previousVersionId: chain[chain.length - 1]?.versionId ?? null,
      origin: input.origin,
      source: input.source,
      readSourceVersionIds: plan.input.readSourceVersionIds ?? [],
      coveredStage: plan.input.coveredStage ?? null,
      aiDraft: plan.input.aiDraft ?? null,
      userResult: plan.input.userResult ?? null,
      changeKind: plan.changeKind,
      content: plan.nextContent,
      revision,
      applicabilityRevision,
      restoredFrom: input.restoredFrom,
    };
    chains[plan.objectKind] = { ...chains[plan.objectKind], [plan.objectId]: [...chain, entry] };
    current[plan.objectKind] = { ...current[plan.objectKind], [plan.objectId]: versionId };
    payloads.push({ member: plan.key, entry });
  }

  // SAVE-04: a reconciliation that lands clears the marker for its own target;
  // staleness from any other surviving draft is re-derived on every read.
  const clearsRecheck = changed.length > 0 && summaryResolved && recheck[target].pending;
  const nextRecheck: Record<RecheckTarget, RecheckFlag> =
    target === 'taskSummary'
      ? { taskSummary: clearsRecheck ? emptyFlag() : copyFlag(scope.recheck.taskSummary), projectOverview: copyFlag(scope.recheck.projectOverview) }
      : { taskSummary: copyFlag(scope.recheck.taskSummary), projectOverview: clearsRecheck ? emptyFlag() : copyFlag(scope.recheck.projectOverview) };

  // F01-R07 / SAVE-08: a confirmation is an important change, so its history
  // entry is published by the SAME write that publishes the new versions.
  const next: ScopeStateRecord = {
    ...scope,
    revision,
    applicabilityRevision,
    lastCommittedUpdateId: input.updateId,
    lastConfirmedAt: input.at,
    current,
    chains,
    amendments: [...scope.amendments, ...newAmendments],
    recheck: nextRecheck,
    updatedAt: input.at,
  };
  const withActivity = appendActivity(next, {
    code: 'pair-confirmed',
    summary: `已确认${changed.length > 0 ? '并保存' : '核对'}：${changed.join('+') || '仅适用性修正'}（第 ${revision} 次提交）`,
    details: {
      updateId: input.updateId,
      revision: String(revision),
      changed: changed.join(','),
      amended: String(newAmendments.length),
    },
    at: input.at,
  });

  return {
    kind: 'commit',
    next: withActivity,
    versions: payloads.map((payload) => ({ member: payload.member, versionId: payload.entry.versionId, seq: payload.entry.seq })),
    amendmentIds: newAmendments.map((amendment) => amendment.amendmentId),
    changed,
    cleared,
    unchanged,
    cosmeticOnly,
    clearsRecheck,
  };
}

/** Create the core model over a storage port. */
export function createKanbanCore(options: CoreOptions): KanbanCore {
  const port: StoragePort = options.port;
  const now = options.now ?? ((): string => new Date().toISOString());
  const SCOPE_TABLE = AIKANBAN_TABLES.scopeState;
  const DRAFT_TABLE = AIKANBAN_TABLES.drafts;

  const readScope = (scopeKind: ScopeKind, scopeId: string): ScopeStateRecord | undefined =>
    readScopeRecord(port, SCOPE_TABLE, scopeKind, scopeId);

  const readDrafts = (): readonly DraftRecord[] => [...port.entries<DraftRecord>(DRAFT_TABLE)].map(([, draft]) => draft);

  const scopeDrafts = (scopeKind: ScopeKind, scopeId: string, candidateOnly: boolean): readonly DraftRecord[] =>
    readDrafts().filter(
      (draft) =>
        draft.scopeKind === scopeKind &&
        draft.scopeId === scopeId &&
        (!candidateOnly || CANDIDATE_STATES.has(draft.state)),
    );

  /**
   * Find which scope already owns an attributed object. Attribution is stored
   * inside each scope head, so a global uniqueness check ("不解除、改绑或跨任务
   * 转移", OBJ-03) needs a scan of the head table. Linking is a rare,
   * user-initiated action, and the scan is synchronous over in-memory state.
   */
  const findAttributionOwner = (
    kind: 'conversation' | 'outcomeTask',
    objectId: string,
  ): { scopeKind: ScopeKind; scopeId: string } | undefined => {
    for (const [, record] of port.entries<ScopeStateRecord>(SCOPE_TABLE)) {
      if (kind === 'conversation') {
        const link = record.links.conversations[objectId];
        if (link !== undefined) return { scopeKind: record.scope.kind, scopeId: link.taskId };
      } else {
        const link = record.links.outcomeTasks[objectId];
        if (link !== undefined) return { scopeKind: record.scope.kind, scopeId: link.projectId };
      }
    }
    return undefined;
  };

  /** Persist a 待核对 marker without touching official content (best effort, never fails the caller). */
  const persistRecheck = async (
    scopeKind: ScopeKind,
    scopeId: string,
    target: RecheckTarget,
    reason: RecheckReason,
  ): Promise<boolean> => {
    try {
      await port.update<ScopeStateRecord>(SCOPE_TABLE, scopeKey(scopeKind, scopeId), (raw) => {
        const scope = normalizeScope(raw);
        if (scope === undefined) return raw;
        const flag = scope.recheck[target];
        if (flag.reasons.some((existing) => existing.code === reason.code && existing.detail === reason.detail)) return scope;
        const nextFlag: RecheckFlag = {
          pending: true,
          reasons: appendReason(flag.reasons, reason),
          markedAt: flag.markedAt ?? reason.at,
        };
        const recheck: Record<RecheckTarget, RecheckFlag> =
          target === 'taskSummary'
            ? { taskSummary: nextFlag, projectOverview: copyFlag(scope.recheck.projectOverview) }
            : { taskSummary: copyFlag(scope.recheck.taskSummary), projectOverview: nextFlag };
        return { ...scope, recheck, updatedAt: reason.at };
      });
      return true;
    } catch {
      return false;
    }
  };

  /** Mark every consumed draft; runs only after the commit is already durable. */
  const consumeDrafts = async (
    draftIds: readonly string[],
    updateId: string,
    revision: number,
    at: string,
  ): Promise<{ consumed: string[]; failures: string[] }> => {
    const consumed: string[] = [];
    const failures: string[] = [];
    for (const draftId of draftIds) {
      try {
        await port.update<DraftRecord>(DRAFT_TABLE, draftId, (draft) => ({
          ...draft,
          state: 'saved',
          consumedBy: { updateId, revision },
          updatedAt: at,
        }));
        consumed.push(draftId);
      } catch (error) {
        failures.push(`${draftId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { consumed, failures };
  };

  const toPairView = (scope: ScopeStateRecord, recordObjectId: string, at: string): PairView => {
    const shape = pairShapeOf(scope.scope.kind);
    const recordEntry = currentEntryOf(scope, shape.record, recordObjectId);
    const summaryEntry = currentEntryOf(scope, shape.summary, scope.scope.id);
    const record = recordEntry === null ? null : toObjectView(scope, recordEntry);
    const summary = summaryEntry === null ? null : toObjectView(scope, summaryEntry);
    const recheck = computeRecheck(scope.scope.kind, scope.scope.id, scope, readDrafts(), at);
    return {
      scopeKind: scope.scope.kind,
      scopeId: scope.scope.id,
      revision: scope.revision,
      applicabilityRevision: scope.applicabilityRevision,
      consistent: true,
      record,
      summary,
      recheck,
      pairToken: fingerprint({
        revision: scope.revision,
        applicabilityRevision: scope.applicabilityRevision,
        record: record?.readToken ?? null,
        summary: summary?.readToken ?? null,
      }),
    };
  };

  const confirmPaired = async (input: ConfirmInput): Promise<ConfirmOutcome> => runConfirm(input, null);

  const runConfirm = async (
    input: ConfirmInput,
    restoredFrom: { readonly versionId: string; readonly at: string } | null,
  ): Promise<ConfirmOutcome> => {
    const key = scopeKey(input.scopeKind, input.scopeId);
    const scope = readScope(input.scopeKind, input.scopeId);
    if (scope === undefined) {
      return { status: 'rejected', code: 'unknown-scope', message: `no ${input.scopeKind} scope '${input.scopeId}'` };
    }
    // F06-R01: re-check the project and the fixed attribution before confirming.
    const linked =
      input.scopeKind === 'task'
        ? scope.links.conversations[input.recordObjectId]?.taskId === input.scopeId
        : scope.links.outcomeTasks[input.recordObjectId]?.projectId === input.scopeId;
    if (!linked) {
      return {
        status: 'rejected',
        code: 'unlinked-conversation',
        message: `object '${input.recordObjectId}' is not linked to ${input.scopeKind} '${input.scopeId}'`,
      };
    }

    const at = input.confirmedAt ?? now();
    const evalInput: EvalInput = {
      scopeKind: input.scopeKind,
      scopeId: input.scopeId,
      recordObjectId: input.recordObjectId,
      updateId: input.updateId,
      expected: input.expected,
      origin: input.origin,
      source: input.source ?? {},
      at,
      record: input.record,
      summary: input.summary,
      amendments: input.amendments ?? [],
      restoredFrom,
    };
    const target = pairShapeOf(input.scopeKind).recheckTarget;

    // Pre-flight on a read snapshot: a doomed confirmation performs no write.
    const fast = evaluate(evalInput, scope, readDrafts());
    if (fast.kind === 'reject') return { status: 'rejected', code: fast.code, message: fast.message };
    if (fast.kind === 'already-applied') {
      return {
        status: 'already-applied',
        revision: scope.revision,
        applicabilityRevision: scope.applicabilityRevision,
        appliedRevision: fast.appliedRevision,
        appliedAt: fast.appliedAt,
        versions: fast.versions,
      };
    }
    if (fast.kind === 'no-change') {
      return {
        status: 'no-change',
        revision: scope.revision,
        processingPositionHint: input.bothCheckedNoUpdate === true ? 'advance' : 'hold',
        unchanged: fast.unchanged,
        cosmeticOnly: fast.cosmeticOnly,
        wrote: false,
      };
    }
    if (fast.kind === 'baseline-changed' || fast.kind === 'recheck-pending') {
      return blockedOutcome(input, scope, fast, at, target, true);
    }

    // F06-R06: "一组成对更新只有一个活动确认身份" -- a draft that already
    // carries this confirmation's identity belongs to it, so a successful
    // commit consumes it without the caller having to list it (and the winner's
    // own draft can never linger and wrongly re-flag the summary).
    const claimedByIdentity = readDrafts()
      .filter(
        (draft) =>
          draft.scopeKind === input.scopeKind &&
          draft.scopeId === input.scopeId &&
          draft.updateId === input.updateId &&
          CANDIDATE_STATES.has(draft.state),
      )
      .map((draft) => draft.draftId);
    const draftsToConsume = [...new Set([...(input.consumeDraftIds ?? []), ...claimedByIdentity])];

    // Authoritative pass: the whole decision runs at the write slot.
    let outcome: EvalResult | undefined;
    await port.update<ScopeStateRecord>(SCOPE_TABLE, key, (raw) => {
      const current = normalizeScope(raw) ?? raw;
      const result = evaluate(evalInput, current, readDrafts());
      outcome = result;
      return result.kind === 'commit' ? result.next : current;
    });
    const decision: EvalResult = outcome ?? fast;

    if (decision.kind === 'commit') {
      const { consumed, failures } = await consumeDrafts(draftsToConsume, input.updateId, decision.next.revision, at);
      return {
        status: 'committed',
        revision: decision.next.revision,
        applicabilityRevision: decision.next.applicabilityRevision,
        versions: decision.versions,
        amendments: decision.amendmentIds,
        changed: decision.changed,
        cleared: decision.cleared,
        unchanged: decision.unchanged,
        cosmeticOnly: decision.cosmeticOnly,
        consumedDraftIds: consumed,
        draftUpdateFailures: failures,
        recheck: computeRecheck(input.scopeKind, input.scopeId, decision.next, readDrafts(), at),
        ...fieldsBaselineReport(decision.next, input.fieldBaseline),
      };
    }
    if (decision.kind === 'already-applied') {
      const latest = readScope(input.scopeKind, input.scopeId) ?? scope;
      return {
        status: 'already-applied',
        revision: latest.revision,
        applicabilityRevision: latest.applicabilityRevision,
        appliedRevision: decision.appliedRevision,
        appliedAt: decision.appliedAt,
        versions: decision.versions,
      };
    }
    if (decision.kind === 'no-change') {
      // Only reachable when a competitor landed between the two evaluations.
      return {
        status: 'no-change',
        revision: (readScope(input.scopeKind, input.scopeId) ?? scope).revision,
        processingPositionHint: input.bothCheckedNoUpdate === true ? 'advance' : 'hold',
        unchanged: decision.unchanged,
        cosmeticOnly: decision.cosmeticOnly,
        wrote: true,
      };
    }
    if (decision.kind === 'reject') return { status: 'rejected', code: decision.code, message: decision.message };
    return blockedOutcome(input, scope, decision, at, target, true);
  };

  async function blockedOutcome(
    input: ConfirmInput,
    snapshot: ScopeStateRecord,
    result:
      | { readonly kind: 'baseline-changed'; readonly actual: BaselineExpectation; readonly issues: readonly BaselineIssue[]; readonly blockedMembers: readonly MemberKey[] }
      | { readonly kind: 'recheck-pending'; readonly target: RecheckTarget; readonly reasons: readonly RecheckReason[]; readonly blockedMembers: readonly MemberKey[] },
    at: string,
    target: RecheckTarget,
    persist: boolean,
  ): Promise<ConfirmOutcome> {
    const latest = readScope(input.scopeKind, input.scopeId) ?? snapshot;
    let persisted = false;
    if (persist) {
      const reason: RecheckReason =
        result.kind === 'recheck-pending'
          ? result.reasons[0] ?? { code: 'manual', detail: 'reconciliation required', updateId: input.updateId, draftId: null, at }
          : {
              code: 'blocked-competitor',
              detail: `baseline moved before update '${input.updateId}' could commit: ${result.issues.map((issue) => issue.detail).join('; ')}`,
              updateId: input.updateId,
              draftId: null,
              at,
            };
      persisted = latest.recheck[target].pending ? true : await persistRecheck(input.scopeKind, input.scopeId, target, reason);
    }
    const recheck = computeRecheck(input.scopeKind, input.scopeId, latest, readDrafts(), at);
    const actual: BaselineExpectation =
      result.kind === 'baseline-changed'
        ? result.actual
        : {
            revision: latest.revision,
            applicabilityRevision: latest.applicabilityRevision,
            baseVersionIds: {
              record: currentVersionIdOf(latest, pairShapeOf(input.scopeKind).record, input.recordObjectId),
              summary: currentVersionIdOf(latest, pairShapeOf(input.scopeKind).summary, input.scopeId),
            },
          };
    return {
      status: 'blocked',
      code: result.kind === 'recheck-pending' ? 'recheck-pending' : 'baseline-changed',
      revision: latest.revision,
      expected: input.expected,
      actual,
      blockedMembers: result.blockedMembers,
      needsRecheck: recheckTargetsOf(input.scopeKind).filter((candidate) => recheck[candidate].pending),
      preservedDraftIds: scopeDrafts(input.scopeKind, input.scopeId, true).map((draft) => draft.draftId),
      recheckPersisted: persisted,
    };
  };

  const checkBaseline = (input: {
    scopeKind: ScopeKind;
    scopeId: string;
    recordObjectId: string;
    expected: BaselineExpectation;
  }): BaselineResult => {
    const at = now();
    const scope = readScope(input.scopeKind, input.scopeId);
    if (scope === undefined) {
      return {
        ok: false,
        expected: input.expected,
        actual: null,
        issues: [{ code: 'scope-missing', member: null, detail: `no ${input.scopeKind} scope '${input.scopeId}'` }],
        recheck: { taskSummary: emptyFlag(), projectOverview: emptyFlag(), staleDrafts: [] },
      };
    }
    const shape = pairShapeOf(input.scopeKind);
    const baseVersionIds: Partial<Record<MemberKey, string | null>> = {
      record: currentVersionIdOf(scope, shape.record, input.recordObjectId),
      summary: currentVersionIdOf(scope, shape.summary, input.scopeId),
    };
    const issues: BaselineIssue[] = [];
    if (scope.revision !== input.expected.revision) {
      issues.push({ code: 'revision-changed', member: null, detail: `expected ${input.expected.revision}, official ${scope.revision}` });
    }
    if (scope.applicabilityRevision !== input.expected.applicabilityRevision) {
      issues.push({
        code: 'applicability-changed',
        member: null,
        detail: `expected ${input.expected.applicabilityRevision}, official ${scope.applicabilityRevision}`,
      });
    }
    for (const member of ['record', 'summary'] as const) {
      const expectedId = input.expected.baseVersionIds[member];
      if (expectedId === undefined) continue;
      const actualId = baseVersionIds[member] ?? null;
      if (expectedId !== actualId) {
        issues.push({ code: 'member-base-changed', member, detail: `expected ${String(expectedId)}, official ${String(actualId)}` });
      }
    }
    const recheck = computeRecheck(input.scopeKind, input.scopeId, scope, readDrafts(), at);
    if (recheck[shape.recheckTarget].pending) {
      issues.push({
        code: 'recheck-pending',
        member: null,
        detail: `${shape.recheckTarget} is 待核对: ${recheck[shape.recheckTarget].reasons.map((reason) => reason.detail).join('; ')}`,
      });
    }
    return {
      ok: issues.length === 0,
      expected: input.expected,
      actual: { revision: scope.revision, applicabilityRevision: scope.applicabilityRevision, baseVersionIds },
      issues,
      recheck,
    };
  };

  const readObject = (input: {
    scopeKind: ScopeKind;
    scopeId: string;
    objectKind: ObjectKind;
    objectId: string;
  }): ObjectView | null => {
    const scope = readScope(input.scopeKind, input.scopeId);
    if (scope === undefined) return null;
    const entry = currentEntryOf(scope, input.objectKind, input.objectId);
    return entry === null ? null : toObjectView(scope, entry);
  };

  const readVersion = (input: {
    scopeKind: ScopeKind;
    scopeId: string;
    objectKind: ObjectKind;
    objectId: string;
    versionId: string;
  }): ObjectView | null => {
    const scope = readScope(input.scopeKind, input.scopeId);
    if (scope === undefined) return null;
    const entry = chainOf(scope, input.objectKind, input.objectId).find((candidate) => candidate.versionId === input.versionId);
    return entry === undefined ? null : toObjectView(scope, entry);
  };

  const core: Omit<KanbanCore, keyof PlanningApi> = {
    portName: port.name,

    async ensureScope(input) {
      const at = input.at ?? now();
      const existing = readScope(input.scopeKind, input.scopeId);
      if (existing !== undefined) return { created: false, revision: existing.revision };
      await port.put<ScopeStateRecord>(SCOPE_TABLE, scopeKey(input.scopeKind, input.scopeId), emptyScope(input.scopeKind, input.scopeId, at));
      return { created: true, revision: 0 };
    },

    async linkConversation(input): Promise<LinkOutcome> {
      const at = input.at ?? now();
      const key = scopeKey('task', input.taskId);
      const scope = readScope('task', input.taskId);
      if (scope === undefined) return { status: 'rejected', code: 'unknown-scope', message: `no task scope '${input.taskId}'` };
      const existing = scope.links.conversations[input.conversationId];
      if (existing !== undefined && existing.taskId !== input.taskId) {
        return {
          status: 'rejected',
          code: 'rebind-forbidden',
          message: `conversation '${input.conversationId}' already belongs to task '${existing.taskId}' (OBJ-03: attribution is fixed)`,
        };
      }
      if (existing === undefined) {
        // OBJ-03 is global, not per-task: another task may already own it.
        const owner = findAttributionOwner('conversation', input.conversationId);
        if (owner !== undefined && owner.scopeId !== input.taskId) {
          return {
            status: 'rejected',
            code: 'rebind-forbidden',
            message: `conversation '${input.conversationId}' already belongs to task '${owner.scopeId}' (OBJ-03: attribution is fixed)`,
          };
        }
      }
      let decision: 'linked' | 'already-linked' = existing !== undefined ? 'already-linked' : 'linked';
      if (existing === undefined) {
        await port.update<ScopeStateRecord>(SCOPE_TABLE, key, (raw) => {
          const current = normalizeScope(raw) ?? raw;
          const already = current.links.conversations[input.conversationId];
          if (already !== undefined) {
            decision = already.taskId === input.taskId ? 'already-linked' : 'linked';
            return current;
          }
          return {
            ...current,
            links: {
              ...current.links,
              conversations: {
                ...current.links.conversations,
                [input.conversationId]: { taskId: input.taskId, linkedAt: at },
              },
            },
            updatedAt: at,
          };
        });
      }
      return decision === 'already-linked'
        ? { status: 'already-linked', taskId: input.taskId, conversationId: input.conversationId }
        : { status: 'linked', taskId: input.taskId, conversationId: input.conversationId };
    },

    async linkOutcomeTask(input): Promise<LinkOutcome> {
      const at = input.at ?? now();
      const key = scopeKey('project', input.projectId);
      const scope = readScope('project', input.projectId);
      if (scope === undefined) return { status: 'rejected', code: 'unknown-scope', message: `no project scope '${input.projectId}'` };
      const existing = scope.links.outcomeTasks[input.taskId];
      if (existing !== undefined && existing.projectId !== input.projectId) {
        return {
          status: 'rejected',
          code: 'rebind-forbidden',
          message: `task '${input.taskId}' is already an outcome of project '${existing.projectId}'`,
        };
      }
      if (existing === undefined) {
        const owner = findAttributionOwner('outcomeTask', input.taskId);
        if (owner !== undefined && owner.scopeId !== input.projectId) {
          return {
            status: 'rejected',
            code: 'rebind-forbidden',
            message: `task '${input.taskId}' is already an outcome of project '${owner.scopeId}'`,
          };
        }
      }
      let decision: 'linked' | 'already-linked' = existing !== undefined ? 'already-linked' : 'linked';
      if (existing === undefined) {
        await port.update<ScopeStateRecord>(SCOPE_TABLE, key, (raw) => {
          const current = normalizeScope(raw) ?? raw;
          const already = current.links.outcomeTasks[input.taskId];
          if (already !== undefined) {
            decision = 'already-linked';
            return current;
          }
          return {
            ...current,
            links: {
              ...current.links,
              outcomeTasks: { ...current.links.outcomeTasks, [input.taskId]: { projectId: input.projectId, savedAt: at } },
            },
            updatedAt: at,
          };
        });
      }
      return decision === 'already-linked'
        ? { status: 'already-linked-outcome', projectId: input.projectId, taskId: input.taskId }
        : { status: 'linked-outcome', projectId: input.projectId, taskId: input.taskId };
    },

    draftIdFor(input) {
      const slot = draftSlotOf(input);
      return draftKey({
        kind: input.kind,
        scopeKind: input.scopeKind,
        scopeId: input.scopeId,
        objectId: slot.objectId,
      });
    },

    async saveDraft(input): Promise<DraftRecord> {
      const at = input.at ?? now();
      const slot = draftSlotOf(input);
      const scope = readScope(input.scopeKind, input.scopeId);
      if (scope === undefined) throw new CoreError('missing-scope', `no ${input.scopeKind} scope '${input.scopeId}'`);
      const draftId = core.draftIdFor(input);
      const existing = port.get<DraftRecord>(DRAFT_TABLE, draftId);
      const record: DraftRecord = {
        draftId,
        kind: input.kind,
        scopeKind: input.scopeKind,
        scopeId: input.scopeId,
        objectKind: slot.objectKind,
        objectId: slot.objectId,
        state: input.state ?? existing?.state ?? 'editing',
        base: {
          scopeRevision: scope.revision,
          applicabilityRevision: scope.applicabilityRevision,
          baseVersionIds: draftBaseVersionIds(scope, slot),
        },
        content: normalizeContent(input.content),
        aiDraftContent: input.aiDraftContent === undefined || input.aiDraftContent === null ? null : normalizeContent(input.aiDraftContent),
        rejectedSections: [...(input.rejectedSections ?? [])],
        pendingSummaryCandidate:
          input.pendingSummaryCandidate === undefined || input.pendingSummaryCandidate === null
            ? null
            : normalizeContent(input.pendingSummaryCandidate),
        updateId: input.updateId === undefined ? existing?.updateId ?? null : input.updateId,
        edited: input.edited ?? existing?.edited ?? false,
        createdAt: existing?.createdAt ?? at,
        updatedAt: at,
        consumedBy: existing?.consumedBy ?? null,
      };
      await port.put<DraftRecord>(DRAFT_TABLE, draftId, record);
      return record;
    },

    getDraft(draftId) {
      return port.get<DraftRecord>(DRAFT_TABLE, draftId) ?? null;
    },

    listDrafts(filter) {
      return readDrafts()
        .filter((draft) => (filter?.scopeKind === undefined || draft.scopeKind === filter.scopeKind))
        .filter((draft) => (filter?.scopeId === undefined || draft.scopeId === filter.scopeId))
        .filter((draft) => (filter?.kind === undefined || draft.kind === filter.kind))
        .filter((draft) => filter?.activeOnly !== true || CANDIDATE_STATES.has(draft.state))
        .sort((left, right) => (left.draftId < right.draftId ? -1 : left.draftId > right.draftId ? 1 : 0));
    },

    async setDraftState(draftId, state) {
      const at = now();
      if (port.get<DraftRecord>(DRAFT_TABLE, draftId) === undefined) {
        throw new CoreError('missing-draft', `no draft '${draftId}'`);
      }
      return port.update<DraftRecord>(DRAFT_TABLE, draftId, (draft) => ({ ...draft, state, updatedAt: at }));
    },

    async abandonDraft(draftId) {
      // SAVE-10: abandoning cancels this candidate only; official content and other drafts are untouched.
      return core.setDraftState(draftId, 'abandoned');
    },

    deleteDraft(draftId) {
      return port.delete(DRAFT_TABLE, draftId);
    },

    confirmPaired,

    async amendApplicability(input): Promise<AmendOutcome> {
      // Corrections ride the same single-write confirmation path (APP-04, F09-R04),
      // so 正式文案与状态 can never half-apply.
      return confirmPaired({
        ...input,
        record: { confirmUnchanged: true },
        summary: { confirmUnchanged: true },
        amendments: input.amendments,
      });
    },

    async restoreAsNewVersion(input): Promise<ConfirmOutcome> {
      const scope = readScope(input.scopeKind, input.scopeId);
      if (scope === undefined) {
        return { status: 'rejected', code: 'unknown-scope', message: `no ${input.scopeKind} scope '${input.scopeId}'` };
      }
      const shape = pairShapeOf(input.scopeKind);
      const target = chainOf(scope, shape.record, input.recordObjectId).find((entry) => entry.versionId === input.versionId);
      if (target === undefined) {
        return {
          status: 'rejected',
          code: 'unknown-version',
          message: `version '${input.versionId}' is not part of object '${input.recordObjectId}'`,
        };
      }
      // SAVE-09: the historical body is re-adopted as the new body, but
      // applicability is NOT revived -- amendments live at scope level and keep
      // outranking the body, so 失效结论 do not become current by restoring text.
      const amendments: AmendmentInput[] = (input.reconfirmApplicability ?? []).map((conclusionId) => ({
        conclusionId,
        targetMember: 'record',
        state: 'current',
        affectedFragments: [],
        substitute: null,
        sourceVersionIds: [target.versionId],
        note: `re-adopted from ${target.versionId}; applicability explicitly re-confirmed (SAVE-09)`,
      }));
      const at = input.confirmedAt ?? now();
      return runConfirm(
        {
          updateId: input.updateId,
          scopeKind: input.scopeKind,
          scopeId: input.scopeId,
          recordObjectId: input.recordObjectId,
          expected: input.expected,
          origin: input.origin,
          source: input.source,
          confirmedAt: at,
          record: {
            content: target.content,
            aiDraft: target.aiDraft,
            userResult: target.userResult,
            readSourceVersionIds: [target.versionId],
            coveredStage: target.coveredStage,
          },
          summary: input.summary,
          consumeDraftIds: input.consumeDraftIds,
          amendments,
        },
        { versionId: target.versionId, at },
      );
    },

    checkBaseline,

    readRecheck(input) {
      const scope = readScope(input.scopeKind, input.scopeId);
      if (scope === undefined) return { taskSummary: emptyFlag(), projectOverview: emptyFlag(), staleDrafts: [] };
      return computeRecheck(input.scopeKind, input.scopeId, scope, readDrafts(), now());
    },

    async clearRecheck(input) {
      // F07-R05: 手动核对完成 is a resolution, not a confirmation: no version, no revision bump (SAVE-10).
      const scope = readScope(input.scopeKind, input.scopeId);
      if (scope !== undefined && scope.recheck[input.target].pending) {
        await port.update<ScopeStateRecord>(SCOPE_TABLE, scopeKey(input.scopeKind, input.scopeId), (raw) => {
          const current = normalizeScope(raw) ?? raw;
          const recheck: Record<RecheckTarget, RecheckFlag> =
            input.target === 'taskSummary'
              ? { taskSummary: emptyFlag(), projectOverview: copyFlag(current.recheck.projectOverview) }
              : { taskSummary: copyFlag(current.recheck.taskSummary), projectOverview: emptyFlag() };
          return { ...current, recheck, updatedAt: now() };
        });
      }
      return core.readRecheck(input);
    },

    readPair(input) {
      const scope = readScope(input.scopeKind, input.scopeId);
      if (scope === undefined) return null;
      return toPairView(scope, input.recordObjectId, now());
    },

    readObject,

    readVersion,

    history(input) {
      const scope = readScope(input.scopeKind, input.scopeId);
      if (scope === undefined) return [];
      return chainOf(scope, input.objectKind, input.objectId).map((entry) => toObjectView(scope, entry));
    },

    readScopeState(input) {
      return readScope(input.scopeKind, input.scopeId) ?? null;
    },
  };

  // F01 project/task fields live in the very same scope heads (one management
  // action = one write), so the planning API is composed onto the one core
  // object instead of opening a second model.
  return { ...core, ...createPlanningApi({ port, now }) };
}

const DRAFT_OBJECT_KIND: Record<DraftKind, ObjectKind> = {
  taskRecord: 'taskRecord',
  projectRecord: 'projectRecord',
  summaryDraft: 'taskSummary',
  overviewDraft: 'projectOverview',
};

const DRAFT_SCOPE_KIND: Record<DraftKind, ScopeKind> = {
  taskRecord: 'task',
  projectRecord: 'project',
  summaryDraft: 'task',
  overviewDraft: 'project',
};

/**
 * Resolve one draft request to its slot (OBJ-07): the slot identity is the
 * storage key, so a slot can hold at most one draft by construction, and
 * different slots (other conversations, manual summary drafts) never collide.
 */
function draftSlotOf(input: {
  kind: DraftKind;
  scopeKind: ScopeKind;
  scopeId: string;
  objectId: string;
}): { objectKind: ObjectKind; objectId: string; manual: boolean } {
  const expectedScope = DRAFT_SCOPE_KIND[input.kind];
  if (input.scopeKind !== expectedScope) {
    throw new CoreError('invalid-input', `draft kind '${input.kind}' belongs to a ${expectedScope} scope, got ${input.scopeKind}`);
  }
  const objectKind = DRAFT_OBJECT_KIND[input.kind];
  const manual = objectKind === 'taskSummary' || objectKind === 'projectOverview';
  if (manual && input.objectId !== input.scopeId) {
    throw new CoreError('invalid-input', `draft kind '${input.kind}' always targets its own scope '${input.scopeId}'`);
  }
  return { objectKind, objectId: manual ? input.scopeId : input.objectId, manual };
}

/** The baseline a draft was built from (SAVE-05): recorded per member, so staleness is exact. */
function draftBaseVersionIds(
  scope: ScopeStateRecord,
  slot: { objectKind: ObjectKind; objectId: string; manual: boolean },
): Partial<Record<MemberKey, string | null>> {
  const shape = pairShapeOf(scope.scope.kind);
  if (slot.manual) return { summary: currentVersionIdOf(scope, slot.objectKind, slot.objectId) };
  return {
    record: currentVersionIdOf(scope, shape.record, slot.objectId),
    summary: currentVersionIdOf(scope, shape.summary, scope.scope.id),
  };
}
