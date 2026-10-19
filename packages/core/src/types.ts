/**
 * The AIKanBan core data model.
 *
 * Vocabulary follows `docs/prd/common/objects-and-states.md` (OBJ-05/06/07),
 * `confirmation-and-versions.md` (SAVE-01…10), `conclusion-applicability.md`
 * (APP-01…08) and `persistence-and-recovery.md` (REC-01…06). Rule ids are
 * cited at each type so a change here can be traced back to its requirement.
 *
 * @module @aikanban/core/types
 */

import type { StoragePort } from './port.ts';

/** Construction options for the core model. */
export interface CoreOptions {
  /** The medium: a memory port in tests, a `storageDomain` adapter in production. */
  readonly port: StoragePort;
  /** Clock, injectable so confirmations are reproducible in tests. */
  readonly now?: () => string;
}

/** A scope is one task or one project; it owns exactly one mutable head record. */
export type ScopeKind = 'task' | 'project';

/** The four official content objects of OBJ-05. */
export type ObjectKind = 'taskRecord' | 'taskSummary' | 'projectRecord' | 'projectOverview';

/**
 * The two members of a paired confirmation (SAVE-02): a record and the
 * summary it contributes to. `record` is always the detailed one.
 */
export type MemberKey = 'record' | 'summary';

/** The consistency marker each pair watches (OBJ-06: not the same label as 待确认结论). */
export type RecheckTarget = 'taskSummary' | 'projectOverview';

/** APP-02 four conclusion states. `pending` is a savable undecided question, not a save gate. */
export type ConclusionState = 'current' | 'superseded' | 'negated' | 'pending';

/** SAVE-08: where a confirmed version came from. */
export type Origin = 'ai' | 'user' | 'ai+user';

/** SAVE-02: a version is only produced for a real change; clearing is a delete change. */
export type ChangeKind = 'created' | 'modified' | 'cleared';

/** OBJ-07 draft granularity. */
export type DraftKind = 'taskRecord' | 'projectRecord' | 'summaryDraft' | 'overviewDraft';

/** OBJ-06 record-update states. `abandoned` replaces OBJ-06 已放弃. */
export type DraftState = 'editing' | 'ready' | 'needsRecheck' | 'saved' | 'abandoned' | 'failed';

/** One editable partition of a record (`F06-R03`, `F07-R01`). */
export interface ContentSection {
  readonly id: string;
  readonly title: string;
  readonly body: string;
}

/** A key conclusion carried by a version body (APP-01/02). */
export interface Conclusion {
  readonly id: string;
  readonly text: string;
  /** The state as written in this body; the effective state may be amended (APP-01). */
  readonly statedState: ConclusionState;
}

/** A record body: partitions plus annotated conclusions. */
export interface ObjectContent {
  readonly sections: readonly ContentSection[];
  readonly conclusions?: readonly Conclusion[];
}

/** SAVE-08 source identity of a version. */
export interface SourceRef {
  readonly conversationId?: string;
  readonly taskId?: string;
  readonly projectId?: string;
  readonly generator?: 'work-chat' | 'organize-chat' | 'manual';
}

/**
 * One immutable entry of an object's version chain (SAVE-08).
 * Entries are appended, never rewritten: a chain is the object's history.
 */
export interface VersionEntry {
  readonly versionId: string;
  readonly objectKind: ObjectKind;
  readonly objectId: string;
  readonly scopeKind: ScopeKind;
  readonly scopeId: string;
  /** 1-based position inside this object's chain. */
  readonly seq: number;
  readonly updateId: string;
  readonly confirmedAt: string;
  readonly previousVersionId: string | null;
  readonly origin: Origin;
  readonly source: SourceRef;
  /** 读取来源版本 (SAVE-08). */
  readonly readSourceVersionIds: readonly string[];
  /** 覆盖阶段 (SAVE-08). */
  readonly coveredStage: string | null;
  /** AI 原稿 (SAVE-03/08). */
  readonly aiDraft: string | null;
  /** 用户结果 (SAVE-03/08). */
  readonly userResult: string | null;
  readonly changeKind: ChangeKind;
  readonly content: ObjectContent;
  /** Scope content revision this version was committed at. */
  readonly revision: number;
  /** Scope applicability revision this version was committed at (F08-R02: baseline covers both). */
  readonly applicabilityRevision: number;
  /** SAVE-09: set when the body came from an earlier version through restore-as-new-version. */
  readonly restoredFrom: { readonly versionId: string; readonly at: string } | null;
}

/**
 * One confirmed applicability correction (APP-03/04, F09-R02/03).
 * `appliesTo` is the scope the user confirmed in: a negation in task A never
 * reaches task B even for identical text (F09-R03).
 */
export interface AmendmentEntry {
  readonly amendmentId: string;
  readonly updateId: string;
  readonly appliesTo: { readonly scopeKind: ScopeKind; readonly scopeId: string };
  readonly target: { readonly objectKind: ObjectKind; readonly objectId: string; readonly conclusionId: string };
  readonly state: ConclusionState;
  readonly affectedFragments: readonly string[];
  readonly substitute: string | null;
  readonly sourceVersionIds: readonly string[];
  readonly note: string | null;
  readonly confirmedAt: string;
  readonly seq: number;
  /** Scope content revision when this correction was confirmed. */
  readonly revision: number;
  /** Scope applicability revision this correction produced. */
  readonly applicabilityRevision: number;
}

/** Why a summary/overview is marked 待核对. */
export interface RecheckReason {
  /**
   * `goal-changed` is the F01-R05 trigger: a substantive goal edit changes what
   * the summary and the effective conclusions are about, so the affected summary
   * must be reviewed before the next paired save (SAVE-04/05).
   */
  readonly code: 'record-changed' | 'draft-stale' | 'blocked-competitor' | 'goal-changed' | 'manual';
  readonly detail: string;
  readonly updateId: string | null;
  readonly draftId: string | null;
  readonly at: string;
}

