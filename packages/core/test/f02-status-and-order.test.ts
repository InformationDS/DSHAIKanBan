/**
 * F02-R01…R04 — the status machine, blocked reasons, reopen, column order and
 * undo, including the two failure modes the PRD names explicitly:
 * 「保存失败不半生效」 and 「撤销不得覆盖后续新修改」.
 *
 * Ordering and undo are decided by verifiable versions/identities
 * (`statusRevision`, `updateId`), never by timestamps. Every refusal is a typed
 * outcome that carries the current value.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { content, createHarness, expectationOf } from './harness.ts';
import type { Harness } from './harness.ts';
import { AIKANBAN_TABLES, isScopeStateRecord, scopeKey } from '../src/domainSpec.ts';
import { PATH_A, PROJECT_A, SAME_TITLE, okBoard, registerProject, taskOf } from './f01Harness.ts';
import type { TaskStatus, TaskView } from '../src/types.ts';

const SCOPE = AIKANBAN_TABLES.scopeState;
const TASK_KEY = (taskId: string): string => scopeKey('task', taskId);
const PROJECT_KEY = scopeKey('project', PROJECT_A);

async function seedTask(harness: Harness, requestId: string, title: string): Promise<TaskView> {
  return taskOf(await harness.core.createTask({ projectId: PROJECT_A, requestId, title }));
}

/** The effective order of one column, straight from the guarded board read. */
function column(harness: Harness, status: TaskStatus): readonly TaskView[] {
  const board = okBoard(harness.core.readBoard({ projectId: PROJECT_A }));
  return board.columns.find((entry) => entry.status === status)?.tasks ?? [];
}

function titles(harness: Harness, status: TaskStatus): readonly string[] {
  return column(harness, status).map((task) => task.title);
}

test('F02-R01/R02/R03: the transition set, blocked reasons, unblocking and reopening', async () => {
  const harness = createHarness();
  await registerProject(harness, PROJECT_A, SAME_TITLE, PATH_A);
  const task = await seedTask(harness, 'req-1', 'Lifecycle');

  const doing = await harness.core.setTaskStatus({
    taskId: task.taskId,
    requestId: 's1',
    toStatus: 'doing',
    expected: { statusRevision: 0 },
  });
  assert.equal(doing.status, 'saved');
  assert.equal(doing.status === 'saved' ? doing.task.status : null, 'doing');
  assert.equal(doing.status === 'saved' ? doing.task.statusLabel : null, '进行中');
  assert.equal(doing.status === 'saved' ? doing.change.previousStatus : null, 'todo');
  assert.equal(doing.status === 'saved' ? doing.task.statusRevision : null, 1);
  assert.deepEqual(doing.status === 'saved' ? doing.columnIds : [], [task.taskId]);

  const blocked = await harness.core.setTaskStatus({
    taskId: task.taskId,
    requestId: 's2',
    toStatus: 'blocked',
    blockedReason: '  等外部接口  ',
    expected: { statusRevision: 1 },
  });
  assert.equal(blocked.status, 'saved');
  assert.equal(blocked.status === 'saved' ? blocked.task.blockedReason : null, '等外部接口', 'the reason is stored trimmed');

  const done = await harness.core.setTaskStatus({
    taskId: task.taskId,
    requestId: 's3',
    toStatus: 'done',
    expected: { statusRevision: 2 },
  });
  assert.equal(done.status, 'saved');
  assert.equal(done.status === 'saved' ? done.task.blockedReason : null, null, '从阻塞恢复后解除当前阻塞提示');
  assert.equal(done.status === 'saved' ? done.change.blockedCleared : null, true);
  assert.equal(done.status === 'saved' ? done.task.archived : null, false, '完成不自动归档 (F02-R03)');

  const cancelled = await harness.core.setTaskStatus({
    taskId: task.taskId,
    requestId: 's4',
    toStatus: 'cancelled',
    expected: { statusRevision: 3 },
  });
  assert.equal(cancelled.status === 'saved' ? cancelled.task.status : null, 'cancelled');
  assert.deepEqual(titles(harness, 'cancelled'), ['Lifecycle'], '已取消默认收起但仍是一列可见数据');

  const reopened = await harness.core.setTaskStatus({
    taskId: task.taskId,
    requestId: 's5',
    toStatus: 'todo',
    expected: { statusRevision: 4 },
  });
  assert.equal(reopened.status, 'saved');
  assert.equal(reopened.status === 'saved' ? reopened.change.reopened : null, true, '已完成/已取消可重新打开');
  assert.equal(reopened.status === 'saved' ? reopened.task.statusRevision : null, 5);

  // 旧原因保留在活动历史（F01-R07/F02-R02），每条重要变化只记一次。
  const activity = harness.core.readActivity({ scopeKind: 'task', scopeId: task.taskId });
  assert.deepEqual(activity.map((entry) => entry.code), [
    'task-reopened',
    'task-status-changed',
    'task-unblocked',
    'task-blocked',
    'task-status-changed',
    'task-created',
  ]);
  assert.equal(activity.find((entry) => entry.code === 'task-unblocked')?.details['previousReason'], '等外部接口', '解除阻塞后旧原因仍可查');
  assert.equal(activity.find((entry) => entry.code === 'task-blocked')?.details['reason'], '等外部接口');
  assert.equal(activity.every((entry) => entry.scopeKind === 'task' && entry.scopeId === task.taskId), true);

  // 五种状态之外一律拒绝：归档不是第六种状态 (OBJ-02)。
  const bogus = await harness.core.setTaskStatus({
    taskId: task.taskId,
    requestId: 's6',
    toStatus: 'archived' as never,
    expected: { statusRevision: 5 },
  });
  assert.equal(bogus.status, 'rejected');
  assert.equal(bogus.status === 'rejected' ? bogus.code : null, 'invalid-status');
  assert.equal(harness.core.readTask({ taskId: task.taskId })?.statusRevision, 5);
});

