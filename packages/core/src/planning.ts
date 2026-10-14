/**
 * F01 planning API: project isolation, task user fields and activity history.
 *
 * Design constraints this module exists to satisfy:
 *  - **Project identity is `workspace.id`** (ADR-003): titles are display-only
 *    and are never used as a lookup or de-duplication key.
 *  - **A task's user fields are independent of the official content** (F01-R05):
 *    no confirmation path writes `title`/`goal`, so 记录审核 cannot overwrite a
 *    newer field edit (F01-R06).
 *  - **Every management change is ONE write of ONE scope head.** The fields, the
 *    activity entry and (for a substantive goal change) the 概况待核对 marker are
 *    published together, so there is never a state where the change landed but
 *    its history or its reconciliation marker did not.
 *  - **Creation is idempotent by construction** (REC-02): the task id is derived
 *    from `(projectId, requestId)`, so double clicks and timeout retries can only
 *    ever reach the same record. Identity is verified against the stored
 *    `projectId`/`requestId`, never inferred from the title.
 *  - **An unavailable work scope is a visible state, not data loss** (F01-R07,
 *    ADR-003 4.1): management data stays readable and writable, the path is never
 *    rewritten, and only a real filesystem action is refused.
 *
 * @module @aikanban/core/planning
 */

import { AIKANBAN_TABLES, scopeKey } from './domainSpec.ts';
import { fingerprint } from './keys.ts';
import type { StoragePort } from './port.ts';
import {
  appendActivity,
  computeRecheck,
  currentEntryOf,
  emptyScope,
  markRecheck,
  normalizeScope,
  readAllScopeRecords,
  readScopeRecord,
} from './scopeRecord.ts';
import {
  BOARD_COLUMNS,
  compareTasks,
  isCosmeticGoalChange,
  isTaskStatus,
  isValidTaskTitle,
  isWorkScopeAvailability,
  normalizeGoal,
  normalizeTaskTitle,
  progressLineOf,
  statusLabelOf,
  summarize,
  taskIdOf,
  TASK_STATUSES,
} from './taskModel.ts';
import type {
  ActivityEntry,
  BoardColumnView,
  BoardReadInput,
  BoardReadResult,
  CreateLookupResult,
  CreateTaskOutcome,
  DraftRecord,
  FieldDraftOutcome,
  FieldsBaseline,
  KanbanCore,
  KeptFieldInput,
  KeptStatusInput,
  KeptTaskInput,
  PendingFieldDraft,
  ProjectFields,
  ProjectOutcome,
  ProjectView,
  RecheckReason,
  ReorderOutcome,
  ScopeStateRecord,
  StatusBaseline,
  StatusChangeView,
  StatusOutcome,
  StatusSnapshot,
  TaskFields,
  TaskStatus,
  TaskView,
  UndoOutcome,
  UndoRefusalCode,
  UpdateFieldsOutcome,
  WorkScopeAvailability,
  WorkScopeView,
} from './types.ts';

/** The planning methods `createKanbanCore` composes onto the content model. */
export type PlanningApi = Pick<
  KanbanCore,
  | 'registerProject'
  | 'readProject'
  | 'listProjects'
  | 'observeWorkScope'
  | 'canUseWorkScope'
  | 'saveBoardPosition'
  | 'createTask'
  | 'lookupCreate'
  | 'readBoard'
  | 'readTask'
  | 'updateTaskFields'
  | 'saveFieldDraft'
  | 'readFieldDraft'
  | 'discardFieldDraft'
  | 'readActivity'
  | 'setTaskStatus'
  | 'reorderTask'
  | 'undoStatusChange'
>;

/** What the planning API needs from its host: the port and a clock. */
export interface PlanningDeps {
  readonly port: StoragePort;
  readonly now: () => string;
}

const SCOPE = AIKANBAN_TABLES.scopeState;
const DRAFTS = AIKANBAN_TABLES.drafts;

const PROJECT_KEY = (projectId: string): string => scopeKey('project', projectId);
const TASK_KEY = (taskId: string): string => scopeKey('task', taskId);

/** Only a known-unavailable scope refuses a filesystem action; an unobserved one does not guess. */
function workScopeView(
  path: string,
  availability: WorkScopeAvailability,
  detail: string | null,
  observedAt: string | null,
): WorkScopeView {
  const allowed = availability !== 'missing-dir';
  return {
    path,
    availability,
    detail,
    observedAt,
    allowed,
    reason: allowed ? null : '工作范围不可用：目录不存在或不可访问；管理数据仍然保留',
  };
}

/* ------------------------------------------------------------------------- *
 * F02: column layout (manual order) helpers
 * ------------------------------------------------------------------------- */

/** No saved preference, no order revision: the state of a project that never reordered. */
const EMPTY_BOARD_ORDER: Readonly<Record<TaskStatus, readonly string[]>> = {
  todo: [],
  doing: [],
  blocked: [],
  done: [],
  cancelled: [],
};

/**
 * The effective board layout of one project.
 *
 * F02-R04 needs a manual order that is saved **reliably**: a column's order is a
 * preference list on the PROJECT head, so moving one card is ONE atomic write of
 * one record instead of N per-task writes that could fail halfway. The list is a
 * preference, not a membership list: it is filtered by each task's current
 * status, and tasks it does not mention are appended by
 * `(task.order, createdAt, taskId)`. That is what makes a task that moves away
 * and comes back land where it was, without any extra write.
 */
interface ColumnLayout {
  readonly ordered: Readonly<Record<TaskStatus, readonly ScopeStateRecord[]>>;
  readonly indexOf: ReadonlyMap<string, number>;
}

function layoutOf(project: ProjectFields | null, heads: readonly ScopeStateRecord[]): ColumnLayout {
  const present: Record<TaskStatus, ScopeStateRecord[]> = { todo: [], doing: [], blocked: [], done: [], cancelled: [] };
  for (const head of heads) {
    const task = head.task;
    if (task !== null) present[task.status].push(head);
  }
  const ordered: Record<TaskStatus, readonly ScopeStateRecord[]> = { todo: [], doing: [], blocked: [], done: [], cancelled: [] };
  const indexOf = new Map<string, number>();
  for (const status of TASK_STATUSES) {
    const remaining = new Map(present[status].map((head) => [head.scope.id, head]));
    const sequence: ScopeStateRecord[] = [];
    for (const id of project?.boardOrder[status] ?? []) {
      const head = remaining.get(id);
      if (head !== undefined) {
        sequence.push(head);
        remaining.delete(id);
      }
    }
    const rest = [...remaining.values()].sort((left, right) => {
      const a = left.task ?? null;
      const b = right.task ?? null;
      if (a === null || b === null) return 0;
      if (a.order !== b.order) return a.order - b.order;
      if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
      return left.scope.id < right.scope.id ? -1 : left.scope.id > right.scope.id ? 1 : 0;
    });
    const finalSequence = [...sequence, ...rest];
    ordered[status] = finalSequence;
    finalSequence.forEach((head, index) => indexOf.set(head.scope.id, index));
  }
  return { ordered, indexOf };
}

/** Clamp a requested position into `[0, length]`. */
function clampIndex(value: number, length: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(0, Math.trunc(value)), Math.max(0, length));
}

/** The synchronous status-change classification, shared by the pre-flight and the authoritative pass. */
type StatusDecisionKind = 'saved' | 'no-change' | 'already-applied' | 'baseline-changed' | 'unknown-task';