/** The persisted consistency marker. */
export interface RecheckFlag {
  readonly pending: boolean;
  readonly reasons: readonly RecheckReason[];
  readonly markedAt: string | null;
}

/** OBJ-03 fixed attribution: links are created once and never re-bound. */
export interface ScopeLinks {
  readonly conversations: Readonly<Record<string, { readonly taskId: string; readonly linkedAt: string }>>;
  readonly outcomeTasks: Readonly<Record<string, { readonly projectId: string; readonly savedAt: string }>>;
}

/**
 * The single mutable head of one scope: both members of every pair live in
 * this one record so that one `put` publishes a whole confirmation.
 */
export interface ScopeStateRecord {
  readonly schemaVersion: 1;
  readonly scope: { readonly kind: ScopeKind; readonly id: string };
  /** Content commit counter; one bump per confirmation that created a version. */
  readonly revision: number;
  /** Applicability counter; bumps on corrections even when no body version is added (F09-R06). */
  readonly applicabilityRevision: number;
  readonly lastCommittedUpdateId: string | null;
  readonly lastConfirmedAt: string | null;
  readonly links: ScopeLinks;
  /** Current version pointer per object kind, keyed by object id. */
  readonly current: Readonly<Record<ObjectKind, Readonly<Record<string, string>>>>;
  /** Append-only version chains per object kind, keyed by object id. */
  readonly chains: Readonly<Record<ObjectKind, Readonly<Record<string, readonly VersionEntry[]>>>>;
  readonly amendments: readonly AmendmentEntry[];
  readonly recheck: Readonly<Record<RecheckTarget, RecheckFlag>>;
  /**
   * F01-R07 / SAVE-08 重要活动历史: 目标、状态、归属、确认 changes, in order.
   * Keystrokes and page opens are never entries. It lives in the head record so
   * an important change and its history entry are published by ONE write.
   */
  readonly activity: readonly ActivityEntry[];
  /** F01 user fields; present on task scopes, null on a scope that holds content only. */
  readonly task: TaskFields | null;
  /** ADR-003 project registration and per-project board position; present on project scopes. */
  readonly project: ProjectFields | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/* ------------------------------------------------------------------------- *
 * F01 project and task fields
 * ------------------------------------------------------------------------- */

/** OBJ-02: the five task statuses. Archive is a visibility flag, never a status. */
export type TaskStatus = 'todo' | 'doing' | 'blocked' | 'done' | 'cancelled';

/** ADR-003: work-scope availability as observed by the host (`workspace.status()`). */
export type WorkScopeAvailability = 'ok' | 'missing-dir' | 'unknown';

/** F01-R07 / SAVE-08: the kinds of important change an activity history holds. */
export type ActivityCode =
  | 'task-created'
  | 'task-title-changed'
  | 'task-goal-changed'
  | 'task-status-changed'
  | 'task-blocked'
  | 'task-unblocked'
  | 'task-reopened'
  | 'task-order-changed'
  | 'task-attribution-changed'
  | 'task-undone'
  | 'task-undo-refused'
  | 'pair-confirmed'
  | 'project-registered'
  | 'project-updated'
  | 'work-scope-changed'
  | 'board-position-changed'
  | 'summary-recheck-marked';

/**
 * One important management change (F01-R07, SAVE-08). `summary` is the
 * display text captured at the moment of the change; `code` + `details` carry
 * the machine-readable form so a localized UI can render its own wording.
 */
export interface ActivityEntry {
  readonly activityId: string;
  readonly at: string;
  readonly scopeKind: ScopeKind;
  readonly scopeId: string;
  readonly code: ActivityCode;
  readonly summary: string;
  readonly details: Readonly<Record<string, string>>;
}

/**
 * F01-R05: an unsaved field input kept beside the official value. It is a draft
 * in the SAVE-01 sense: it never becomes the official title/goal until a
 * successful save, and reading it never advances the official update time.
 */
export interface PendingFieldDraft {
  readonly requestId: string;
  readonly title: string;
  readonly goal: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * F01-R05/R06: the task's user-owned fields. They are independent of records and
 * summaries (no confirmation can overwrite them), and only a successful
 * substantive change advances `updatedAt` / `fieldsRevision`.
 *
 * `recentFieldUpdateIds` is the idempotency window: a retried request (double
 * click, timeout retry, second window) is recognised even after a later edit,
 * so a stale retry can never resurrect an old value (REC-02/REC-04).
 */
export interface TaskFields {
  /** ADR-003: attribution is fixed at creation time to the project it was created in. */
  readonly projectId: string;
  readonly title: string;
  readonly goal: string;
  readonly status: TaskStatus;
  /** F02: required while the task is 已阻塞; kept in history after unblocking. */
  readonly blockedReason: string | null;
  /** OBJ-02/F17: visibility attribute. S1 never sets it; it is not a status. */
  readonly archived: boolean;
  /** F02-R05: manual position inside its column within this project. */
  readonly order: number;
  /** Bumped only by a successful substantive field change. */
  readonly fieldsRevision: number;
  /** Bumped only by a successful status or reopen change (F02-R01…R03). */
  readonly statusRevision: number;
  /** Bumped only by a substantive goal change (F01-R05). */
  readonly goalRevision: number;
  readonly lastFieldUpdateId: string | null;
  readonly lastStatusUpdateId: string | null;
  /** Newest first, bounded; the idempotency window described above. */
  readonly recentFieldUpdateIds: readonly string[];
  /** Newest first, bounded: status/reopen/undo requests already applied (REC-02). */
  readonly recentStatusUpdateIds: readonly string[];
  /**
   * F02-R04: the last user status operation, kept as a version/identity baseline
   * so an undo can never be decided by a timestamp. `null` means nothing to undo.
   */
  readonly lastStatusChange: StatusChangeRecord | null;
  /** The creation request that produced this task (identity behind the derived task id). */
  readonly requestId: string;
  /** F01-R05: local input preserved after a failed or outdated save. */
  readonly pendingFieldDraft: PendingFieldDraft | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** ADR-003 4.1: the observation of the work scope, never a rewritten path. */
export interface WorkScopeState {
  readonly availability: WorkScopeAvailability;
  readonly detail: string | null;
  readonly observedAt: string | null;
}

/** F01 user flow 7: each project keeps its own board position. */
export interface BoardPosition {
  readonly selectedTaskId: string | null;
  readonly view: string | null;
  readonly updatedAt: string | null;
}

/** The fields a status operation changes (F02-R04: "状态和适用字段"). */
export interface StatusSnapshot {
  readonly status: TaskStatus;
  readonly blockedReason: string | null;
}

/**
 * F02-R04: one applied status operation, stored so that undo is decided by a
 * verifiable identity/version and never by a timestamp:
 *  - `updateId` is the operation's identity; an undo must name it;
 *  - `from`/`to` are the applicable fields, restored verbatim by an undo.
 * A reorder deliberately does NOT create a record here: it changes the column
 * preference (a project-level fact) and must not be overwritten by a status undo.
 */
export interface StatusChangeRecord {
  readonly updateId: string;
  readonly at: string;
  readonly kind: 'transition' | 'undo';
  readonly from: StatusSnapshot;
  readonly to: StatusSnapshot;
}

/** ADR-003: project identity is `workspace.id`; `title` is display-only and never a key. */
export interface ProjectFields {
  readonly title: string;
  /** Work scope = `workspace.path`. It is never rewritten because a directory vanished. */
  readonly path: string;
  readonly workScope: WorkScopeState;
  readonly position: BoardPosition;
  /**
   * F02-R04 列内手动顺序：每个状态的**偏好 id 序列**（项目级，一次写即可保存整列顺序，
   * 不需要逐个任务写入）。它只是顺序偏好，不是成员清单：读取时按当前状态过滤，
   * 未列出的任务按 (任务自身 order, createdAt, taskId) 追加在末尾。因此
   * 「移动/重新打开后回到原列」会自动回到原位置，而不需要额外的写。
   */
  readonly boardOrder: Readonly<Record<TaskStatus, readonly string[]>>;
  /** Bumped whenever a column preference is saved, so readers can detect order drift. */
  readonly orderRevision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One line of official summary progress on a card (F02-R04 / OBJ-08). */
export interface TaskProgressView {
  readonly line: string;
  readonly versionId: string;
  readonly confirmedAt: string;
}

/** A task as served to the board and to the tools; never a second storage model. */
export interface TaskView {
  readonly taskId: string;
  readonly projectId: string;
  readonly title: string;
  readonly goal: string;
  readonly status: TaskStatus;
  readonly statusLabel: string;
  readonly blockedReason: string | null;
  readonly archived: boolean;
  /** The task's effective position inside its column (0-based), derived from the project preference list. */
  readonly order: number;
  readonly fieldsRevision: number;
  /** F02-R04 baseline: pass this back as `expected.statusRevision` for a status change. */
  readonly statusRevision: number;
  readonly goalRevision: number;
  /** The status operation that produced the current status (transition or undo). */
  readonly lastStatusUpdateId: string | null;
  /**
   * F02-R04: the exact baseline to hand to `undoStatusChange`, or `null` when the
   * current status is not the result of an undoable transition. A UI can render
   * 「撤销」 purely from this, and a lost race still comes back as a typed
   * `cannot-undo` with the current value.
   */
  readonly undoTarget: { readonly statusRevision: number; readonly appliedUpdateId: string } | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** 概况/总览待核对 for this task's summary (SAVE-04), derived from the scope head. */
  readonly needsRecheck: boolean;
  /** Machine-readable reasons (`goal-changed`, `draft-stale`, …) so a UI can localize its own wording. */
  readonly recheckCodes: readonly RecheckReason['code'][];
  readonly recheckReasons: readonly string[];
  /** Official summary progress; `null` means "use the goal" (never a draft, never the last record). */
  readonly summaryProgress: TaskProgressView | null;
  readonly hasSummary: boolean;
  readonly hasRecord: boolean;
  /** Retained input from a failed/outdated save, if any (F01-R05). */
  readonly pendingFieldDraft: PendingFieldDraft | null;
}

/** Work-scope view with the one decision the host must respect: may a real filesystem action run? */
export interface WorkScopeView {
  readonly path: string;
  readonly availability: WorkScopeAvailability;
  readonly detail: string | null;
  readonly observedAt: string | null;
  /** False only when an action would touch the filesystem while the scope is known unavailable (F01-R07). */
  readonly allowed: boolean;
  readonly reason: string | null;
}

/** A registered project with its own counts and board position (F01-R01). */
export interface ProjectView {
  readonly projectId: string;
  readonly title: string;
  readonly path: string;
  readonly workScope: WorkScopeView;
  readonly position: BoardPosition;
  readonly registeredAt: string;
  readonly updatedAt: string;
  readonly taskCounts: Readonly<Record<TaskStatus, number>>;
  readonly visibleTaskCount: number;
}

/** One board column (F02-R01). */
export interface BoardColumnView {
  readonly status: TaskStatus;
  readonly label: string;
  readonly collapsedByDefault: boolean;
  readonly count: number;
  readonly tasks: readonly TaskView[];
}

/** The one guarded board read; a failed or unregistered project is never an empty board (F01 §3). */
export type BoardReadResult =
  | {
      readonly status: 'ok';
      readonly project: ProjectView;
      readonly tasks: readonly TaskView[];
      readonly columns: readonly BoardColumnView[];
      readonly recheck: RecheckView;
      /** Change token: a caller can discard a late response that no longer matches its selection. */
      readonly boardToken: string;
    }
  | {
      readonly status: 'unknown-project';
      readonly projectId: string;
      readonly tasks: readonly [];
      /** Not registered (or registered content-only): the board must not render an empty project. */
      readonly message: string;
    }
  | {
      readonly status: 'failed';
      readonly projectId: string;
      readonly code: 'read-failed';
      readonly message: string;
    };

/** Result of a project-level mutation (registration, work-scope observation, board position). */
export type ProjectOutcome =
  | {
      readonly status: 'registered' | 'refreshed' | 'recorded' | 'saved' | 'unchanged';
      readonly project: ProjectView;
    }
  | { readonly status: 'rejected'; readonly code: 'invalid-input' | 'unknown-project'; readonly message: string };

/** F01-R02/R03: everything the caller typed, echoed back so a refusal never loses input. */
export interface KeptTaskInput {
  readonly title: string;
  readonly goal: string;
  readonly initialStatus: TaskStatus;
  readonly blockedReason: string | null;
}

/** Outcome of `createTask` (REC-02/REC-03). */
export type CreateTaskOutcome =
  | {
      readonly status: 'created' | 'already-created';
      readonly taskId: string;
      readonly task: TaskView;
      /** Reported attribution: the project this creation belongs to, not the page's current title. */
      readonly project: ProjectView;
    }
  | {
      readonly status: 'rejected';
      readonly code: 'invalid-title' | 'unknown-project' | 'invalid-input' | 'blocked-reason-required' | 'invalid-status' | 'request-id-collision';
      readonly message: string;
      readonly keptInput: KeptTaskInput;
    }
  | {
      readonly status: 'failed';
      readonly code: 'write-failed';
      readonly message: string;
      readonly taskId: string;
      readonly projectId: string;
      readonly requestId: string;
      readonly keptInput: KeptTaskInput;
    };

/** REC-03: check the actual result of a creation whose outcome was unknown. */
export type CreateLookupResult =
  | { readonly status: 'created'; readonly task: TaskView }
  | { readonly status: 'not-created'; readonly taskId: string; readonly projectId: string }
  | { readonly status: 'failed'; readonly code: 'read-failed'; readonly message: string; readonly taskId: string };

/** SAVE-05: the task-field baseline a review screen held before editing. */
export interface FieldsBaseline {
  readonly fieldsRevision: number;
  readonly statusRevision: number;
}

/** F01-R02: one refused or outdated input, echoed for the editor. */
export interface KeptFieldInput {
  readonly title: string | null;
  readonly goal: string | null;
}

/** Outcome of `updateTaskFields` (F01-R05/R06, REC-01/03/04). */
export type UpdateFieldsOutcome =
  | {
      readonly status: 'saved';
      readonly task: TaskView;
      readonly changed: readonly ('title' | 'goal')[];
      readonly fieldsRevision: number;
      readonly updatedAt: string;
      /** The task's own pending field draft was cleared by this save. */
      readonly draftDiscarded: boolean;
      /** A substantive goal change marked the task summary 待核对 in the same write. */
      readonly recheckMarked: boolean;
    }
  | { readonly status: 'no-change'; readonly task: TaskView; readonly cosmeticOnly: readonly ('title' | 'goal')[] }
  | {
      readonly status: 'already-applied';
      readonly task: TaskView;
      readonly appliedFieldsRevision: number;
      readonly appliedAt: string;
    }
  | {
      readonly status: 'baseline-changed';
      readonly task: TaskView;
      readonly expected: FieldsBaseline;
      readonly actual: FieldsBaseline;
      readonly draft: PendingFieldDraft | null;
      readonly draftPersisted: boolean;
    }
  | {
      readonly status: 'rejected';
      readonly code: 'unknown-task' | 'invalid-title' | 'invalid-input';
      readonly message: string;
      readonly keptInput: KeptFieldInput;
    }
  | {
      readonly status: 'failed';
      readonly code: 'write-failed' | 'missing-task';
      readonly message: string;
      readonly task: TaskView | null;
      readonly keptInput: KeptFieldInput;
      readonly draft: PendingFieldDraft;
      readonly draftPersisted: boolean;
    };

/** Outcome of `saveFieldDraft` (每键入不算实质更新). */
export type FieldDraftOutcome =
  | { readonly status: 'saved'; readonly draft: PendingFieldDraft }
  | { readonly status: 'rejected'; readonly code: 'unknown-task' | 'invalid-input'; readonly message: string };

/** The one guarded board read's input; a live work-scope hint is for display only and is not persisted. */
export interface BoardReadInput {
  readonly projectId: string;
  readonly workScope?: { readonly availability: WorkScopeAvailability; readonly detail?: string | null };
}

/* ------------------------------------------------------------------------- *
 * F02 status, column order and undo
 * ------------------------------------------------------------------------- */

/** F02-R04: the revision/identity baseline a status operation was decided against. */
export interface StatusBaseline {
  readonly statusRevision: number;
}

/** F02-R02/R04: one refused status input, echoed so a cancel keeps the user's typing. */
export interface KeptStatusInput {
  readonly toStatus: TaskStatus;
  readonly blockedReason: string | null;
}

/** F02-R01…R04: what a status/reopen change actually altered. */
export interface StatusChangeView {
  readonly status: TaskStatus;
  readonly previousStatus: TaskStatus;
  readonly blockedReason: string | null;
  readonly blockedCleared: boolean;
  readonly reopened: boolean;
  /** The task's position inside its column after the operation (0-based). */
  readonly order: number;
  readonly requestedIndex: number | null;
}

/** Outcome of `setTaskStatus` (F02-R01…R03, REC-01/02/04). */
export type StatusOutcome =
  | {
      readonly status: 'saved';
      readonly task: TaskView;
      readonly change: StatusChangeView;
      readonly statusRevision: number;
      /** The authoritative id order of the affected column, so the UI need not re-read. */
      readonly columnIds: readonly string[];
    }
  | { readonly status: 'no-change'; readonly task: TaskView }
  | {
      readonly status: 'already-applied';
      readonly task: TaskView;
      readonly appliedStatusRevision: number;
      readonly appliedAt: string;
    }
  | {
      readonly status: 'baseline-changed';
      readonly task: TaskView;
      readonly expected: StatusBaseline;
      readonly actual: StatusBaseline;
    }
  | {
      readonly status: 'rejected';
      readonly code: 'unknown-task' | 'unknown-project' | 'invalid-status' | 'blocked-reason-required' | 'invalid-input';
      readonly message: string;
      readonly keptInput: KeptStatusInput;
    }
  | {
      readonly status: 'failed';
      readonly code: 'write-failed';
      readonly message: string;
      readonly task: TaskView | null;
      readonly keptInput: KeptStatusInput;
    };

/** Outcome of `reorderTask` (F02-R04 列内手动排序). */
export type ReorderOutcome =
  | {
      readonly status: 'saved';
      readonly task: TaskView;
      /** The column this order belongs to (the discriminant `status` is the outcome kind). */
      readonly column: TaskStatus;
      readonly fromIndex: number;
      readonly toIndex: number;
      readonly columnIds: readonly string[];
      readonly orderRevision: number;
    }
  | { readonly status: 'no-change'; readonly task: TaskView; readonly columnIds: readonly string[] }
  | {
      readonly status: 'baseline-changed';
      readonly task: TaskView;
      readonly expected: StatusBaseline;
      readonly actual: StatusBaseline;
    }
  | {
      readonly status: 'rejected';
      readonly code: 'unknown-task' | 'unknown-project' | 'invalid-input';
      readonly message: string;
    }
  | { readonly status: 'failed'; readonly code: 'write-failed'; readonly message: string; readonly task: TaskView | null };

/** F02-R04: why an undo could not be applied, with the current value (REC-01). */
export type UndoRefusalCode = 'nothing-to-undo' | 'superseded' | 'unknown-task' | 'invalid-input';

/** Outcome of `undoStatusChange` (F02-R04: 撤销竞争必须用版本/身份判定). */
export type UndoOutcome =
  | {
      readonly status: 'undone';
      readonly task: TaskView;
      readonly restored: StatusSnapshot;
      readonly previousStatus: TaskStatus;
      readonly statusRevision: number;
    }
  | {
      readonly status: 'cannot-undo';
      readonly code: UndoRefusalCode;
      readonly message: string;
      readonly task: TaskView;
      /** The current official value, so the UI can show it instead of silently failing. */
      readonly current: StatusSnapshot;
      readonly currentStatusRevision: number;
      readonly currentAppliedUpdateId: string | null;
    }
  | { readonly status: 'rejected'; readonly code: 'unknown-task' | 'invalid-input'; readonly message: string }
  | { readonly status: 'failed'; readonly code: 'write-failed'; readonly message: string; readonly task: TaskView | null };

/** One active draft. At most one record exists per slot, so the slot is the whole inventory (OBJ-07). */
export interface DraftRecord {
  readonly draftId: string;
  readonly kind: DraftKind;
  readonly scopeKind: ScopeKind;
  readonly scopeId: string;
  readonly objectKind: ObjectKind;
  /** Conversation id (records) or task/project id (manual summary/overview drafts). */
  readonly objectId: string;
  readonly state: DraftState;
  /** The official baseline this candidate was built from (SAVE-05). */
  readonly base: {
    readonly scopeRevision: number;
    readonly applicabilityRevision: number;
    readonly baseVersionIds: Readonly<Partial<Record<MemberKey, string | null>>>;
  };
  /** The user result (SAVE-03). */
  readonly content: ObjectContent;
  /** The AI original (SAVE-03). */
  readonly aiDraftContent: ObjectContent | null;
  /** Partitions whose candidate was rejected: the official value stays (F07-R01). */
  readonly rejectedSections: readonly string[];
  /** F06-R05: the summary/overview candidate that belongs to the same confirmation. */
  readonly pendingSummaryCandidate: ObjectContent | null;
  /** One paired update has exactly one active confirmation identity (F06-R06). */
  readonly updateId: string | null;
  readonly edited: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Set when a confirmation consumed this draft; the draft itself is never deleted by a commit. */
  readonly consumedBy: { readonly updateId: string; readonly revision: number } | null;
}

/** A conclusion as read back, with its effective state and the correction that set it (APP-05). */
export interface ConclusionView {
  readonly id: string;
  readonly text: string;
  readonly statedState: ConclusionState;
  readonly state: ConclusionState;
  readonly amendedBy: string | null;
  readonly amendment: {
    readonly affectedFragments: readonly string[];
    readonly substitute: string | null;
    readonly sourceVersionIds: readonly string[];
    readonly note: string | null;
    readonly appliesTo: { readonly scopeKind: ScopeKind; readonly scopeId: string };
    readonly confirmedAt: string;
  } | null;
}

/** A current official object as served to callers (SAVE-02 default read). */
export interface ObjectView {
  readonly objectKind: ObjectKind;
  readonly objectId: string;
  readonly versionId: string;
  readonly seq: number;
  readonly confirmedAt: string;
  readonly origin: Origin;
  readonly source: SourceRef;
  readonly coveredStage: string | null;
  readonly aiDraft: string | null;
  readonly userResult: string | null;
  readonly previousVersionId: string | null;
  readonly readSourceVersionIds: readonly string[];
  readonly restoredFrom: { readonly versionId: string; readonly at: string } | null;
  readonly content: ObjectContent;
  readonly conclusions: readonly ConclusionView[];
  /**
   * Change token for readers that must decide whether their material is still
   * current (F11-R03, F09-R06). It covers the body version AND the effective
   * conclusion states, because a correction can change what to send even when
   * no new body version was written.
   */
  readonly readToken: string;
}

/** Derived + persisted consistency state of one scope. */
export interface RecheckView {
  readonly taskSummary: RecheckFlag;
  readonly projectOverview: RecheckFlag;
  /** Drafts whose official baseline moved under them; they are kept, never discarded (F08-R02). */
  readonly staleDrafts: readonly { readonly draftId: string; readonly reason: string }[];
}

/** A consistent snapshot of one pair, read from the single head record. */
export interface PairView {
  readonly scopeKind: ScopeKind;
  readonly scopeId: string;
  readonly revision: number;
  readonly applicabilityRevision: number;
  /** True by construction: both members come from one record read, so no half-applied state is possible. */
  readonly consistent: true;
  readonly record: ObjectView | null;
  readonly summary: ObjectView | null;
  readonly recheck: RecheckView;
  /** Combined change token of both members; stable while nothing relevant changed. */
  readonly pairToken: string;
}

/** SAVE-08 baseline a caller believes it is confirming against. */
export interface BaselineExpectation {
  readonly revision: number;
  readonly applicabilityRevision: number;
  readonly baseVersionIds: Readonly<Partial<Record<MemberKey, string | null>>>;
}

/** One issue found by `checkBaseline`. */
export interface BaselineIssue {
  readonly code:
    | 'scope-missing'
    | 'revision-changed'
    | 'applicability-changed'
    | 'member-base-changed'
    | 'recheck-pending';
  readonly member: MemberKey | null;
  readonly detail: string;
}

/** Result of the pre-flight baseline check (SAVE-05, F08-R02). */
export interface BaselineResult {
  readonly ok: boolean;
  readonly expected: BaselineExpectation;
  readonly actual: {
    readonly revision: number;
    readonly applicabilityRevision: number;
    readonly baseVersionIds: Readonly<Partial<Record<MemberKey, string | null>>>;
  } | null;
  readonly issues: readonly BaselineIssue[];
  readonly recheck: RecheckView;
}

/** One member of a confirmation request. */
export interface MemberInput {
  /** The new body. Omitted together with `cleared`/`confirmUnchanged` is invalid input. */
  readonly content?: ObjectContent;
  /** SAVE-02: an explicit clearing is a delete change and must not be read as "no update needed". */
  readonly cleared?: boolean;
  /** F07-R05: the user checked and this member needs no change. */
  readonly confirmUnchanged?: boolean;
  /** SAVE-04: a formatting-only edit may be saved as a version when the user asks for one. */
  readonly allowCosmeticVersion?: boolean;
  /** SAVE-03/08. */
  readonly aiDraft?: string | null;
  readonly userResult?: string | null;
  /** SAVE-08 读取来源版本. */
  readonly readSourceVersionIds?: readonly string[];
  /** SAVE-08 覆盖阶段. */
  readonly coveredStage?: string | null;
}

/** One requested applicability correction (APP-03). */
export interface AmendmentInput {
  readonly conclusionId: string;
  /** Which member of the pair carries the conclusion; defaults to `summary` (APP-04 概括/总览). */
  readonly targetMember?: MemberKey;
  readonly state: ConclusionState;
  readonly affectedFragments?: readonly string[];
  readonly substitute?: string | null;
  readonly sourceVersionIds?: readonly string[];
  readonly note?: string | null;
}

/** The single atomic confirmation request (SAVE-02/06, F06-R07, F08-R06). */
export interface ConfirmInput {
  /** The one confirmation identity shared by every entry point (F08-R06). */
  readonly updateId: string;
  readonly scopeKind: ScopeKind;
  readonly scopeId: string;
  /** Conversation id for a task scope, outcome task id for a project scope. */
  readonly recordObjectId: string;
  readonly expected: BaselineExpectation;
  readonly origin: Origin;
  readonly source?: SourceRef | undefined;
  readonly confirmedAt?: string;
  readonly record: MemberInput;
  readonly summary: MemberInput;
  /** Drafts this confirmation consumes; they are updated only after the commit lands. */
  readonly consumeDraftIds?: readonly string[] | undefined;
  /** Corrections that take effect in the same confirmation (APP-04, F09-R04). */
  readonly amendments?: readonly AmendmentInput[];
  /** SAVE-10: the user asserts both sides were checked and truly need no update. */
  readonly bothCheckedNoUpdate?: boolean;
  /**
   * SAVE-05 / F01-R06: the task-field baseline the review was opened against.
   * When it moved, the confirmation still lands (records never overwrite the new
   * fields) but reports `fieldsChangedSinceBaseline`, so the caller can show
   * 相关范围需核对 (AT-29).
   */
  readonly fieldBaseline?: FieldsBaseline;
}

/** Outcome of `confirmPaired`. */
export type ConfirmOutcome =
  | {
      readonly status: 'committed';
      readonly revision: number;
      readonly applicabilityRevision: number;
      readonly versions: readonly { readonly member: MemberKey; readonly versionId: string; readonly seq: number }[];
      readonly amendments: readonly string[];
      readonly changed: readonly MemberKey[];
      readonly cleared: readonly MemberKey[];
      readonly unchanged: readonly MemberKey[];
      readonly cosmeticOnly: readonly MemberKey[];
      readonly consumedDraftIds: readonly string[];
      readonly draftUpdateFailures: readonly string[];
      readonly recheck: RecheckView;
      /** F01-R06/SAVE-05: whether the task fields moved after the review was opened. */
      readonly fieldsChangedSinceBaseline: boolean;
      /** The task-field baseline after this write (null for project scopes). */
      readonly fieldsBaseline: FieldsBaseline | null;
    }
  | {
      readonly status: 'already-applied';
      readonly revision: number;
      readonly applicabilityRevision: number;
      readonly appliedRevision: number;
      readonly appliedAt: string;
      readonly versions: readonly { readonly member: MemberKey; readonly versionId: string; readonly seq: number }[];
    }
  | {
      readonly status: 'no-change';
      readonly revision: number;
      /** SAVE-10: only a checked "both truly need no update" may advance the processing position. */
      readonly processingPositionHint: 'advance' | 'hold';
      readonly unchanged: readonly MemberKey[];
      readonly cosmeticOnly: readonly MemberKey[];
      /**
       * `false` when the answer came from the read-only pre-flight (no write at
       * all). `true` only in the rare case where a competitor landed between
       * the two evaluations, so one redundant publish of identical bytes was
       * needed to settle it. Either way no version was created.
       */
      readonly wrote: boolean;
    }
  | {
      readonly status: 'blocked';
      readonly code: 'recheck-pending' | 'baseline-changed';
      readonly revision: number;
      readonly expected: BaselineExpectation;
      readonly actual: BaselineExpectation | null;
      readonly blockedMembers: readonly MemberKey[];
      readonly needsRecheck: readonly RecheckTarget[];
      readonly preservedDraftIds: readonly string[];
      readonly recheckPersisted: boolean;
    }
  | {
      readonly status: 'rejected';
      readonly code:
        | 'invalid-input'
        | 'unknown-scope'
        | 'unlinked-conversation'
        | 'unknown-conclusion'
        | 'unknown-version'
        | 'nothing-to-confirm'
        | 'unsupported-pair';
      readonly message: string;
    };

/** Result of a fixed-attribution link (OBJ-03). */
export type LinkOutcome =
  | { readonly status: 'linked'; readonly taskId: string; readonly conversationId: string }
  | { readonly status: 'already-linked'; readonly taskId: string; readonly conversationId: string }
  | { readonly status: 'linked-outcome'; readonly projectId: string; readonly taskId: string }
  | { readonly status: 'already-linked-outcome'; readonly projectId: string; readonly taskId: string }
  | { readonly status: 'rejected'; readonly code: 'unknown-scope' | 'rebind-forbidden' | 'invalid-input'; readonly message: string };

/** Input for `saveDraft` (SAVE-01, OBJ-07). */
export interface SaveDraftInput {
  readonly kind: DraftKind;
  readonly scopeKind: ScopeKind;
  readonly scopeId: string;
  readonly objectId: string;
  readonly content: ObjectContent;
  readonly aiDraftContent?: ObjectContent | null;
  readonly rejectedSections?: readonly string[];
  readonly pendingSummaryCandidate?: ObjectContent | null;
  readonly updateId?: string | null;
  readonly state?: DraftState;
  readonly edited?: boolean;
  readonly at?: string;
}

/** SAVE-09 restore-as-new-version request. */
export interface RestoreInput {
  readonly updateId: string;
  readonly scopeKind: ScopeKind;
  readonly scopeId: string;
  readonly recordObjectId: string;
  /** The historical version whose body is being re-adopted. */
  readonly versionId: string;
  readonly expected: BaselineExpectation;
  readonly origin: Origin;
  readonly source?: SourceRef | undefined;
  readonly confirmedAt?: string;
  /**
   * The summary side of the same confirmation. Required: SAVE-09 makes
   * "核对相关汇总" part of a restore, so the caller must state whether the
   * summary is being updated (`content`), or was reviewed and needs no change
   * (`confirmUnchanged`).
   */
  readonly summary: MemberInput;
  /** Conclusion ids the user explicitly re-confirms as applicable (SAVE-09: never automatic). */
  readonly reconfirmApplicability?: readonly string[];
  readonly consumeDraftIds?: readonly string[];
}

/** Outcome of `amendApplicability`. */
export type AmendOutcome = ConfirmOutcome;

/** The core model's public surface. */
export interface KanbanCore {
  readonly portName: string;