test('F02-R02: an invalid blocked reason changes nothing; cancelling keeps the original column and state', async () => {
  const harness = createHarness();
  await registerProject(harness, PROJECT_A, SAME_TITLE, PATH_A);
  const task = await seedTask(harness, 'req-1', 'Blocked later');
  await harness.core.setTaskStatus({ taskId: task.taskId, requestId: 's1', toStatus: 'doing', expected: { statusRevision: 0 } });
  harness.resetJournal();

  const missing = await harness.core.setTaskStatus({
    taskId: task.taskId,
    requestId: 's2',
    toStatus: 'blocked',
    expected: { statusRevision: 1 },
  });
  assert.equal(missing.status, 'rejected');
  assert.equal(missing.status === 'rejected' ? missing.code : null, 'blocked-reason-required');
  const blank = await harness.core.setTaskStatus({
    taskId: task.taskId,
    requestId: 's2',
    toStatus: 'blocked',
    blockedReason: '    ',
    expected: { statusRevision: 1 },
  });
  assert.equal(blank.status, 'rejected');
  assert.equal(blank.status === 'rejected' ? blank.keptInput.blockedReason : null, '    ', 'the refused input is echoed back, not silently dropped');
  assert.equal(harness.writes(), 0, '原因无效时不写：不留下已阻塞假象');

  const after = harness.core.readTask({ taskId: task.taskId });
  assert.equal(after?.status, 'doing', '取消输入保持原状态与原列');
  assert.equal(after?.statusRevision, 1);
  assert.equal(after?.blockedReason, null);
  assert.deepEqual(titles(harness, 'doing'), ['Blocked later']);
  assert.deepEqual(harness.core.readActivity({ scopeKind: 'task', scopeId: task.taskId }).map((entry) => entry.code), [
    'task-status-changed',
    'task-created',
  ]);

  const accepted = await harness.core.setTaskStatus({
    taskId: task.taskId,
    requestId: 's3',
    toStatus: 'blocked',
    blockedReason: '等外部接口',
    expected: { statusRevision: 1 },
  });
  assert.equal(accepted.status, 'saved');
  assert.equal(accepted.status === 'saved' ? accepted.task.blockedReason : null, '等外部接口');
  const again = await harness.core.setTaskStatus({
    taskId: task.taskId,
    requestId: 's4',
    toStatus: 'blocked',
    expected: { statusRevision: 2 },
  });
  assert.equal(again.status, 'no-change', 'same status and same reason performs no write');
});

