/**
 * F01-R01/R03/R07 — project isolation, unregistered vs empty, per-project board
 * position, and the work-scope-unavailable state (ADR-003 4.1).
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createHarness } from './harness.ts';
import {
  PATH_A,
  PATH_B,
  PROJECT_A,
  PROJECT_B,
  PROJECT_MISSING,
  SAME_TITLE,
  assertAttribution,
  okBoard,
  registerBoth,
  registerProject,
  taskOf,
} from './f01Harness.ts';
import { createKanbanCore } from '../src/core.ts';
import { AIKANBAN_TABLES } from '../src/domainSpec.ts';

test('ADR-003: two projects may share a title and never merge; identity is workspace.id', async () => {
  const harness = createHarness();
  const first = await registerProject(harness, PROJECT_A, SAME_TITLE, PATH_A);
  const second = await registerProject(harness, PROJECT_B, SAME_TITLE, PATH_B);

  assert.equal(first.title, SAME_TITLE);
  assert.equal(second.title, SAME_TITLE);
  assert.notEqual(first.projectId, second.projectId, 'the same title must not collapse two projects');
  assert.equal(harness.core.listProjects().length, 2);

  // Re-registering the very same id/title/path is not a change at all: no write.
  harness.resetJournal();
  const again = await harness.core.registerProject({ projectId: PROJECT_A, title: SAME_TITLE, path: PATH_A });
  assert.equal(again.status, 'unchanged');
  assert.equal(harness.writes(), 0, 'an unchanged registration performs no write');

  // A title change is a display refresh of the SAME id, never a new project.
  const renamed = await harness.core.registerProject({ projectId: PROJECT_A, title: 'Renamed', path: PATH_A });
  assert.equal(renamed.status, 'refreshed');
  assert.equal(renamed.project.projectId, PROJECT_A);
  assert.equal(harness.core.listProjects().length, 2, 'renaming never creates a project');
  assert.equal(harness.core.listProjects().filter((project) => project.title === 'Renamed').length, 1);
});

test('F01-R01: tasks are read per project, identical titles stay independent, views carry their project id', async () => {
  const harness = createHarness();
  await registerBoth(harness);

  const inA = await harness.core.createTask({ projectId: PROJECT_A, requestId: 'req-a1', title: 'Same title' });
  const inB = await harness.core.createTask({ projectId: PROJECT_B, requestId: 'req-b1', title: 'Same title' });
  const taskA = taskOf(inA);
  const taskB = taskOf(inB);
  assert.notEqual(taskA.taskId, taskB.taskId, 'identical titles are independent tasks (F01-R04)');
  assert.equal(taskA.projectId, PROJECT_A);
  assert.equal(taskB.projectId, PROJECT_B);
  assert.equal(inA.status === 'created' ? inA.project.projectId : null, PROJECT_A, 'the result reports attribution, not the page title');
  assert.equal(inA.status === 'created' ? inA.project.title : null, SAME_TITLE);

  const boardA = okBoard(harness.core.readBoard({ projectId: PROJECT_A }));
  const boardB = okBoard(harness.core.readBoard({ projectId: PROJECT_B }));
  assert.equal(boardA.project.projectId, PROJECT_A);
  assert.equal(boardB.project.projectId, PROJECT_B);
  assert.deepEqual(boardA.tasks.map((task) => task.taskId), [taskA.taskId], 'project A shows only its own task');
  assert.deepEqual(boardB.tasks.map((task) => task.taskId), [taskB.taskId], 'project B shows only its own task');
  assertAttribution(boardA.tasks, PROJECT_A);
  assertAttribution(boardB.tasks, PROJECT_B);

  // A task read directly still reports the project it belongs to, so a late
  // response can never be mistaken for the currently selected project.
  assert.equal(harness.core.readTask({ taskId: taskA.taskId })?.projectId, PROJECT_A);
  assert.equal(boardA.project.title, boardB.project.title, 'both projects display the same title');
  assert.notEqual(boardA.boardToken, boardB.boardToken, 'the board token distinguishes the two projects');
  assert.equal(
    okBoard(harness.core.readBoard({ projectId: PROJECT_A })).boardToken,
    boardA.boardToken,
    'the board token is stable while nothing changed',
  );
});

test('F01 §3: an unregistered project is not an empty project, and a failing read is reported as failure', async () => {
  const harness = createHarness();
  const missing = harness.core.readBoard({ projectId: PROJECT_MISSING });
  assert.equal(missing.status, 'unknown-project');
  assert.deepEqual(missing.tasks, []);
  assert.equal(harness.writes(), 0, 'reading a project never creates one (REC-05)');
  assert.equal(harness.core.readProject({ projectId: PROJECT_MISSING }), null);
  assert.equal(harness.core.listProjects().length, 0);

  // Registered with no tasks: that IS an empty board, and says so.
  await registerProject(harness, PROJECT_A, SAME_TITLE, PATH_A);
  const empty = okBoard(harness.core.readBoard({ projectId: PROJECT_A }));
  assert.equal(empty.tasks.length, 0);
  assert.equal(empty.project.visibleTaskCount, 0);
  assert.deepEqual(
    empty.columns.map((column) => column.count),
    [0, 0, 0, 0, 0],
  );

  // A head that exists for content only (ensureScope) is not a registered project.
  await harness.core.ensureScope({ scopeKind: 'project', scopeId: PROJECT_B });
  assert.equal(harness.core.readBoard({ projectId: PROJECT_B }).status, 'unknown-project');

  // A genuinely failing read must not be presented as an empty board (REC-05).
  const failingPort = {
    ...harness.port,
    get: (): never => {
      throw new Error('storage unavailable');
    },
  };
  const failing = createKanbanCore({ port: failingPort, now: harness.clock });
  const failed = failing.readBoard({ projectId: PROJECT_A });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.status === 'failed' ? failed.code : null, 'read-failed');
  assert.match(failed.status === 'failed' ? failed.message : '', /storage unavailable/);
});

test('F01 flow 7: each project keeps its own board position, and a position stays inside its project', async () => {
  const harness = createHarness();
  await registerBoth(harness);
  const taskA = taskOf(await harness.core.createTask({ projectId: PROJECT_A, requestId: 'req-a1', title: 'A task' }));
  const taskB = taskOf(await harness.core.createTask({ projectId: PROJECT_B, requestId: 'req-b1', title: 'B task' }));

  assert.equal((await harness.core.saveBoardPosition({ projectId: PROJECT_A, selectedTaskId: taskA.taskId, view: 'board' })).status, 'saved');
  assert.equal((await harness.core.saveBoardPosition({ projectId: PROJECT_B, selectedTaskId: taskB.taskId, view: 'detail' })).status, 'saved');

  const viewA = harness.core.readProject({ projectId: PROJECT_A });
  const viewB = harness.core.readProject({ projectId: PROJECT_B });
  assert.equal(viewA?.position.selectedTaskId, taskA.taskId);
  assert.equal(viewA?.position.view, 'board');
  assert.equal(viewB?.position.selectedTaskId, taskB.taskId);
  assert.equal(viewB?.position.view, 'detail', 'switching projects restores that project position');

  // A selection cannot be carried into another project.
  const cross = await harness.core.saveBoardPosition({ projectId: PROJECT_B, selectedTaskId: taskA.taskId });
  assert.equal(cross.status, 'rejected');
  assert.equal(cross.status === 'rejected' ? cross.code : null, 'invalid-input');
  assert.equal(harness.core.readProject({ projectId: PROJECT_B })?.position.selectedTaskId, taskB.taskId);

  harness.resetJournal();
  const again = await harness.core.saveBoardPosition({ projectId: PROJECT_A, selectedTaskId: taskA.taskId, view: 'board' });
  assert.equal(again.status, 'unchanged');
  assert.equal(harness.writes(), 0, 'saving an unchanged position performs no write');
});

test('F01-R07 / ADR-003: a missing work scope keeps management data readable and writable and never rewrites the path', async () => {
  const harness = createHarness();
  await registerProject(harness, PROJECT_A, SAME_TITLE, PATH_A);
  const first = taskOf(await harness.core.createTask({ projectId: PROJECT_A, requestId: 'req-1', title: 'Before the outage' }));

  const observed = await harness.core.observeWorkScope({ projectId: PROJECT_A, availability: 'missing-dir', detail: 'ENOENT' });
  assert.equal(observed.status, 'recorded');
  assert.equal(observed.status === 'recorded' ? observed.project.path : null, PATH_A, 'a vanished directory must not rewrite workspace.path');
  assert.equal(observed.status === 'recorded' ? observed.project.workScope.allowed : null, false);

  // Management data stays readable and writable: no clearing, no hiding.
  const board = okBoard(harness.core.readBoard({ projectId: PROJECT_A }));
  assert.equal(board.tasks.length, 1);
  assert.equal(board.project.workScope.availability, 'missing-dir');
  assert.equal(board.project.path, PATH_A);
  const second = await harness.core.createTask({ projectId: PROJECT_A, requestId: 'req-2', title: 'During the outage' });
  assert.equal(second.status, 'created');
  const edited = await harness.core.updateTaskFields({
    taskId: first.taskId,
    requestId: 'edit-1',
    expected: { fieldsRevision: 0, statusRevision: 0 },
    title: 'Renamed during the outage',
  });
  assert.equal(edited.status, 'saved');

  // Only a real filesystem action is refused, and it says why.
  const decision = harness.core.canUseWorkScope({ projectId: PROJECT_A });
  assert.equal(decision.allowed, false);
  assert.equal(decision.path, PATH_A);
  assert.match(decision.reason ?? '', /工作范围不可用/);
  assert.equal(harness.core.canUseWorkScope({ projectId: PROJECT_MISSING }).allowed, false, 'an unregistered project never guesses a scope');
  assert.match(harness.core.canUseWorkScope({ projectId: PROJECT_MISSING }).reason ?? '', /不猜测/);

  // The host may render a live observation without persisting it.
  harness.resetJournal();
  const hinted = okBoard(harness.core.readBoard({ projectId: PROJECT_A, workScope: { availability: 'ok' } }));
  assert.equal(hinted.project.workScope.allowed, true);
  assert.equal(harness.writes(), 0, 'a display hint is not a write');
  assert.equal(harness.core.readProject({ projectId: PROJECT_A })?.workScope.availability, 'missing-dir');

  // Recovery: the same id is immediately usable again, with all data intact.
  const restored = await harness.core.observeWorkScope({ projectId: PROJECT_A, availability: 'ok' });
  assert.equal(restored.status, 'recorded');
  assert.equal(okBoard(harness.core.readBoard({ projectId: PROJECT_A })).tasks.length, 2);
  assert.equal(harness.core.canUseWorkScope({ projectId: PROJECT_A }).allowed, true);
  assert.equal(
    harness.core.readActivity({ scopeKind: 'project', scopeId: PROJECT_A }).filter((entry) => entry.code === 'work-scope-changed').length,
    2,
    'both observations are visible in the project history',
  );
});

test('F02 contract: canonical columns, 已取消 collapsed by default, 已完成 still visible, archive is not a status', async () => {
  const harness = createHarness();
  await registerProject(harness, PROJECT_A, SAME_TITLE, PATH_A);
  await harness.core.createTask({ projectId: PROJECT_A, requestId: 'r1', title: 'Todo' });
  await harness.core.createTask({ projectId: PROJECT_A, requestId: 'r2', title: 'Doing', initialStatus: 'doing' });
  await harness.core.createTask({ projectId: PROJECT_A, requestId: 'r3', title: 'Blocked', initialStatus: 'blocked', blockedReason: '等接口' });
  await harness.core.createTask({ projectId: PROJECT_A, requestId: 'r4', title: 'Done', initialStatus: 'done' });
  await harness.core.createTask({ projectId: PROJECT_A, requestId: 'r5', title: 'Cancelled', initialStatus: 'cancelled' });

  const board = okBoard(harness.core.readBoard({ projectId: PROJECT_A }));
  assert.deepEqual(
    board.columns.map((column) => column.status),
    ['todo', 'doing', 'blocked', 'done', 'cancelled'],
  );
  const byStatus = new Map(board.columns.map((column) => [column.status, column]));
  for (const status of ['todo', 'doing', 'blocked', 'done', 'cancelled'] as const) {
    assert.equal(byStatus.get(status)?.count, 1, `column ${status} must count its own task`);
  }
  assert.equal(byStatus.get('cancelled')?.collapsedByDefault, true, '已取消 default collapsed (F02-R01)');
  assert.equal(byStatus.get('done')?.collapsedByDefault, false, '已完成 stays visible (F02-R01)');
  assert.equal(byStatus.get('done')?.label, '已完成');
  assert.equal(byStatus.get('blocked')?.tasks[0]?.blockedReason, '等接口');
  assert.deepEqual(board.project.taskCounts, { todo: 1, doing: 1, blocked: 1, done: 1, cancelled: 1 });
  assert.equal(board.tasks.length, 5);
  assert.equal(board.tasks.every((task) => task.archived === false), true, '归档 is a visibility flag, not one of the five statuses');
  assert.equal(harness.writes(AIKANBAN_TABLES.drafts), 0);
});