  linkConversation(input: { readonly taskId: string; readonly conversationId: string; readonly at?: string }): Promise<LinkOutcome>;
  linkOutcomeTask(input: { readonly projectId: string; readonly taskId: string; readonly at?: string }): Promise<LinkOutcome>;
  ensureScope(input: { readonly scopeKind: ScopeKind; readonly scopeId: string; readonly at?: string }): Promise<{ readonly created: boolean; readonly revision: number }>;

  saveDraft(input: SaveDraftInput): Promise<DraftRecord>;
  getDraft(draftId: string): DraftRecord | null;
  listDrafts(filter?: { readonly scopeKind?: ScopeKind; readonly scopeId?: string; readonly kind?: DraftKind; readonly activeOnly?: boolean }): readonly DraftRecord[];
  setDraftState(draftId: string, state: DraftState): Promise<DraftRecord>;
  abandonDraft(draftId: string): Promise<DraftRecord>;
  deleteDraft(draftId: string): Promise<boolean>;
  draftIdFor(input: { readonly kind: DraftKind; readonly scopeKind: ScopeKind; readonly scopeId: string; readonly objectId: string }): string;

  confirmPaired(input: ConfirmInput): Promise<ConfirmOutcome>;
  amendApplicability(input: Omit<ConfirmInput, 'record' | 'summary'> & { readonly amendments: readonly AmendmentInput[] }): Promise<AmendOutcome>;
  restoreAsNewVersion(input: RestoreInput): Promise<ConfirmOutcome>;