test('F02-R01: only the explicit status entry changes status — confirmations and field edits never do', async () => {
  const harness = createHarness();
  await registerProject(harness, PROJECT_A, SAME_TITLE, PATH_A);
  const task = await seedTask(harness, 'req-1', 'Status is the user decision');
  await harness.core.linkConversation({ taskId: task.taskId, conversationId: 'conv-1' });
  const scope = { scopeKind: 'task' as const, scopeId: task.taskId, recordObjectId: 'conv-1' };

  const confirmed = await harness.core.confirmPaired({
    updateId: 'u1',
    ...scope,
    expected: expectationOf(harness.core, scope),
    origin: 'ai',
    record: { content: content('record v1') },
    summary: { content: content('summary v1') },
  });
  assert.equal(confirmed.status, 'committed');
  await harness.core.saveDraft({
    kind: 'taskRecord',
    scopeKind: 'task',
    scopeId: task.taskId,
    objectId: 'conv-1',
    content: content('draft'),
  });
  await harness.core.updateTaskFields({
    taskId: task.taskId,
    requestId: 'e1',
    expected: { fieldsRevision: 0, statusRevision: 0 },
    title: 'Renamed',
    goal: 'New goal',
  });
  await harness.core.saveBoardPosition({ projectId: PROJECT_A, selectedTaskId: task.taskId, view: 'board' });
  harness.core.readBoard({ projectId: PROJECT_A });

  const after = harness.core.readTask({ taskId: task.taskId });
  assert.equal(after?.status, 'todo', '记录确认/草稿/字段编辑都不改状态 (F02-R01)');
  assert.equal(after?.statusRevision, 0, 'no status revision was consumed');
  assert.equal(after?.order, 0);
  assert.equal(after?.blockedReason, null);
  assert.equal(after?.undoTarget, null, 'nothing to undo because no status operation happened');
  const codes = harness.core.readActivity({ scopeKind: 'task', scopeId: task.taskId }).map((entry) => entry.code);
  assert.equal(codes.some((code) => code.startsWith('task-status') || code === 'task-blocked' || code === 'task-undone'), false);
});