/** The synchronous field-edit classification, shared by the pre-flight and the authoritative pass. */
interface FieldsDecision {
  readonly kind: 'saved' | 'no-change' | 'already-applied' | 'baseline-changed' | 'rejected';
  readonly changed: readonly ('title' | 'goal')[];
  readonly cosmeticOnly: readonly ('title' | 'goal')[];
  readonly fieldsRevision: number;
  readonly updatedAt: string;
  readonly goalChanged: boolean;
  readonly actual: FieldsBaseline;
  readonly code: 'unknown-task' | 'invalid-title' | 'invalid-input';
  readonly message: string;
}

function fieldsDecision(input: {
  readonly kind: FieldsDecision['kind'];
  readonly actual: FieldsBaseline;
  readonly fieldsRevision: number;
  readonly extra?: Partial<FieldsDecision>;
}): FieldsDecision {
  return {
    kind: input.kind,
    changed: [],
    cosmeticOnly: [],
    fieldsRevision: input.fieldsRevision,
    updatedAt: '',
    goalChanged: false,
    actual: input.actual,
    code: 'invalid-input',
    message: '',
    ...input.extra,
  };
}

/**
 * Create the planning API over a port. The returned object is composed into the
 * single `KanbanCore` instance; it is never a second storage model, it reads and
 * writes the very same scope heads the paired confirmation uses.
 */