  checkBaseline(input: {
    readonly scopeKind: ScopeKind;
    readonly scopeId: string;
    readonly recordObjectId: string;
    readonly expected: BaselineExpectation;
  }): BaselineResult;
  readRecheck(input: { readonly scopeKind: ScopeKind; readonly scopeId: string }): RecheckView;
  clearRecheck(input: { readonly scopeKind: ScopeKind; readonly scopeId: string; readonly target: RecheckTarget }): Promise<RecheckView>;

  readPair(input: { readonly scopeKind: ScopeKind; readonly scopeId: string; readonly recordObjectId: string }): PairView | null;
  readObject(input: { readonly scopeKind: ScopeKind; readonly scopeId: string; readonly objectKind: ObjectKind; readonly objectId: string }): ObjectView | null;
  readVersion(input: { readonly scopeKind: ScopeKind; readonly scopeId: string; readonly objectKind: ObjectKind; readonly objectId: string; readonly versionId: string }): ObjectView | null;
  history(input: { readonly scopeKind: ScopeKind; readonly scopeId: string; readonly objectKind: ObjectKind; readonly objectId: string }): readonly ObjectView[];
  readScopeState(input: { readonly scopeKind: ScopeKind; readonly scopeId: string }): ScopeStateRecord | null;

  // --- F01 project isolation and task fields ---------------------------------