test('REC-01: a failed status or order write leaves the official status AND order untouched', async () => {
  const harness = createHarness();
  await registerProject(harness, PROJECT_A, SAME_TITLE, PATH_A);
  const a = await seedTask(harness, 'r1', 'A');
  await seedTask(harness, 'r2', 'B');
  const c = await seedTask(harness, 'r3', 'C');
  assert.deepEqual(titles(harness, 'todo'), ['A', 'B', 'C']);

  // 1) a move that carries an index: the order hint is written first, the status
  //    write fails, and the card must not move anywhere.
  harness.failNext((event) => event.kind === 'update' && event.table === SCOPE && event.key === TASK_KEY(c.taskId));
  const failedIndexed = await harness.core.setTaskStatus({
    taskId: c.taskId,
    requestId: 's-indexed',
    toStatus: 'done',
    toIndex: 0,
    expected: { statusRevision: 0 },
  });
  assert.equal(failedIndexed.status, 'failed');
  assert.equal(failedIndexed.status === 'failed' ? failedIndexed.code : null, 'write-failed');
  harness.clearFaults();
  const afterFailure = harness.core.readTask({ taskId: c.taskId });
  assert.equal(afterFailure?.status, 'todo', '保存失败保留正式原状态');
  assert.equal(afterFailure?.statusRevision, 0, 'no revision was consumed');
  assert.deepEqual(titles(harness, 'todo'), ['A', 'B', 'C'], '保存失败保留正式原顺序');
  assert.deepEqual(titles(harness, 'done'), [], 'the written order hint cannot move the card');

  // 2) the retry with the SAME requestId lands exactly once.
  const retried = await harness.core.setTaskStatus({
    taskId: c.taskId,
    requestId: 's-indexed',
    toStatus: 'done',
    toIndex: 0,
    expected: { statusRevision: 0 },
  });
  assert.equal(retried.status, 'saved');
  assert.equal(harness.core.readTask({ taskId: c.taskId })?.status, 'done');
  assert.equal(harness.core.readTask({ taskId: c.taskId })?.statusRevision, 1);
  assert.deepEqual(titles(harness, 'done'), ['C']);

  // 3) a failed reorder (project-head write) leaves the column order untouched.
  const before = titles(harness, 'todo');
  harness.resetJournal();
  harness.failNext((event) => event.kind === 'update' && event.table === SCOPE && event.key === PROJECT_KEY);
  const failedOrder = await harness.core.reorderTask({ taskId: a.taskId, requestId: 'o-1', toIndex: 1, expected: { statusRevision: 0 } });
  assert.equal(failedOrder.status, 'failed');
  harness.clearFaults();
  assert.deepEqual(titles(harness, 'todo'), before, '排序失败不半生效');
  assert.equal(harness.port.journal.filter((event) => event.ok).length, 0, 'nothing became durable');
});

test('F02-R04: a manual column order is saved as ONE atomic project write and read back reliably', async () => {
  const harness = createHarness();
  await registerProject(harness, PROJECT_A, SAME_TITLE, PATH_A);
  const a = await seedTask(harness, 'r1', 'A');
  const b = await seedTask(harness, 'r2', 'B');
  const c = await seedTask(harness, 'r3', 'C');
  const d = await seedTask(harness, 'r4', 'D');
  assert.deepEqual(titles(harness, 'todo'), ['A', 'B', 'C', 'D']);

  harness.resetJournal();
  const moved = await harness.core.reorderTask({ taskId: d.taskId, requestId: 'o1', toIndex: 0, expected: { statusRevision: 0 } });
  assert.equal(moved.status, 'saved');
  assert.deepEqual(moved.status === 'saved' ? moved.columnIds : [], [d.taskId, a.taskId, b.taskId, c.taskId]);
  assert.equal(moved.status === 'saved' ? moved.orderRevision : null, 1);
  assert.equal(harness.writes(SCOPE), 1, '列顺序保存 = 一次写');
  assert.equal(
    harness.port.journal.filter((event) => event.ok && event.key === TASK_KEY(d.taskId)).length,
    0,
    'reordering writes no task records',
  );
  assert.deepEqual(titles(harness, 'todo'), ['D', 'A', 'B', 'C'], 'the saved order is what the board reads');
  assert.equal(harness.core.readTask({ taskId: d.taskId })?.order, 0, 'order is the effective column index');

  const sameAgain = await harness.core.reorderTask({ taskId: d.taskId, requestId: 'o2', toIndex: 0, expected: { statusRevision: 0 } });
  assert.equal(sameAgain.status, 'no-change', 'moving a card to where it already is performs no write');
  assert.equal(harness.writes(SCOPE), 1);

  const back = await harness.core.reorderTask({ taskId: d.taskId, requestId: 'o3', toIndex: 3, expected: { statusRevision: 0 } });
  assert.equal(back.status, 'saved');
  assert.deepEqual(titles(harness, 'todo'), ['A', 'B', 'C', 'D']);

  // A cross-column move with an explicit index lands where the user dropped it.
  const cross = await harness.core.setTaskStatus({
    taskId: a.taskId,
    requestId: 's-cross',
    toStatus: 'doing',
    toIndex: 0,
    expected: { statusRevision: 0 },
  });
  assert.equal(cross.status, 'saved');
  assert.deepEqual(titles(harness, 'todo'), ['B', 'C', 'D']);
  assert.deepEqual(titles(harness, 'doing'), ['A']);

  // Moving it back with an index restores a deliberate position.
  const backAgain = await harness.core.setTaskStatus({
    taskId: a.taskId,
    requestId: 's-back',
    toStatus: 'todo',
    toIndex: 1,
    expected: { statusRevision: 1 },
  });
  assert.equal(backAgain.status, 'saved');
  assert.deepEqual(titles(harness, 'todo'), ['B', 'A', 'C', 'D']);

  const board = okBoard(harness.core.readBoard({ projectId: PROJECT_A }));
  const todo = board.columns.find((entry) => entry.status === 'todo');
  assert.deepEqual(todo?.tasks.map((task) => task.order), [0, 1, 2, 3], '列内顺序连续且可核对');
  assert.ok(
    harness.core.readActivity({ scopeKind: 'project', scopeId: PROJECT_A }).some((entry) => entry.code === 'task-order-changed'),
    '列顺序变化进入项目活动历史',
  );
});

