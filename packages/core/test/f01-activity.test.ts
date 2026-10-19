/**
 * F01-R07 / SAVE-08 — the important-activity history: 目标、状态、归属、确认
 * changes are queryable, keystrokes are not, and the history is per scope and
 * survives a restart.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { content, createHarness, expectationOf } from './harness.ts';
import { PATH_A, PROJECT_A, PROJECT_B, SAME_TITLE, registerBoth, registerProject, taskOf } from './f01Harness.ts';

test('F01-R07: activity records 创建/目标/标题/归属/确认 and the project changes, never keystrokes', async () => {
  const harness = createHarness();
  await registerProject(harness, PROJECT_A, SAME_TITLE, PATH_A);
  const task = taskOf(await harness.core.createTask({ projectId: PROJECT_A, requestId: 'req-1', title: 'Task one' }));

  // Keystrokes are drafts, not history.
  await harness.core.saveFieldDraft({ taskId: task.taskId, requestId: 'd1', title: 't' });
  await harness.core.saveFieldDraft({ taskId: task.taskId, requestId: 'd1', title: 'tt' });
  await harness.core.saveFieldDraft({ taskId: task.taskId, requestId: 'd1', title: 'ttt' });
  const afterTyping = harness.core.readActivity({ scopeKind: 'task', scopeId: task.taskId });
  assert.deepEqual(afterTyping.map((entry) => entry.code), ['task-created'], '不记录每次键入 (F01-R07)');
  assert.equal(afterTyping[0]?.details['projectId'], PROJECT_A, '归属 is recorded at creation (OBJ-03 fixed attribution)');
  assert.equal(afterTyping[0]?.details['status'], 'todo');

  const saved = await harness.core.updateTaskFields({
    taskId: task.taskId,
    requestId: 'e1',
    expected: { fieldsRevision: 0, statusRevision: 0 },
    title: 'Renamed',
    goal: 'The goal',
  });
  assert.equal(saved.status, 'saved');
  await harness.core.saveBoardPosition({ projectId: PROJECT_A, selectedTaskId: task.taskId, view: 'board' });
  await harness.core.observeWorkScope({ projectId: PROJECT_A, availability: 'missing-dir', detail: 'ENOENT' });

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

  const taskActivity = harness.core.readActivity({ scopeKind: 'task', scopeId: task.taskId });
  assert.deepEqual(
    taskActivity.map((entry) => entry.code),
    ['pair-confirmed', 'task-goal-changed', 'task-title-changed', 'task-created'],
    'newest first, and each important change is present exactly once',
  );
  assert.equal(new Set(taskActivity.map((entry) => entry.activityId)).size, taskActivity.length, 'entry ids are unique');
  assert.equal(taskActivity.every((entry) => entry.scopeKind === 'task' && entry.scopeId === task.taskId), true);
  const confirmationEntry = taskActivity[0];
  assert.equal(confirmationEntry?.details['revision'], '1');
  assert.equal(confirmationEntry?.details['changed'], 'record,summary');

  const projectActivity = harness.core.readActivity({ scopeKind: 'project', scopeId: PROJECT_A });
  assert.deepEqual(projectActivity.map((entry) => entry.code), [
    'work-scope-changed',
    'board-position-changed',
    'project-registered',
  ]);
  assert.equal(projectActivity[0]?.details['path'], PATH_A, 'the working scope is part of the record');

  // limit + isolation + restart
  assert.equal(harness.core.readActivity({ scopeKind: 'task', scopeId: task.taskId, limit: 2 }).length, 2);
  assert.deepEqual(harness.core.readActivity({ scopeKind: 'project', scopeId: PROJECT_B }), []);
  assert.deepEqual(harness.core.readActivity({ scopeKind: 'task', scopeId: 'no-such-task' }), []);

  const restarted = harness.restart();
  assert.deepEqual(
    restarted.core.readActivity({ scopeKind: 'task', scopeId: task.taskId }).map((entry) => entry.code),
    taskActivity.map((entry) => entry.code),
    'the history survives a restart (REC-03)',
  );
  assert.deepEqual(
    restarted.core.readActivity({ scopeKind: 'project', scopeId: PROJECT_A }).map((entry) => entry.code),
    projectActivity.map((entry) => entry.code),
  );
});

test('F01-R01: activity is scoped per project — one project never shows another project history', async () => {
  const harness = createHarness();
  await registerBoth(harness);
  const taskA = taskOf(await harness.core.createTask({ projectId: PROJECT_A, requestId: 'a1', title: 'A task' }));
  const taskB = taskOf(await harness.core.createTask({ projectId: PROJECT_B, requestId: 'b1', title: 'B task' }));
  await harness.core.updateTaskFields({
    taskId: taskA.taskId,
    requestId: 'a2',
    expected: { fieldsRevision: 0, statusRevision: 0 },
    goal: 'Goal of A',
  });

  assert.deepEqual(
    harness.core.readActivity({ scopeKind: 'task', scopeId: taskA.taskId }).map((entry) => entry.code),
    ['task-goal-changed', 'task-created'],
  );
  assert.deepEqual(harness.core.readActivity({ scopeKind: 'task', scopeId: taskB.taskId }).map((entry) => entry.code), ['task-created']);
  assert.deepEqual(harness.core.readActivity({ scopeKind: 'project', scopeId: PROJECT_A }).map((entry) => entry.code), ['project-registered']);
  assert.deepEqual(harness.core.readActivity({ scopeKind: 'project', scopeId: PROJECT_B }).map((entry) => entry.code), ['project-registered']);
  assert.equal(
    harness.core.readActivity({ scopeKind: 'project', scopeId: PROJECT_A })[0]?.scopeId,
    PROJECT_A,
    'project history entries name their project id, not their (shared) title',
  );
});