  /** Register or refresh a project (ADR-003: id = `workspace.id`, title is display-only). */
  registerProject(input: { readonly projectId: string; readonly title: string; readonly path: string; readonly at?: string }): Promise<ProjectOutcome>;
  readProject(input: BoardReadInput): ProjectView | null;
  listProjects(): readonly ProjectView[];
  /** Record the host's work-scope observation; never rewrites the path, never touches tasks or records. */
  observeWorkScope(input: {
    readonly projectId: string;
    readonly availability: WorkScopeAvailability;
    readonly detail?: string | null;
    readonly at?: string;
  }): Promise<ProjectOutcome>;
  /** The one decision a real filesystem action must consult (F01-R07). */
  canUseWorkScope(input: { readonly projectId: string }): {
    readonly projectId: string;
    readonly path: string | null;
    readonly availability: WorkScopeAvailability;
    readonly allowed: boolean;
    readonly reason: string | null;
  };
  saveBoardPosition(input: {
    readonly projectId: string;
    readonly selectedTaskId?: string | null;
    readonly view?: string | null;
    readonly at?: string;
  }): Promise<ProjectOutcome>;

  /** F01-R02/R03/R04: idempotent, side-effect-free task creation. */
  createTask(input: {
    readonly projectId: string;
    readonly requestId: string;
    readonly title: string;
    readonly goal?: string;
    readonly initialStatus?: TaskStatus;
    readonly blockedReason?: string;
    readonly at?: string;
  }): Promise<CreateTaskOutcome>;
  /** REC-03: resolve a creation whose result was unknown, before retrying. */
  lookupCreate(input: { readonly projectId: string; readonly requestId: string }): CreateLookupResult;