test('F02-R04: undo restores the previous status and its applicable fields', async () => {
  const harness = createHarness();
  await registerProject(harness, PROJECT_A, SAME_TITLE, PATH_A);
  const task = await seedTask(harness, 'req-1', 'Undo me');

  const first = await harness.core.setTaskStatus({
    taskId: task.taskId,
    requestId: 's1',
    toStatus: 'blocked',
    blockedReason: '等外部接口',
    expected: { statusRevision: 0 },
  });
  assert.equal(first.status, 'saved');
  const blocked = harness.core.readTask({ taskId: task.taskId });
  assert.deepEqual(blocked?.undoTarget, { statusRevision: 1, appliedUpdateId: 's1' }, 'the UI gets the exact baseline to pass back');

  const unblocked = await harness.core.setTaskStatus({
    taskId: task.taskId,
    requestId: 's2',
    toStatus: 'doing',
    expected: { statusRevision: 1 },
  });
  assert.equal(unblocked.status, 'saved');
  assert.equal(harness.core.readTask({ taskId: task.taskId })?.blockedReason, null);

  harness.resetJournal();
  const undone = await harness.core.undoStatusChange({
    taskId: task.taskId,
    undoId: 'undo-1',
    expected: { statusRevision: 2, appliedUpdateId: 's2' },
  });
  assert.equal(undone.status, 'undone');
  assert.deepEqual(undone.status === 'undone' ? undone.restored : null, { status: 'blocked', blockedReason: '等外部接口' });
  assert.equal(undone.status === 'undone' ? undone.previousStatus : null, 'doing');
  const afterUndo = harness.core.readTask({ taskId: task.taskId });
  assert.equal(afterUndo?.status, 'blocked', '撤销恢复本次操作前的状态');
  assert.equal(afterUndo?.blockedReason, '等外部接口', '并恢复适用字段');
  assert.equal(afterUndo?.statusRevision, 3);
  assert.equal(afterUndo?.undoTarget, null, 'a status produced by an undo is not itself undoable');
  assert.equal(harness.writes(SCOPE), 1, '撤销 = 一次写');
  assert.ok(
    harness.core
      .readActivity({ scopeKind: 'task', scopeId: task.taskId })
      .some((entry) => entry.code === 'task-undone' && entry.details['undoneUpdateId'] === 's2'),
  );
});