export function createPlanningApi(deps: PlanningDeps): PlanningApi {
  const port = deps.port;
  const now = deps.now;

  const readScope = (scopeKind: 'task' | 'project', scopeId: string): ScopeStateRecord | undefined =>
    readScopeRecord(port, SCOPE, scopeKind, scopeId);

  const readDrafts = (): readonly DraftRecord[] => [...port.entries<DraftRecord>(DRAFTS)].map(([, draft]) => draft);

  const taskHeadsOf = (projectId: string): readonly ScopeStateRecord[] =>
    readAllScopeRecords(port, SCOPE).filter(
      (record) => record.scope.kind === 'task' && record.task !== null && record.task.projectId === projectId,
    );

  const projectHeads = (): readonly ScopeStateRecord[] =>
    readAllScopeRecords(port, SCOPE).filter((record) => record.scope.kind === 'project' && record.project !== null);

  /** A task view is a pure function of the stored head plus the draft table (no clock, no cache). */
  const toTaskView = (head: ScopeStateRecord, drafts: readonly DraftRecord[], order: number): TaskView => {
    const task = head.task;
    if (task === null) throw new Error(`scope '${head.scope.id}' carries no task fields`);
    const summaryEntry = currentEntryOf(head, 'taskSummary', head.scope.id);
    const recheck = computeRecheck('task', head.scope.id, head, drafts, head.updatedAt);
    const progress = summaryEntry === null ? null : progressLineOf(summaryEntry.content);
    const undoable = task.lastStatusChange;
    return {
      taskId: head.scope.id,
      projectId: task.projectId,
      title: task.title,
      goal: task.goal,
      status: task.status,
      statusLabel: statusLabelOf(task.status),
      blockedReason: task.blockedReason,
      archived: task.archived,
      order,
      fieldsRevision: task.fieldsRevision,
      statusRevision: task.statusRevision,
      goalRevision: task.goalRevision,
      lastStatusUpdateId: task.lastStatusUpdateId,
      undoTarget:
        undoable !== null && undoable.kind === 'transition'
          ? { statusRevision: task.statusRevision, appliedUpdateId: undoable.updateId }
          : null,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      needsRecheck: recheck.taskSummary.pending,
      recheckCodes: recheck.taskSummary.reasons.map((reason) => reason.code),
      recheckReasons: recheck.taskSummary.reasons.map((reason) => reason.detail),
      summaryProgress:
        progress === null || summaryEntry === null
          ? null
          : { line: progress, versionId: summaryEntry.versionId, confirmedAt: summaryEntry.confirmedAt },
      hasSummary: summaryEntry !== null,
      hasRecord: Object.keys(head.current.taskRecord).length > 0,
      pendingFieldDraft: task.pendingFieldDraft,
    };
  };

  /**
   * The whole board state of one project, read once: heads, layout, and views
   * carrying their effective position. Every F02 mutation re-reads through this,
   * so a response always reports the state that is actually stored.
   */
  const boardStateOf = (
    projectId: string,
    drafts: readonly DraftRecord[],
  ): {
    readonly projectHead: ScopeStateRecord | undefined;
    readonly project: ProjectFields | null;
    readonly heads: readonly ScopeStateRecord[];
    readonly layout: ColumnLayout;
    readonly views: readonly TaskView[];
    readonly byId: ReadonlyMap<string, TaskView>;
  } => {
    const projectHead = readScope('project', projectId);
    const project = projectHead?.project ?? null;
    const heads = taskHeadsOf(projectId);
    const layout = layoutOf(project, heads);
    const views = heads.map((head) => toTaskView(head, drafts, layout.indexOf.get(head.scope.id) ?? 0));
    return { projectHead, project, heads, layout, views, byId: new Map(views.map((view) => [view.taskId, view])) };
  };

  const taskViewsOf = (
    projectId: string,
    drafts: readonly DraftRecord[],
  ): { readonly heads: readonly ScopeStateRecord[]; readonly views: readonly TaskView[] } => {
    const state = boardStateOf(projectId, drafts);
    return { heads: state.heads, views: state.views };
  };

  /** One task's view with its effective column position (needs its project's layout). */
  const taskViewOf = (head: ScopeStateRecord, drafts: readonly DraftRecord[]): TaskView => {
    const task = head.task;
    if (task === null) throw new Error(`scope '${head.scope.id}' carries no task fields`);
    const state = boardStateOf(task.projectId, drafts);
    return state.byId.get(head.scope.id) ?? toTaskView(head, drafts, task.order);
  };

  /**
   * Persist one column preference list (F02-R04). ONE write of the project head,
   * including its `task-order-changed` history entry.
   */
  const writeColumnPreference = async (
    projectId: string,
    column: TaskStatus,
    ids: readonly string[],
    at: string,
    requestId: string,
    taskId: string,
  ): Promise<void> => {
    await port.update<ScopeStateRecord>(SCOPE, PROJECT_KEY(projectId), (raw) => {
      const current = normalizeScope(raw);
      if (current === undefined || current.project === null) return raw;
      const project = current.project;
      const existing = project.boardOrder[column] ?? [];
      if (existing.length === ids.length && ids.every((id, index) => existing[index] === id)) return current;
      const order = ids.indexOf(taskId);
      const nextProject: ProjectFields = {
        ...project,
        boardOrder: { ...project.boardOrder, [column]: [...ids] },
        orderRevision: project.orderRevision + 1,
        updatedAt: at,
      };
      return appendActivity({ ...current, project: nextProject, updatedAt: at }, {
        code: 'task-order-changed',
        summary: `列内顺序已保存：${statusLabelOf(column)} 第 ${order + 1} 位`,
        details: { projectId, taskId, status: column, index: String(order), requestId },
        at,
      });
    });
  };

  const toProjectView = (
    head: ScopeStateRecord,
    tasks: readonly TaskView[],
    hint?: BoardReadInput['workScope'],
  ): ProjectView => {
    const project = head.project;
    if (project === null) throw new Error(`scope '${head.scope.id}' carries no project fields`);
    const availability: WorkScopeAvailability = hint?.availability ?? project.workScope.availability;
    const detail = hint === undefined ? project.workScope.detail : hint.detail ?? null;
    const counts = Object.fromEntries(TASK_STATUSES.map((status) => [status, 0])) as Record<TaskStatus, number>;
    for (const task of tasks) {
      if (task.archived) continue;
      counts[task.status] += 1;
    }
    return {
      projectId: head.scope.id,
      title: project.title,
      path: project.path,
      workScope: workScopeView(project.path, availability, detail, project.workScope.observedAt),
      position: project.position,
      registeredAt: project.createdAt,
      updatedAt: project.updatedAt,
      taskCounts: counts,
      visibleTaskCount: tasks.filter((task) => !task.archived).length,
    };
  };

  /** Read one project with its own tasks; `null` for a project that was never registered. */
  const projectViewOf = (projectId: string, hint?: BoardReadInput['workScope']): ProjectView | null => {
    const head = readScope('project', projectId);
    if (head === undefined || head.project === null) return null;
    return toProjectView(head, taskViewsOf(projectId, readDrafts()).views, hint);
  };

  const nextOrder = (projectId: string, status: TaskStatus): number => {
    const orders = taskHeadsOf(projectId)
      .filter((record) => record.task?.status === status)
      .map((record) => record.task?.order ?? 0);
    return orders.length === 0 ? 0 : Math.max(...orders) + 1;
  };

  /** Best-effort retention of unsaved input; never touches the official fields or their timestamps. */
  const persistFieldDraft = async (
    taskId: string,
    requestId: string,
    title: string,
    goal: string,
    at: string,
  ): Promise<{ readonly draft: PendingFieldDraft; readonly persisted: boolean }> => {
    const previous = readScope('task', taskId)?.task?.pendingFieldDraft ?? null;
    const draft: PendingFieldDraft = {
      requestId,
      title,
      goal,
      createdAt: previous !== null && previous.requestId === requestId ? previous.createdAt : at,
      updatedAt: at,
    };
    try {
      await port.update<ScopeStateRecord>(SCOPE, TASK_KEY(taskId), (raw) => {
        const current = normalizeScope(raw);
        if (current === undefined || current.task === null) return raw;
        return { ...current, task: { ...current.task, pendingFieldDraft: draft } };
      });
      return { draft, persisted: true };
    } catch {
      return { draft, persisted: false };
    }
  };

  const createTask = async (input: Parameters<KanbanCore['createTask']>[0]): Promise<CreateTaskOutcome> => {
    const projectId = typeof input.projectId === 'string' ? input.projectId.trim() : '';
    const requestId = typeof input.requestId === 'string' ? input.requestId.trim() : '';
    const rawTitle = typeof input.title === 'string' ? input.title : '';
    const title = normalizeTaskTitle(rawTitle);
    const goal = normalizeGoal(input.goal);
    const initialStatus: TaskStatus = input.initialStatus ?? 'todo';
    const blockedReason = input.blockedReason === undefined ? null : input.blockedReason.trim();
    const keptInput: KeptTaskInput = { title: rawTitle, goal, initialStatus, blockedReason };

    if (projectId.length === 0 || requestId.length === 0) {
      return {
        status: 'rejected',
        code: 'invalid-input',
        message: '创建任务需要 projectId（workspace.id）与 requestId（本次提交身份）',
        keptInput,
      };
    }
    if (!isTaskStatus(initialStatus)) {
      return { status: 'rejected', code: 'invalid-status', message: `未知状态 '${String(initialStatus)}'`, keptInput };
    }
    if (!isValidTaskTitle(title)) {
      return {
        status: 'rejected',
        code: 'invalid-title',
        message: '标题必填：只有空白字符的标题无效（F01-R02）',
        keptInput,
      };
    }
    if (initialStatus === 'blocked' && (blockedReason === null || blockedReason.length === 0)) {
      return {
        status: 'rejected',
        code: 'blocked-reason-required',
        message: '在已阻塞列创建任务必须填写原因；原因无效时不创建半成品任务（F01-R02）',
        keptInput,
      };
    }

    const projectHead = readScope('project', projectId);
    if (projectHead === undefined || projectHead.project === null) {
      return {
        status: 'rejected',
        code: 'unknown-project',
        message: `项目 '${projectId}' 尚未登记：不猜测归属位置（REC-05）`,
        keptInput,
      };
    }

    const at = input.at ?? now();
    const taskId = taskIdOf({ projectId, requestId });
    const key = TASK_KEY(taskId);
    const existing = readScope('task', taskId);
    if (existing !== undefined && existing.task !== null) {
      if (existing.task.projectId !== projectId || existing.task.requestId !== requestId) {
        return {
          status: 'rejected',
          code: 'request-id-collision',
          message: `任务 '${taskId}' 已存在且身份不同；请使用新的 requestId（不合并、不覆盖）`,
          keptInput,
        };
      }
      const drafts = readDrafts();
      return {
        status: 'already-created',
        taskId,
        task: taskViewOf(existing, drafts),
        project: toProjectView(projectHead, taskViewsOf(projectId, drafts).views),
      };
    }

    const fields: TaskFields = {
      projectId,
      title,
      goal,
      status: initialStatus,
      blockedReason,
      archived: false,
      order: nextOrder(projectId, initialStatus),
      fieldsRevision: 0,
      statusRevision: 0,
      goalRevision: 0,
      lastFieldUpdateId: null,
      lastStatusUpdateId: null,
      recentFieldUpdateIds: [],
      recentStatusUpdateIds: [],
      lastStatusChange: null,
      requestId,
      pendingFieldDraft: null,
      createdAt: at,
      updatedAt: at,
    };
    const created = {
      code: 'task-created' as const,
      summary: `任务已创建：${summarize(title)}`,
      details: { projectId, taskId, status: initialStatus, goal },
      at,
    };

    try {
      let decision: 'created' | 'already-created' = 'created';
      if (existing === undefined) {
        // One write publishes the whole new scope head: fields + first history entry.
        await port.put<ScopeStateRecord>(SCOPE, key, appendActivity({ ...emptyScope('task', taskId, at), task: fields }, created));
      } else {
        // The head exists from `ensureScope` (content-only): fill in the fields atomically.
        await port.update<ScopeStateRecord>(SCOPE, key, (raw) => {
          const current = normalizeScope(raw);
          if (current === undefined) return raw;
          if (current.task !== null) {
            decision = 'already-created';
            return current;
          }
          return appendActivity({ ...current, task: fields, updatedAt: at }, created);
        });
      }
      const stored = readScope('task', taskId);
      if (stored === undefined || stored.task === null) {
        return {
          status: 'failed',
          code: 'write-failed',
          message: '创建写入后读取不到任务：结果未知，请先 lookupCreate 核对（REC-03）',
          taskId,
          projectId,
          requestId,
          keptInput,
        };
      }
      const drafts = readDrafts();
      return {
        status: decision,
        taskId,
        task: taskViewOf(stored, drafts),
        project: toProjectView(readScope('project', projectId) ?? projectHead, taskViewsOf(projectId, drafts).views),
      };
    } catch (error) {
      // Nothing is durable: the port publishes durability before memory, so the
      // official list is unchanged and the caller can retry the SAME requestId.
      return {
        status: 'failed',
        code: 'write-failed',
        message: error instanceof Error ? error.message : String(error),
        taskId,
        projectId,
        requestId,
        keptInput,
      };
    }
  };

  const lookupCreate = (input: { readonly projectId: string; readonly requestId: string }): CreateLookupResult => {
    const projectId = typeof input.projectId === 'string' ? input.projectId.trim() : '';
    const requestId = typeof input.requestId === 'string' ? input.requestId.trim() : '';
    const taskId = taskIdOf({ projectId, requestId });
    try {
      const head = readScope('task', taskId);
      if (head !== undefined && head.task !== null && head.task.projectId === projectId && head.task.requestId === requestId) {
        return { status: 'created', task: taskViewOf(head, readDrafts()) };
      }
      return { status: 'not-created', taskId, projectId };
    } catch (error) {
      return {
        status: 'failed',
        code: 'read-failed',
        message: error instanceof Error ? error.message : String(error),
        taskId,
      };
    }
  };

  const updateTaskFields = async (input: Parameters<KanbanCore['updateTaskFields']>[0]): Promise<UpdateFieldsOutcome> => {
    const taskId = typeof input.taskId === 'string' ? input.taskId.trim() : '';
    const requestId = typeof input.requestId === 'string' ? input.requestId.trim() : '';
    const keptInput: KeptFieldInput = {
      title: input.title === undefined ? null : input.title,
      goal: input.goal === undefined ? null : input.goal,
    };
    if (taskId.length === 0 || requestId.length === 0) {
      return { status: 'rejected', code: 'invalid-input', message: 'taskId 与 requestId 均不能为空', keptInput };
    }
    if (input.title === undefined && input.goal === undefined) {
      return { status: 'rejected', code: 'invalid-input', message: '标题与目标都未给出：没有可保存的字段变化', keptInput };
    }

    const at = input.at ?? now();
    const key = TASK_KEY(taskId);
    const expected: FieldsBaseline = {
      fieldsRevision: input.expected.fieldsRevision,
      statusRevision: input.expected.statusRevision,
    };
    const wantsTitle = input.title !== undefined;
    const wantsGoal = input.goal !== undefined;
    const nextTitle = wantsTitle ? normalizeTaskTitle(input.title ?? '') : '';
    const nextGoal = wantsGoal ? normalizeGoal(input.goal) : '';
    if (wantsTitle && nextTitle.length === 0) {
      return {
        status: 'rejected',
        code: 'invalid-title',
        message: '标题必填：只有空白字符的标题无效（F01-R02）',
        keptInput,
      };
    }

    const head = readScope('task', taskId);
    if (head === undefined || head.task === null) {
      return { status: 'rejected', code: 'unknown-task', message: `任务 '${taskId}' 不存在`, keptInput };
    }
    const current = head.task;

    // Idempotency first: a retried request is recognised even after later edits,
    // so a stale retry can never resurrect an old value (REC-02/REC-04).
    if (current.recentFieldUpdateIds.includes(requestId)) {
      return {
        status: 'already-applied',
        task: taskViewOf(head, readDrafts()),
        appliedFieldsRevision: current.fieldsRevision,
        appliedAt: current.updatedAt,
      };
    }

    const atHead: FieldsBaseline = { fieldsRevision: current.fieldsRevision, statusRevision: current.statusRevision };
    const titleChanged = wantsTitle && nextTitle !== current.title;
    const goalDiffers = wantsGoal && nextGoal !== current.goal;
    const goalCosmetic = goalDiffers && isCosmeticGoalChange(nextGoal, current.goal);
    const goalChanged = goalDiffers && !goalCosmetic;
    if (!titleChanged && !goalChanged) {
      return {
        status: 'no-change',
        task: taskViewOf(head, readDrafts()),
        cosmeticOnly: goalCosmetic ? ['goal'] : [],
      };
    }
    if (atHead.fieldsRevision !== expected.fieldsRevision || atHead.statusRevision !== expected.statusRevision) {
      const { draft, persisted } = await persistFieldDraft(taskId, requestId, nextTitle, nextGoal, at);
      return {
        status: 'baseline-changed',
        task: readTask({ taskId }) ?? taskViewOf(head, readDrafts()),
        expected,
        actual: atHead,
        draft,
        draftPersisted: persisted,
      };
    }

    const decide = (raw: ScopeStateRecord): { readonly next: ScopeStateRecord; readonly decision: FieldsDecision } => {
      const scope = normalizeScope(raw);
      const task = scope?.task ?? null;
      if (scope === undefined || task === null) {
        return {
          next: raw,
          decision: fieldsDecision({
            kind: 'rejected',
            actual: atHead,
            fieldsRevision: 0,
            extra: { code: 'unknown-task', message: `任务 '${taskId}' 不存在` },
          }),
        };
      }
      const actual: FieldsBaseline = { fieldsRevision: task.fieldsRevision, statusRevision: task.statusRevision };
      if (task.recentFieldUpdateIds.includes(requestId)) {
        return {
          next: scope,
          decision: fieldsDecision({
            kind: 'already-applied',
            actual,
            fieldsRevision: task.fieldsRevision,
            extra: { updatedAt: task.updatedAt },
          }),
        };
      }
      if (actual.fieldsRevision !== expected.fieldsRevision || actual.statusRevision !== expected.statusRevision) {
        return { next: scope, decision: fieldsDecision({ kind: 'baseline-changed', actual, fieldsRevision: task.fieldsRevision }) };
      }
      const storedTitle = wantsTitle ? nextTitle : task.title;
      const storedGoal = wantsGoal ? nextGoal : task.goal;
      const storedTitleChanged = wantsTitle && nextTitle !== task.title;
      const storedGoalDiffers = wantsGoal && nextGoal !== task.goal;
      const storedGoalCosmetic = storedGoalDiffers && isCosmeticGoalChange(nextGoal, task.goal);
      const storedGoalChanged = storedGoalDiffers && !storedGoalCosmetic;
      if (!storedTitleChanged && !storedGoalChanged) {
        return {
          next: scope,
          decision: fieldsDecision({
            kind: 'no-change',
            actual,
            fieldsRevision: task.fieldsRevision,
            extra: { cosmeticOnly: storedGoalCosmetic ? ['goal'] : [] },
          }),
        };
      }
      const changed: ('title' | 'goal')[] = [];
      if (storedTitleChanged) changed.push('title');
      if (storedGoalChanged) changed.push('goal');
      const nextTask: TaskFields = {
        ...task,
        title: storedTitle,
        goal: storedGoal,
        fieldsRevision: task.fieldsRevision + 1,
        goalRevision: task.goalRevision + (storedGoalChanged ? 1 : 0),
        lastFieldUpdateId: requestId,
        recentFieldUpdateIds: [requestId, ...task.recentFieldUpdateIds].slice(0, 16),
        pendingFieldDraft: null,
        updatedAt: at,
      };
      let next: ScopeStateRecord = { ...scope, task: nextTask, updatedAt: at };
      if (storedTitleChanged) {
        next = appendActivity(next, {
          code: 'task-title-changed',
          summary: `标题已更新：${summarize(task.title)} → ${summarize(storedTitle)}`,
          details: { taskId, from: task.title, to: storedTitle, requestId },
          at,
        });
      }
      if (storedGoalChanged) {
        next = appendActivity(next, {
          code: 'task-goal-changed',
          summary: `目标已更新：${summarize(storedGoal)}`,
          details: { taskId, from: task.goal, to: storedGoal, requestId },
          at,
        });
        // F01-R05 + SAVE-04: a substantive goal change changes what the summary
        // is about, so the marker is written in the SAME put as the new goal.
        const reason: RecheckReason = {
          code: 'goal-changed',
          detail: `task '${taskId}' goal changed by update '${requestId}': 需要核对相关概况与结论适用范围`,
          updateId: requestId,
          draftId: null,
          at,
        };
        next = markRecheck(next, 'taskSummary', reason, at);
      }
      return {
        next,
        decision: fieldsDecision({
          kind: 'saved',
          actual,
          fieldsRevision: nextTask.fieldsRevision,
          extra: { changed, updatedAt: at, goalChanged: storedGoalChanged },
        }),
      };
    };

    const preflight = decide(head);
    let decision = preflight.decision;
    if (decision.kind === 'saved') {
      try {
        // Authoritative pass: the whole decision runs again at the write slot.
        await port.update<ScopeStateRecord>(SCOPE, key, (raw) => {
          const authoritative = decide(raw);
          decision = authoritative.decision;
          return authoritative.next;
        });
      } catch (error) {
        const { draft, persisted } = await persistFieldDraft(taskId, requestId, nextTitle, nextGoal, at);
        return {
          status: 'failed',
          code: 'write-failed',
          message: error instanceof Error ? error.message : String(error),
          task: readTask({ taskId }),
          keptInput,
          draft,
          draftPersisted: persisted,
        };
      }
    }

    const latest = readScope('task', taskId);
    const view = latest === undefined || latest.task === null ? taskViewOf(head, readDrafts()) : taskViewOf(latest, readDrafts());
    const hadDraft = head.task !== null && head.task.pendingFieldDraft !== null;
    switch (decision.kind) {
      case 'saved':
        return {
          status: 'saved',
          task: view,
          changed: decision.changed,
          fieldsRevision: view.fieldsRevision,
          updatedAt: view.updatedAt,
          draftDiscarded: hadDraft,
          recheckMarked: decision.goalChanged,
        };
      case 'no-change':
        return { status: 'no-change', task: view, cosmeticOnly: decision.cosmeticOnly };
      case 'already-applied':
        return {
          status: 'already-applied',
          task: view,
          appliedFieldsRevision: decision.fieldsRevision,
          appliedAt: decision.updatedAt,
        };
      case 'baseline-changed': {
        const { draft, persisted } = await persistFieldDraft(taskId, requestId, nextTitle, nextGoal, at);
        return {
          status: 'baseline-changed',
          task: readTask({ taskId }) ?? view,
          expected,
          actual: decision.actual,
          draft,
          draftPersisted: persisted,
        };
      }
      default:
        return { status: 'rejected', code: decision.code, message: decision.message, keptInput };
    }
  };

  const readTask = (input: { readonly taskId: string }): TaskView | null => {
    const head = readScope('task', input.taskId);
    if (head === undefined || head.task === null) return null;
    return taskViewOf(head, readDrafts());
  };

  return {
    async registerProject(input): Promise<ProjectOutcome> {
      const projectId = typeof input.projectId === 'string' ? input.projectId.trim() : '';
      if (projectId.length === 0) {
        return { status: 'rejected', code: 'invalid-input', message: '项目身份是 workspace.id，不能为空' };
      }
      const title = typeof input.title === 'string' ? input.title.trim() : '';
      const path = typeof input.path === 'string' ? input.path.trim() : '';
      if (path.length === 0) {
        return { status: 'rejected', code: 'invalid-input', message: '工作范围 = workspace.path，不能为空' };
      }
      const at = input.at ?? now();
      const key = PROJECT_KEY(projectId);
      const existing = readScope('project', projectId);
      if (existing !== undefined && existing.project !== null) {
        if (existing.project.title === title && existing.project.path === path) {
          return { status: 'unchanged', project: toProjectView(existing, taskViewsOf(projectId, readDrafts()).views) };
        }
      }
      let decision: 'registered' | 'refreshed' | 'unchanged' =
        existing !== undefined && existing.project !== null ? 'refreshed' : 'registered';
      const apply = (raw: ScopeStateRecord): ScopeStateRecord => {
        const current = normalizeScope(raw);
        if (current === undefined) return raw;
        const previous = current.project;
        const titleChanged = previous === null ? title.length > 0 : title !== previous.title;
        const pathChanged = previous === null ? true : path !== previous.path;
        if (previous !== null && !titleChanged && !pathChanged) {
          decision = 'unchanged';
          return current;
        }
        const base: ProjectFields =
          previous ?? {
            title,
            path,
            workScope: { availability: 'unknown', detail: null, observedAt: null },
            position: { selectedTaskId: null, view: null, updatedAt: null },
            boardOrder: EMPTY_BOARD_ORDER,
            orderRevision: 0,
            createdAt: at,
            updatedAt: at,
          };
        const project: ProjectFields = { ...base, title: title.length > 0 ? title : base.title, path, updatedAt: at };
        decision = previous === null ? 'registered' : 'refreshed';
        return appendActivity({ ...current, project, updatedAt: at }, {
          code: previous === null ? 'project-registered' : 'project-updated',
          summary: previous === null ? `项目已登记：${summarize(title)}` : `项目信息已更新：${summarize(title)}`,
          details: { projectId, path, title },
          at,
        });
      };
      if (existing === undefined) {
        await port.put<ScopeStateRecord>(SCOPE, key, apply(emptyScope('project', projectId, at)));
      } else {
        await port.update<ScopeStateRecord>(SCOPE, key, apply);
      }
      const view = projectViewOf(projectId);
      if (view === null) {
        return { status: 'rejected', code: 'unknown-project', message: `项目 '${projectId}' 登记后读取失败` };
      }
      return { status: decision, project: view };
    },

    readProject(input): ProjectView | null {
      return projectViewOf(input.projectId, input.workScope);
    },

    listProjects(): readonly ProjectView[] {
      const drafts = readDrafts();
      return projectHeads()
        .map((head) => toProjectView(head, taskViewsOf(head.scope.id, drafts).views))
        .sort((left, right) => {
          if (left.registeredAt !== right.registeredAt) return left.registeredAt < right.registeredAt ? -1 : 1;
          return left.projectId < right.projectId ? -1 : left.projectId > right.projectId ? 1 : 0;
        });
    },

    async observeWorkScope(input): Promise<ProjectOutcome> {
      const projectId = typeof input.projectId === 'string' ? input.projectId.trim() : '';
      if (!isWorkScopeAvailability(input.availability)) {
        return { status: 'rejected', code: 'invalid-input', message: `未知工作范围状态 '${String(input.availability)}'` };
      }
      const at = input.at ?? now();
      const detail = input.detail ?? null;
      const head = readScope('project', projectId);
      if (head === undefined || head.project === null) {
        return { status: 'rejected', code: 'unknown-project', message: `项目 '${projectId}' 尚未登记` };
      }
      if (head.project.workScope.availability === input.availability && head.project.workScope.detail === detail) {
        return { status: 'unchanged', project: toProjectView(head, taskViewsOf(projectId, readDrafts()).views) };
      }
      let decision: 'recorded' | 'unchanged' = 'recorded';
      await port.update<ScopeStateRecord>(SCOPE, PROJECT_KEY(projectId), (raw) => {
        const current = normalizeScope(raw);
        if (current === undefined || current.project === null) {
          decision = 'unchanged';
          return raw;
        }
        const project = current.project;
        if (project.workScope.availability === input.availability && project.workScope.detail === detail) {
          decision = 'unchanged';
          return current;
        }
        // The path is deliberately NOT touched: an unavailable directory must
        // never rewrite the recorded work scope (ADR-003 4.1 item 3).
        const nextProject: ProjectFields = {
          ...project,
          workScope: { availability: input.availability, detail, observedAt: at },
          updatedAt: at,
        };
        return appendActivity({ ...current, project: nextProject, updatedAt: at }, {
          code: 'work-scope-changed',
          summary:
            input.availability === 'missing-dir' ? '工作范围当前不可用（管理数据保留）' : `工作范围状态：${input.availability}`,
          details: { projectId, path: project.path, availability: input.availability, previous: project.workScope.availability },
          at,
        });
      });
      const view = projectViewOf(projectId);
      if (view === null) {
        return { status: 'rejected', code: 'unknown-project', message: `项目 '${projectId}' 读取失败` };
      }
      return { status: decision, project: view };
    },

    canUseWorkScope(input) {
      const head = readScope('project', input.projectId);
      if (head === undefined || head.project === null) {
        return {
          projectId: input.projectId,
          path: null,
          availability: 'unknown' as WorkScopeAvailability,
          allowed: false,
          reason: '项目未登记：不猜测工作范围（REC-05）',
        };
      }
      const view = workScopeView(
        head.project.path,
        head.project.workScope.availability,
        head.project.workScope.detail,
        head.project.workScope.observedAt,
      );
      return {
        projectId: head.scope.id,
        path: view.path,
        availability: view.availability,
        allowed: view.allowed,
        reason: view.reason,
      };
    },

    async saveBoardPosition(input): Promise<ProjectOutcome> {
      const projectId = typeof input.projectId === 'string' ? input.projectId.trim() : '';
      const at = input.at ?? now();
      const head = readScope('project', projectId);
      if (head === undefined || head.project === null) {
        return { status: 'rejected', code: 'unknown-project', message: `项目 '${projectId}' 尚未登记` };
      }
      const currentPosition = head.project.position;
      const selectedTaskId = input.selectedTaskId === undefined ? currentPosition.selectedTaskId : input.selectedTaskId;
      const view = input.view === undefined ? currentPosition.view : input.view;
      if (selectedTaskId !== null) {
        // A position may only point at a task of its own project (F01-R01).
        const taskHead = readScope('task', selectedTaskId);
        if (taskHead === undefined || taskHead.task === null || taskHead.task.projectId !== projectId) {
          return {
            status: 'rejected',
            code: 'invalid-input',
            message: `任务 '${selectedTaskId}' 不属于项目 '${projectId}'：位置必须留在本项目内`,
          };
        }
      }
      if (selectedTaskId === currentPosition.selectedTaskId && view === currentPosition.view) {
        return { status: 'unchanged', project: toProjectView(head, taskViewsOf(projectId, readDrafts()).views) };
      }
      await port.update<ScopeStateRecord>(SCOPE, PROJECT_KEY(projectId), (raw) => {
        const current = normalizeScope(raw);
        if (current === undefined || current.project === null) return raw;
        const project = current.project;
        const nextProject: ProjectFields = { ...project, position: { selectedTaskId, view, updatedAt: at }, updatedAt: at };
        return appendActivity({ ...current, project: nextProject, updatedAt: at }, {
          code: 'board-position-changed',
          summary: '看板位置已保存',
          details: { projectId, selectedTaskId: selectedTaskId ?? '', view: view ?? '' },
          at,
        });
      });
      const updated = projectViewOf(projectId);
      if (updated === null) {
        return { status: 'rejected', code: 'unknown-project', message: `项目 '${projectId}' 读取失败` };
      }
      return { status: 'saved', project: updated };
    },

    createTask,

    lookupCreate,

    readBoard(input): BoardReadResult {
      const projectId = typeof input.projectId === 'string' ? input.projectId : '';
      try {
        const head = readScope('project', projectId);
        const projectFields = head?.project ?? null;
        if (head === undefined || projectFields === null) {
          return {
            status: 'unknown-project',
            projectId,
            tasks: [],
            message: `项目 '${projectId}' 未登记或只有内容、没有项目字段：这不是一个空项目`,
          };
        }
        const drafts = readDrafts();
        // F02: columns are grouped by the EFFECTIVE layout (project preference
        // list + per-task fallback), so a manual order is what the board sees.
        const state = boardStateOf(projectId, drafts);
        const all = state.views.slice().sort(compareTasks);
        const visible = all.filter((task) => !task.archived);
        const visibleById = new Map(visible.map((task) => [task.taskId, task]));
        const columns: BoardColumnView[] = BOARD_COLUMNS.map((column) => {
          const tasks = state.layout.ordered[column.status]
            .map((taskHead) => visibleById.get(taskHead.scope.id))
            .filter((task): task is TaskView => task !== undefined);
          return {
            status: column.status,
            label: column.label,
            collapsedByDefault: column.collapsedByDefault,
            count: tasks.length,
            tasks,
          };
        });
        const project = toProjectView(head, all, input.workScope);
        const recheck = computeRecheck('project', projectId, head, drafts, head.updatedAt);
        const boardToken = fingerprint({
          projectId,
          projectUpdatedAt: projectFields.updatedAt,
          orderRevision: projectFields.orderRevision,
          workScope: [project.workScope.availability, project.workScope.observedAt],
          position: [project.position.selectedTaskId, project.position.view, project.position.updatedAt],
          tasks: visible.map((task) => [
            task.taskId,
            task.fieldsRevision,
            task.statusRevision,
            task.goalRevision,
            task.status,
            task.order,
            task.updatedAt,
            task.archived,
          ]),
          recheck: [recheck.projectOverview.pending, recheck.projectOverview.markedAt],
        });
        return { status: 'ok', project, tasks: visible, columns, recheck, boardToken };
      } catch (error) {
        // A failing read is reported as such: never an empty board (F01 §3, REC-05).
        return {
          status: 'failed',
          projectId,
          code: 'read-failed',
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },

    readTask,

    updateTaskFields,

    async saveFieldDraft(input): Promise<FieldDraftOutcome> {
      const taskId = typeof input.taskId === 'string' ? input.taskId.trim() : '';
      const requestId = typeof input.requestId === 'string' ? input.requestId.trim() : '';
      if (taskId.length === 0 || requestId.length === 0) {
        return { status: 'rejected', code: 'invalid-input', message: 'taskId 与 requestId 均不能为空' };
      }
      const at = input.at ?? now();
      const head = readScope('task', taskId);
      if (head === undefined || head.task === null) {
        return { status: 'rejected', code: 'unknown-task', message: `任务 '${taskId}' 不存在` };
      }
      const previous = head.task.pendingFieldDraft;
      const draft: PendingFieldDraft = {
        requestId,
        title: input.title === undefined ? previous?.title ?? head.task.title : input.title,
        goal: input.goal === undefined ? previous?.goal ?? head.task.goal : normalizeGoal(input.goal),
        createdAt: previous !== null && previous.requestId === requestId ? previous.createdAt : at,
        updatedAt: at,
      };
      if (previous !== null && previous.requestId === draft.requestId && previous.title === draft.title && previous.goal === draft.goal) {
        // Typing that changes nothing performs no write (F01-R05).
        return { status: 'saved', draft: previous };
      }
      await port.update<ScopeStateRecord>(SCOPE, TASK_KEY(taskId), (raw) => {
        const current = normalizeScope(raw);
        if (current === undefined || current.task === null) return raw;
        // Only the draft slot changes: the official fields, their revisions and
        // the official update time are untouched.
        return { ...current, task: { ...current.task, pendingFieldDraft: draft } };
      });
      return { status: 'saved', draft };
    },

    readFieldDraft(input) {
      const head = readScope('task', input.taskId);
      return head?.task?.pendingFieldDraft ?? null;
    },

    async discardFieldDraft(input): Promise<boolean> {
      const head = readScope('task', input.taskId);
      if (head === undefined || head.task === null || head.task.pendingFieldDraft === null) return false;
      await port.update<ScopeStateRecord>(SCOPE, TASK_KEY(input.taskId), (raw) => {
        const current = normalizeScope(raw);
        if (current === undefined || current.task === null) return raw;
        return { ...current, task: { ...current.task, pendingFieldDraft: null } };
      });
      return true;
    },

    readActivity(input): readonly ActivityEntry[] {
      const head = readScope(input.scopeKind, input.scopeId);
      if (head === undefined) return [];
      const newestFirst = [...head.activity].reverse();
      if (input.limit === undefined) return newestFirst;
      return newestFirst.slice(0, Math.max(0, input.limit));
    },

    async setTaskStatus(input): Promise<StatusOutcome> {
      const taskId = typeof input.taskId === 'string' ? input.taskId.trim() : '';
      const requestId = typeof input.requestId === 'string' ? input.requestId.trim() : '';
      const keptInput: KeptStatusInput = {
        toStatus: input.toStatus,
        blockedReason: input.blockedReason == null ? null : input.blockedReason,
      };
      if (taskId.length === 0 || requestId.length === 0) {
        return { status: 'rejected', code: 'invalid-input', message: 'taskId 与 requestId 均不能为空', keptInput };
      }
      if (!isTaskStatus(input.toStatus)) {
        return {
          status: 'rejected',
          code: 'invalid-status',
          message: `未知状态 '${String(input.toStatus)}'：状态只有五种，归档不是状态（OBJ-02）`,
          keptInput,
        };
      }
      const at = input.at ?? now();
      const head = readScope('task', taskId);
      if (head === undefined || head.task === null) {
        return { status: 'rejected', code: 'unknown-task', message: `任务 '${taskId}' 不存在`, keptInput };
      }
      const task = head.task;
      const projectId = task.projectId;

      if (task.recentStatusUpdateIds.includes(requestId)) {
        const view = taskViewOf(head, readDrafts());
        return { status: 'already-applied', task: view, appliedStatusRevision: task.statusRevision, appliedAt: view.updatedAt };
      }

      const target = input.toStatus;
      const requestedReason = input.blockedReason == null ? null : input.blockedReason.trim();
      if (target === 'blocked') {
        const effective = requestedReason ?? task.blockedReason ?? '';
        if (effective.trim().length === 0) {
          // F02-R02: 原因无效不改变正式状态；取消输入保持原列原状态（这里什么都没写）。
          return {
            status: 'rejected',
            code: 'blocked-reason-required',
            message: '进入已阻塞必须填写有效原因；取消不会改变正式状态与原列（F02-R02）',
            keptInput,
          };
        }
      }

      const drafts = readDrafts();
      const state = boardStateOf(projectId, drafts);
      if (state.project === null) {
        return { status: 'rejected', code: 'unknown-project', message: `项目 '${projectId}' 尚未登记`, keptInput };
      }
      const currentIndex = state.layout.indexOf.get(taskId) ?? 0;
      const nextReason = target === 'blocked' ? requestedReason ?? task.blockedReason ?? '' : null;
      const statusChanged = target !== task.status;
      const reasonChanged = target === 'blocked' && nextReason !== (task.blockedReason ?? '');
      const requestedIndex = input.toIndex === undefined ? null : clampIndex(input.toIndex, state.layout.ordered[target].length);
      if (!statusChanged && !reasonChanged && (requestedIndex === null || requestedIndex === currentIndex)) {
        return { status: 'no-change', task: taskViewOf(head, drafts) };
      }
      const actual: StatusBaseline = { statusRevision: task.statusRevision };
      if (task.statusRevision !== input.expected.statusRevision) {
        return { status: 'baseline-changed', task: taskViewOf(head, drafts), expected: input.expected, actual };
      }

      const currentSnapshot: StatusSnapshot = { status: task.status, blockedReason: task.blockedReason };
      const nextSnapshot: StatusSnapshot = { status: target, blockedReason: nextReason };
      const reopened = (task.status === 'done' || task.status === 'cancelled') && target !== 'done' && target !== 'cancelled';
      const blockedCleared = task.status === 'blocked' && target !== 'blocked';
      const enteredBlocked = target === 'blocked' && task.status !== 'blocked';
      const activity = enteredBlocked
        ? {
            code: 'task-blocked' as const,
            summary: `已阻塞：${summarize(nextReason ?? '')}`,
            details: { taskId, from: task.status, to: target, reason: nextReason ?? '', reopened: String(reopened), requestId },
          }
        : blockedCleared
          ? {
              code: 'task-unblocked' as const,
              summary: `阻塞已解除：${statusLabelOf(target)}`,
              details: { taskId, from: task.status, to: target, previousReason: task.blockedReason ?? '', requestId },
            }
          : reopened
            ? {
                code: 'task-reopened' as const,
                summary: `任务已重新打开：${statusLabelOf(target)}`,
                details: { taskId, from: task.status, to: target, requestId },
              }
            : {
                code: 'task-status-changed' as const,
                summary: `状态已更新：${statusLabelOf(task.status)} → ${statusLabelOf(target)}`,
                details: { taskId, from: task.status, to: target, requestId },
              };

      const decide = (raw: ScopeStateRecord): { readonly next: ScopeStateRecord; readonly kind: StatusDecisionKind } => {
        const scope = normalizeScope(raw);
        const current = scope?.task ?? null;
        if (scope === undefined || current === null) return { next: raw, kind: 'unknown-task' };
        if (current.recentStatusUpdateIds.includes(requestId)) return { next: scope, kind: 'already-applied' };
        if (current.statusRevision !== input.expected.statusRevision) return { next: scope, kind: 'baseline-changed' };
        const nextTask: TaskFields = {
          ...current,
          status: target,
          blockedReason: nextReason,
          statusRevision: current.statusRevision + 1,
          lastStatusUpdateId: requestId,
          recentStatusUpdateIds: [requestId, ...current.recentStatusUpdateIds].slice(0, 16),
          lastStatusChange: { updateId: requestId, at, kind: 'transition', from: currentSnapshot, to: nextSnapshot },
          updatedAt: at,
        };
        const withTask: ScopeStateRecord = { ...scope, task: nextTask, updatedAt: at };
        return { next: appendActivity(withTask, { ...activity, at }), kind: 'saved' };
      };

      const preflight = decide(head);
      let kind = preflight.kind;
      if (kind === 'saved') {
        try {
          // Order first, status second: the preference list is a harmless hint if
          // the second write fails, whereas a status write followed by a failed
          // order write would leave the card in the wrong place (REC-01).
          if (requestedIndex !== null) {
            const targetIds = state.layout.ordered[target]
              .map((entry) => entry.scope.id)
              .filter((id) => id !== taskId);
            targetIds.splice(clampIndex(input.toIndex ?? 0, targetIds.length), 0, taskId);
            await writeColumnPreference(projectId, target, targetIds, at, requestId, taskId);
          }
          await port.update<ScopeStateRecord>(SCOPE, TASK_KEY(taskId), (raw) => {
            const authoritative = decide(raw);
            kind = authoritative.kind;
            return authoritative.next;
          });
        } catch (error) {
          // Nothing半生效: the official status/order are exactly what they were.
          return {
            status: 'failed',
            code: 'write-failed',
            message: error instanceof Error ? error.message : String(error),
            task: readTask({ taskId }),
            keptInput,
          };
        }
      }

      const refreshed = readScope('task', taskId) ?? head;
      const view = taskViewOf(refreshed, readDrafts());
      if (kind === 'already-applied') {
        return { status: 'already-applied', task: view, appliedStatusRevision: view.statusRevision, appliedAt: view.updatedAt };
      }
      if (kind === 'baseline-changed') {
        return { status: 'baseline-changed', task: view, expected: input.expected, actual: { statusRevision: view.statusRevision } };
      }
      if (kind === 'unknown-task') {
        return { status: 'rejected', code: 'unknown-task', message: `任务 '${taskId}' 不存在`, keptInput };
      }
      const after = boardStateOf(projectId, readDrafts());
      const columnIds = after.layout.ordered[target].map((entry) => entry.scope.id);
      const change: StatusChangeView = {
        status: target,
        previousStatus: currentSnapshot.status,
        blockedReason: nextReason,
        blockedCleared,
        reopened,
        order: after.layout.indexOf.get(taskId) ?? 0,
        requestedIndex,
      };
      return { status: 'saved', task: after.byId.get(taskId) ?? view, change, statusRevision: view.statusRevision, columnIds };
    },

    async reorderTask(input): Promise<ReorderOutcome> {
      const taskId = typeof input.taskId === 'string' ? input.taskId.trim() : '';
      const requestId = typeof input.requestId === 'string' ? input.requestId.trim() : '';
      if (taskId.length === 0 || requestId.length === 0) {
        return { status: 'rejected', code: 'invalid-input', message: 'taskId、requestId 与 toIndex 均不能为空' };
      }
      if (!Number.isFinite(input.toIndex)) {
        return { status: 'rejected', code: 'invalid-input', message: 'toIndex 必须是有限数字' };
      }
      const at = input.at ?? now();
      const head = readScope('task', taskId);
      if (head === undefined || head.task === null) {
        return { status: 'rejected', code: 'unknown-task', message: `任务 '${taskId}' 不存在` };
      }
      const task = head.task;
      const drafts = readDrafts();
      const state = boardStateOf(task.projectId, drafts);
      if (state.project === null) {
        return { status: 'rejected', code: 'unknown-project', message: `项目 '${task.projectId}' 尚未登记` };
      }
      const ids = state.layout.ordered[task.status].map((entry) => entry.scope.id);
      const fromIndex = ids.indexOf(taskId);
      const toIndex = clampIndex(input.toIndex, Math.max(0, ids.length - 1));
      if (task.statusRevision !== input.expected.statusRevision) {
        return {
          status: 'baseline-changed',
          task: taskViewOf(head, drafts),
          expected: input.expected,
          actual: { statusRevision: task.statusRevision },
        };
      }
      if (fromIndex === toIndex) {
        return { status: 'no-change', task: state.byId.get(taskId) ?? taskViewOf(head, drafts), columnIds: ids };
      }
      const nextIds = [...ids];
      nextIds.splice(fromIndex, 1);
      nextIds.splice(toIndex, 0, taskId);
      try {
        // ONE write of the project head: the column order can never half-apply.
        await writeColumnPreference(task.projectId, task.status, nextIds, at, requestId, taskId);
      } catch (error) {
        return {
          status: 'failed',
          code: 'write-failed',
          message: error instanceof Error ? error.message : String(error),
          task: readTask({ taskId }),
        };
      }
      const after = boardStateOf(task.projectId, readDrafts());
      const columnIds = after.layout.ordered[task.status].map((entry) => entry.scope.id);
      return {
        status: 'saved',
        task: after.byId.get(taskId) ?? taskViewOf(head, readDrafts()),
        column: task.status,
        fromIndex,
        toIndex,
        columnIds,
        orderRevision: after.project?.orderRevision ?? 0,
      };
    },

    async undoStatusChange(input): Promise<UndoOutcome> {
      const taskId = typeof input.taskId === 'string' ? input.taskId.trim() : '';
      const undoId = typeof input.undoId === 'string' ? input.undoId.trim() : '';
      if (taskId.length === 0 || undoId.length === 0) {
        return { status: 'rejected', code: 'invalid-input', message: 'taskId 与 undoId 均不能为空' };
      }
      const at = input.at ?? now();
      const head = readScope('task', taskId);
      if (head === undefined || head.task === null) {
        return { status: 'rejected', code: 'unknown-task', message: `任务 '${taskId}' 不存在` };
      }
      const task = head.task;
      const drafts = readDrafts();
      const current: StatusSnapshot = { status: task.status, blockedReason: task.blockedReason };
      const refuse = (code: UndoRefusalCode, message: string): UndoOutcome => ({
        status: 'cannot-undo',
        code,
        message,
        task: taskViewOf(head, drafts),
        current,
        currentStatusRevision: task.statusRevision,
        currentAppliedUpdateId: task.lastStatusChange?.updateId ?? null,
      });

      if (task.recentStatusUpdateIds.includes(undoId)) {
        return refuse('superseded', '该撤销已经生效；当前值如下，不使用旧结果覆盖新事实（REC-04）');
      }
      const last = task.lastStatusChange;
      if (last === null) return refuse('nothing-to-undo', '当前没有可撤销的状态流转');
      if (last.kind !== 'transition') {
        return refuse('superseded', '最近一次状态变化是一次撤销本身，不能重复撤销');
      }
      if (last.updateId !== input.expected.appliedUpdateId) {
        return refuse(
          'superseded',
          `要撤销的操作 '${input.expected.appliedUpdateId}' 之后已有新的状态修改 '${last.updateId}'：不覆盖后续结果`,
        );
      }
      if (task.statusRevision !== input.expected.statusRevision) {
        return refuse(
          'superseded',
          `状态版本已从 ${input.expected.statusRevision} 变为 ${task.statusRevision}：撤销基线已过期`,
        );
      }

      const restored: StatusSnapshot = { status: last.from.status, blockedReason: last.from.blockedReason };
      const previousStatus = task.status;
      // The decision is recorded through a property: the authoritative transform
      // runs inside `port.update`, so control-flow narrowing cannot see it.
      const outcome: { kind: 'undone' | 'superseded' | 'missing' } = { kind: 'missing' };
      try {
        await port.update<ScopeStateRecord>(SCOPE, TASK_KEY(taskId), (raw) => {
          const scope = normalizeScope(raw);
          const current2 = scope?.task ?? null;
          if (scope === undefined || current2 === null) return raw;
          const innerLast = current2.lastStatusChange;
          if (
            innerLast === null ||
            innerLast.kind !== 'transition' ||
            innerLast.updateId !== input.expected.appliedUpdateId ||
            current2.statusRevision !== input.expected.statusRevision
          ) {
            outcome.kind = 'superseded';
            return scope;
          }
          const nextTask: TaskFields = {
            ...current2,
            status: innerLast.from.status,
            blockedReason: innerLast.from.blockedReason,
            statusRevision: current2.statusRevision + 1,
            lastStatusUpdateId: undoId,
            recentStatusUpdateIds: [undoId, ...current2.recentStatusUpdateIds].slice(0, 16),
            lastStatusChange: {
              updateId: undoId,
              at,
              kind: 'undo',
              from: { status: current2.status, blockedReason: current2.blockedReason },
              to: { status: innerLast.from.status, blockedReason: innerLast.from.blockedReason },
            },
            updatedAt: at,
          };
          const withTask: ScopeStateRecord = { ...scope, task: nextTask, updatedAt: at };
          outcome.kind = 'undone';
          return appendActivity(withTask, {
            code: 'task-undone',
            summary: `已撤销状态流转：回到 ${statusLabelOf(innerLast.from.status)}`,
            details: {
              taskId,
              undoneUpdateId: input.expected.appliedUpdateId,
              from: current2.status,
              to: innerLast.from.status,
              requestId: undoId,
            },
            at,
          });
        });
      } catch (error) {
        return {
          status: 'failed',
          code: 'write-failed',
          message: error instanceof Error ? error.message : String(error),
          task: readTask({ taskId }),
        };
      }
      if (outcome.kind === 'superseded') return refuse('superseded', '撤销写入时基线已变化：不覆盖后续结果');
      if (outcome.kind === 'missing') return { status: 'rejected', code: 'unknown-task', message: `任务 '${taskId}' 不存在` };
      const refreshed = readScope('task', taskId) ?? head;
      const view = taskViewOf(refreshed, readDrafts());
      return { status: 'undone', task: view, restored, previousStatus, statusRevision: view.statusRevision };
    },
  };
}