  /** The one guarded board read; distinguishes unregistered/failed from empty. */
  readBoard(input: BoardReadInput): BoardReadResult;
  readTask(input: { readonly taskId: string }): TaskView | null;
  /** F01-R05: substantive edits only; idempotent by `requestId`, baseline-checked by SAVE-05. */
  updateTaskFields(input: {
    readonly taskId: string;
    readonly requestId: string;
    readonly expected: FieldsBaseline;
    readonly title?: string;
    readonly goal?: string | null;
    readonly at?: string;
  }): Promise<UpdateFieldsOutcome>;
  saveFieldDraft(input: {
    readonly taskId: string;
    readonly requestId: string;
    readonly title?: string;
    readonly goal?: string | null;
    readonly at?: string;
  }): Promise<FieldDraftOutcome>;
  readFieldDraft(input: { readonly taskId: string }): PendingFieldDraft | null;
  discardFieldDraft(input: { readonly taskId: string }): Promise<boolean>;
  /** F01-R07: important changes only, newest first. */
  readActivity(input: {
    readonly scopeKind: ScopeKind;
    readonly scopeId: string;
    readonly limit?: number;
  }): readonly ActivityEntry[];

  // --- F02 status, column order and undo ------------------------------------

  /**
   * F02-R01…R03: the ONLY path that changes a task's status. Nothing else in
   * the model (confirmation, draft, field save, project outcome) touches it.
   * `toStatus: 'blocked'` requires a non-blank `blockedReason`.
   */
  setTaskStatus(input: {
    readonly taskId: string;
    readonly requestId: string;
    readonly toStatus: TaskStatus;
    readonly expected: StatusBaseline;
    readonly blockedReason?: string | null;
    /** Optional target position inside the destination column (drag with an index). */
    readonly toIndex?: number;
    readonly at?: string;
  }): Promise<StatusOutcome>;
  /** F02-R04: save one within-column manual position as ONE atomic write of the project head. */
  reorderTask(input: {
    readonly taskId: string;
    readonly requestId: string;
    readonly toIndex: number;
    readonly expected: StatusBaseline;
    readonly at?: string;
  }): Promise<ReorderOutcome>;
  /** F02-R04: undo one status operation, decided by `statusRevision` + `appliedUpdateId`. */
  undoStatusChange(input: {
    readonly taskId: string;
    readonly undoId: string;
    readonly expected: { readonly statusRevision: number; readonly appliedUpdateId: string };
    readonly at?: string;
  }): Promise<UndoOutcome>;
}