test('F02-R04/REC-04: an undo that lost the race fails explicitly and shows the current value', async () => {
  const harness = createHarness();
  await registerProject(harness, PROJECT_A, SAME_TITLE, PATH_A);
  const task = await seedTask(harness, 'req-1', 'Racy');

  const nothing = await harness.core.undoStatusChange({
    taskId: task.taskId,
    undoId: 'u0',
    expected: { statusRevision: 0, appliedUpdateId: 'none' },
  });
  assert.equal(nothing.status, 'cannot-undo');
  assert.equal(nothing.status === 'cannot-undo' ? nothing.code : null, 'nothing-to-undo');
  assert.equal(nothing.status === 'cannot-undo' ? nothing.current.status : null, 'todo');

  await harness.core.setTaskStatus({ taskId: task.taskId, requestId: 's1', toStatus: 'doing', expected: { statusRevision: 0 } });
  assert.deepEqual(harness.core.readTask({ taskId: task.taskId })?.undoTarget, { statusRevision: 1, appliedUpdateId: 's1' });

  // Someone else moves the task again before the first window undoes it.
  await harness.core.setTaskStatus({ taskId: task.taskId, requestId: 's2', toStatus: 'done', expected: { statusRevision: 1 } });
  harness.resetJournal();
  const stale = await harness.core.undoStatusChange({
    taskId: task.taskId,
    undoId: 'undo-late',
    expected: { statusRevision: 1, appliedUpdateId: 's1' },
  });
  assert.equal(stale.status, 'cannot-undo');
  assert.equal(stale.status === 'cannot-undo' ? stale.code : null, 'superseded');
  assert.equal(stale.status === 'cannot-undo' ? stale.current.status : null, 'done', '撤销失败展示当前值');
  assert.equal(stale.status === 'cannot-undo' ? stale.currentStatusRevision : null, 2);
  assert.equal(stale.status === 'cannot-undo' ? stale.currentAppliedUpdateId : null, 's2');
  assert.equal(harness.core.readTask({ taskId: task.taskId })?.status, 'done', '旧撤销不覆盖新修改');
  assert.equal(harness.writes(SCOPE), 0, 'a refused undo writes nothing');

  // A stale revision is refused for the same reason, even when the identity matches.
  const staleRevision = await harness.core.undoStatusChange({
    taskId: task.taskId,
    undoId: 'undo-stale-rev',
    expected: { statusRevision: 1, appliedUpdateId: 's2' },
  });
  assert.equal(staleRevision.status === 'cannot-undo' ? staleRevision.code : null, 'superseded');

  // The winning undo works, and repeating the same undo is refused, not applied twice.
  const ok = await harness.core.undoStatusChange({
    taskId: task.taskId,
    undoId: 'undo-ok',
    expected: { statusRevision: 2, appliedUpdateId: 's2' },
  });
  assert.equal(ok.status, 'undone');
  assert.equal(harness.core.readTask({ taskId: task.taskId })?.status, 'doing');
  assert.equal(harness.core.readTask({ taskId: task.taskId })?.statusRevision, 3);
  harness.resetJournal();
  const repeated = await harness.core.undoStatusChange({
    taskId: task.taskId,
    undoId: 'undo-ok',
    expected: { statusRevision: 3, appliedUpdateId: 'undo-ok' },
  });
  assert.equal(repeated.status, 'cannot-undo');
  assert.equal(repeated.status === 'cannot-undo' ? repeated.code : null, 'superseded');
  assert.equal(harness.writes(SCOPE), 0);
});

