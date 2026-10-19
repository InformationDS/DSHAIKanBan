/**
 * The task/project field model: statuses, labels, identity derivation and the
 * pure helpers the planning API and the board share.
 *
 * F01 owns 标题/目标 (user fields, independent of records and summaries);
 * F02 owns 状态/列内顺序 (OBJ-02). Both live in this one module so that the
 * board never grows a second status vocabulary: the ids here are the only ones
 * that reach storage, and the labels are the display fallback the UI may
 * replace with its own localization.
 *
 * @module @aikanban/core/task-model
 */

import { collapseWhitespace, encodeKey, fingerprint } from './keys.ts';
import type { ObjectContent, TaskStatus, TaskView, WorkScopeAvailability } from './types.ts';

/**
 * OBJ-02 task statuses. **Archive is deliberately absent**: it is a visibility
 * attribute (`TaskFields.archived`), not a sixth status, so it can never be
 * dragged into a column or counted as progress.
 */
export const TASK_STATUSES: readonly TaskStatus[] = ['todo', 'doing', 'blocked', 'done', 'cancelled'];

/** Membership test for untrusted input (ports, tools, stored records). */
export const TASK_STATUS_SET: ReadonlySet<string> = new Set<string>(TASK_STATUSES);

/** Display labels; a UI that localizes replaces these, the ids stay stable. */
export const TASK_STATUS_LABELS: Readonly<Record<TaskStatus, string>> = {
  todo: '未开始',
  doing: '进行中',
  blocked: '已阻塞',
  done: '已完成',
  cancelled: '已取消',
};

/** Board columns in render order (F02-R01: 已取消 collapsed by default, 已完成 stays visible). */
export const BOARD_COLUMNS: readonly {
  readonly status: TaskStatus;
  readonly label: string;
  readonly collapsedByDefault: boolean;
}[] = [
  { status: 'todo', label: TASK_STATUS_LABELS.todo, collapsedByDefault: false },
  { status: 'doing', label: TASK_STATUS_LABELS.doing, collapsedByDefault: false },
  { status: 'blocked', label: TASK_STATUS_LABELS.blocked, collapsedByDefault: false },
  { status: 'done', label: TASK_STATUS_LABELS.done, collapsedByDefault: false },
  { status: 'cancelled', label: TASK_STATUS_LABELS.cancelled, collapsedByDefault: true },
];

/** Whether an untrusted value is one of the five statuses. */
export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && TASK_STATUS_SET.has(value);
}

/** Position of a status in the canonical order; `-1` for unknown values. */
export function statusRank(status: TaskStatus): number {
  return TASK_STATUSES.indexOf(status);
}

/** Done and cancelled are the two states that carry 重新打开 (F02-R03). */
export function isTerminalStatus(status: TaskStatus): boolean {
  return status === 'done' || status === 'cancelled';
}

/** The label to render for a status (falls back to the raw id for unknown input). */
export function statusLabelOf(status: TaskStatus): string {
  return TASK_STATUS_LABELS[status] ?? status;
}

/**
 * ADR-003 4.1: the work scope is observed, never guessed. `unknown` means the
 * host has not reported an observation yet; it must not be read as "no scope".
 */
export const WORK_SCOPE_AVAILABILITIES: readonly WorkScopeAvailability[] = ['ok', 'missing-dir', 'unknown'];

/** Membership test for untrusted work-scope observations. */
export const WORK_SCOPE_AVAILABILITY_SET: ReadonlySet<string> = new Set<string>(WORK_SCOPE_AVAILABILITIES);

/** Whether an untrusted value is a work-scope availability. */
export function isWorkScopeAvailability(value: unknown): value is WorkScopeAvailability {
  return typeof value === 'string' && WORK_SCOPE_AVAILABILITY_SET.has(value);
}

/** F01-R02: the stored title is the trimmed input; only whitespace is invalid. */
export function normalizeTaskTitle(raw: string): string {
  return raw.trim();
}

/** F01-R02: a title made only of whitespace is invalid. */
export function isValidTaskTitle(raw: string): boolean {
  return typeof raw === 'string' && raw.trim().length > 0;
}

/** F01-R02: the goal is optional; an empty goal is stored as `''`, never null-padded text. */
export function normalizeGoal(raw: string | null | undefined): string {
  return typeof raw === 'string' ? raw.trim() : '';
}

/** SAVE-04: a goal that differs only in whitespace is 纯排版, not a substantive change. */
export function isCosmeticGoalChange(left: string, right: string): boolean {
  return left !== right && collapseWhitespace(left) === collapseWhitespace(right);
}

/**
 * Deterministic task id for one creation request.
 *
 * Identity is `(project, requestId)`, never the title (F01-R04: 不以同名任务存在
 * 作为自动合并依据). The id is derived, so the same request can only ever reach
 * the same record: retrying cannot create a second task. It is a digest for
 * compactness, but identity is never *trusted* to it -- the stored task carries
 * `projectId` and `requestId`, and `planning.ts` verifies them, so even a
 * (astronomically unlikely) digest collision is detected instead of merging two
 * different creations.
 */
export function taskIdOf(input: { readonly projectId: string; readonly requestId: string }): string {
  const first = fingerprint({ v: 1, projectId: input.projectId, requestId: input.requestId });
  const second = fingerprint({ v: 2, projectId: input.projectId, requestId: input.requestId });
  return `t${first}${second}`;
}

/** Storage key part for a task id; exposed so tests and tools can locate a head record. */
export function encodeTaskId(taskId: string): string {
  return encodeKey(taskId);
}

/**
 * One-line overall progress from a task summary body (F02-R04 / OBJ-08): the
 * first non-empty line of the first non-empty partition, whitespace collapsed.
 * `null` means "no official summary to show", and the board then shows the task
 * goal -- it must never substitute a draft or the last record.
 */
export function progressLineOf(content: ObjectContent, maxLength = 160): string | null {
  for (const section of content.sections) {
    for (const line of section.body.split(/\r?\n/u)) {
      const text = line.replace(/\s+/gu, ' ').trim();
      if (text.length > 0) return summarize(text, maxLength);
    }
  }
  return null;
}

/** Shorten one piece of text for an activity summary or a card line. */
export function summarize(text: string, maxLength = 80): string {
  const collapsed = text.replace(/\s+/gu, ' ').trim();
  if (collapsed.length <= maxLength) return collapsed;
  return `${collapsed.slice(0, Math.max(0, maxLength - 1))}…`;
}

/**
 * Column-internal order (F02-R05): manual position first, then creation time as
 * the stable tie-break so a never-reordered board is deterministic.
 */
export function compareTasks(left: TaskView, right: TaskView): number {
  if (left.order !== right.order) return left.order - right.order;
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1;
  return left.taskId < right.taskId ? -1 : left.taskId > right.taskId ? 1 : 0;
}