test('REC-02/REC-04: repeated and concurrent status submissions produce exactly one result', async () => {
  const harness = createHarness();
  await registerProject(harness, PROJECT_A, SAME_TITLE, PATH_A);
  const task = await seedTask(harness, 'req-1', 'Idempotent');

  const first = await harness.core.setTaskStatus({ taskId: task.taskId, requestId: 's1', toStatus: 'doing', expected: { statusRevision: 0 } });
  assert.equal(first.status, 'saved');
  const retry = await harness.core.setTaskStatus({ taskId: task.taskId, requestId: 's1', toStatus: 'doing', expected: { statusRevision: 0 } });
  assert.equal(retry.status, 'already-applied', '连点/超时重试只产生一个结果');
  assert.equal(harness.core.readTask({ taskId: task.taskId })?.statusRevision, 1);

  const clicks = await Promise.all(
    Array.from({ length: 6 }, () =>
      harness.core.setTaskStatus({
        taskId: task.taskId,
        requestId: 's-click',
        toStatus: 'blocked',
        blockedReason: '等',
        expected: { statusRevision: 1 },
      }),
    ),
  );
  assert.equal(clicks.filter((outcome) => outcome.status === 'saved').length, 1, 'only one submission is the winner');
  assert.equal(clicks.filter((outcome) => outcome.status === 'already-applied').length, 5);
  assert.equal(harness.core.readTask({ taskId: task.taskId })?.statusRevision, 2, 'exactly one revision was consumed');

  // Two DIFFERENT requests racing on the same baseline: one wins, the other is
  // told the baseline moved and must re-read (never a silent no-op).
  const race = await Promise.all([
    harness.core.setTaskStatus({ taskId: task.taskId, requestId: 'race-a', toStatus: 'done', expected: { statusRevision: 2 } }),
    harness.core.setTaskStatus({ taskId: task.taskId, requestId: 'race-b', toStatus: 'cancelled', expected: { statusRevision: 2 } }),
  ]);
  assert.deepEqual(race.map((outcome) => outcome.status).sort(), ['baseline-changed', 'saved'], '后续明确操作按当前状态执行');
  assert.equal(harness.core.readTask({ taskId: task.taskId })?.statusRevision, 3);
});

test('F02-R03/R05: completing keeps records and history, and generates no project outcome', async () => {
  const harness = createHarness();
  await registerProject(harness, PROJECT_A, SAME_TITLE, PATH_A);
  const task = await seedTask(harness, 'req-1', 'Finish with records');
  await harness.core.linkConversation({ taskId: task.taskId, conversationId: 'conv-1' });
  const scope = { scopeKind: 'task' as const, scopeId: task.taskId, recordObjectId: 'conv-1' };
  const confirmed = await harness.core.confirmPaired({
    updateId: 'u1',
    ...scope,
    expected: expectationOf(harness.core, scope),
    origin: 'ai',
    record: { content: content('record v1') },
    summary: { content: content('summary v1') },
  });
  assert.equal(confirmed.status, 'committed');
  const draft = await harness.core.saveDraft({
    kind: 'taskRecord',
    scopeKind: 'task',
    scopeId: task.taskId,
    objectId: 'conv-1',
    content: content('unfinished draft'),
  });

  harness.resetJournal();
  const done = await harness.core.setTaskStatus({ taskId: task.taskId, requestId: 's1', toStatus: 'done', expected: { statusRevision: 0 } });
  assert.equal(done.status, 'saved');
  assert.equal(harness.writes(SCOPE), 1, '完成只写任务字段：不生成项目记录、不归档、不停止任何对话');
  assert.equal(harness.core.history({ scopeKind: 'task', scopeId: task.taskId, objectKind: 'taskSummary', objectId: task.taskId }).length, 1);
  assert.equal(harness.core.getDraft(draft.draftId)?.state, 'editing', '完成不动草稿');

  const reopened = await harness.core.setTaskStatus({ taskId: task.taskId, requestId: 's2', toStatus: 'doing', expected: { statusRevision: 1 } });
  assert.equal(reopened.status, 'saved');
  assert.equal(
    harness.core.history({ scopeKind: 'task', scopeId: task.taskId, objectKind: 'taskSummary', objectId: task.taskId }).length,
    1,
    '重新打开保留正式记录与历史 (F02-R03)',
  );
  const summary = harness.core.readObject({ scopeKind: 'task', scopeId: task.taskId, objectKind: 'taskSummary', objectId: task.taskId });
  assert.equal(summary?.content.sections[0]?.body, 'summary v1');
  const projectHead = harness.core.readScopeState({ scopeKind: 'project', scopeId: PROJECT_A });
  assert.deepEqual(projectHead?.current.projectRecord, {}, 'no project record was generated by completing');
  assert.equal(projectHead?.revision, 0);
  assert.equal(
    harness.core.readActivity({ scopeKind: 'project', scopeId: PROJECT_A }).filter((entry) => entry.code === 'pair-confirmed').length,
    0,
  );
});

test('F02: the board token tracks status and order, and the five columns stay the vocabulary', async () => {
  const harness = createHarness();
  await registerProject(harness, PROJECT_A, SAME_TITLE, PATH_A);
  const a = await seedTask(harness, 'r1', 'A');
  const b = await seedTask(harness, 'r2', 'B');

  const before = okBoard(harness.core.readBoard({ projectId: PROJECT_A })).boardToken;
  await harness.core.setTaskStatus({ taskId: b.taskId, requestId: 's1', toStatus: 'done', expected: { statusRevision: 0 } });
  const afterStatus = okBoard(harness.core.readBoard({ projectId: PROJECT_A })).boardToken;
  assert.notEqual(afterStatus, before, 'a status change invalidates a stale board response');

  // Moving the only card of a column to index 0 is a no-op: nothing is rewritten.
  harness.resetJournal();
  const noop = await harness.core.reorderTask({ taskId: a.taskId, requestId: 'o1', toIndex: 0, expected: { statusRevision: 0 } });
  assert.equal(noop.status, 'no-change');
  assert.equal(harness.writes(SCOPE), 0);
  assert.equal(okBoard(harness.core.readBoard({ projectId: PROJECT_A })).boardToken, afterStatus);

  const board = okBoard(harness.core.readBoard({ projectId: PROJECT_A }));
  assert.deepEqual(
    board.columns.map((entry) => entry.status),
    ['todo', 'doing', 'blocked', 'done', 'cancelled'],
  );
  assert.equal(board.columns.find((entry) => entry.status === 'cancelled')?.collapsedByDefault, true);
  assert.equal(board.columns.find((entry) => entry.status === 'done')?.collapsedByDefault, false);
  assert.equal(board.tasks.every((task) => task.archived === false), true);
  assert.deepEqual(board.project.taskCounts, { todo: 1, doing: 0, blocked: 0, done: 1, cancelled: 0 });
});

test('REC-05: a corrupt status/order structure is rejected by the domain validator, never read as absent', async () => {
  const harness = createHarness();
  await registerProject(harness, PROJECT_A, SAME_TITLE, PATH_A);
  const task = await seedTask(harness, 'req-1', 'Corrupt me');
  await harness.core.setTaskStatus({ taskId: task.taskId, requestId: 's1', toStatus: 'doing', expected: { statusRevision: 0 } });

  const head = harness.core.readScopeState({ scopeKind: 'task', scopeId: task.taskId });
  const projectHead = harness.core.readScopeState({ scopeKind: 'project', scopeId: PROJECT_A });
  assert.ok(head?.task != null);
  assert.ok(projectHead?.project != null);
  assert.equal(isScopeStateRecord(head), true, 'a real head validates');

  const brokenKind = {
    ...head,
    task: {
      ...head.task,
      lastStatusChange: {
        updateId: 'x',
        at: 'now',
        kind: 'nonsense',
        from: { status: 'todo', blockedReason: null },
        to: { status: 'doing', blockedReason: null },
      },
    },
  };
  assert.equal(isScopeStateRecord(brokenKind), false, 'an unknown status-operation kind is corruption');

  const brokenSnapshot = {
    ...head,
    task: {
      ...head.task,
      lastStatusChange: {
        updateId: 'x',
        at: 'now',
        kind: 'transition',
        from: { status: 'nonsense', blockedReason: null },
        to: { status: 'doing', blockedReason: null },
      },
    },
  };
  assert.equal(isScopeStateRecord(brokenSnapshot), false, 'an unknown status inside an undo snapshot is corruption');

  const brokenBoardOrder = {
    ...projectHead,
    project: { ...projectHead.project, boardOrder: { ...projectHead.project.boardOrder, todo: [7] } },
  };
  assert.equal(isScopeStateRecord(brokenBoardOrder), false, 'a non-string id in a column preference is corruption');

  const brokenOrderRevision = { ...projectHead, project: { ...projectHead.project, orderRevision: 'one' } };
  assert.equal(isScopeStateRecord(brokenOrderRevision), false);
});
