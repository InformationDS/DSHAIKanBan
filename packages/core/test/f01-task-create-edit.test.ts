/**
 * F01-R02…R06 — task creation (validation, no side effects, idempotency,
 * unknown results), field editing (substantive only, drafts, baseline) and the
 * separation between task fields and official content.
 *
 * Fault injection runs through the memory port's `beforeWrite`, which fails the
 * write BEFORE it becomes durable (the measured storageDomain behaviour:
 * durability first, memory second).
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { content, createHarness, expectationOf } from './harness.ts';
import { PATH_A, PROJECT_A, PROJECT_B, SAME_TITLE, okBoard, registerBoth, registerProject, taskOf } from './f01Harness.ts';
import { AIKANBAN_TABLES } from '../src/domainSpec.ts';
import { taskIdOf } from '../src/taskModel.ts';

const SCOPE = AIKANBAN_TABLES.scopeState;

test('F01-R02: only-whitespace titles are refused in place, the goal survives, and nothing is written', async () => {
  const harness = createHarness();
  await registerProject(harness, PROJECT_A, SAME_TITLE, PATH_A);
  harness.resetJournal();

  const refused = await harness.core.createTask({ projectId: PROJECT_A, requestId: 'req-blank', title: '   ', goal: '目标说明' });
  assert.equal(refused.status, 'rejected');
  assert.equal(refused.status === 'rejected' ? refused.code : null, 'invalid-title');
  assert.equal(refused.status === 'rejected' ? refused.keptInput.goal : null, '目标说明', 'a refused title does not clear the goal');
  assert.equal(harness.writes(), 0, 'a refused title performs no write');
  assert.equal(okBoard(harness.core.readBoard({ projectId: PROJECT_A })).tasks.length, 0);

  const accepted = await harness.core.createTask({ projectId: PROJECT_A, requestId: 'req-blank', title: '  Real title  ', goal: '目标说明' });
  assert.equal(taskOf(accepted).title, 'Real title', 'the stored title is trimmed');
  assert.equal(taskOf(accepted).goal, '目标说明');
});

test('F01-R03: creation has no side effects — one write, no records/summaries/conversations/AI', async () => {
  const harness = createHarness();
  await registerProject(harness, PROJECT_A, SAME_TITLE, PATH_A);
  harness.resetJournal();

  const created = await harness.core.createTask({ projectId: PROJECT_A, requestId: 'req-1', title: 'Only a title' });
  const task = taskOf(created);

  assert.equal(created.status, 'created');
  assert.equal(task.status, 'todo', 'default status is 未开始 (OBJ-02)');
  assert.equal(task.statusLabel, '未开始');
  assert.equal(task.blockedReason, null);
  assert.equal(task.archived, false);
  assert.equal(task.goal, '', 'no goal means no generated requirement text');
  assert.equal(task.fieldsRevision, 0);
  assert.equal(task.statusRevision, 0);
  assert.equal(task.goalRevision, 0);
  assert.equal(task.hasRecord, false);
  assert.equal(task.hasSummary, false);
  assert.equal(task.summaryProgress, null, 'no summary may be faked for the card');

  assert.equal(harness.writes(), 1, 'creation is exactly one write');
  assert.equal(
    harness.port.journal.filter((event) => event.ok && event.table !== SCOPE).length,
    0,
    'creation touches no other table: no drafts, no conversations, no AI-driven objects',
  );
  const head = harness.core.readScopeState({ scopeKind: 'task', scopeId: task.taskId });
  assert.equal(head?.revision, 0, 'no record/summary version is produced');
  assert.deepEqual(head?.chains, { taskRecord: {}, taskSummary: {}, projectRecord: {}, projectOverview: {} });
  assert.deepEqual(head?.current, { taskRecord: {}, taskSummary: {}, projectRecord: {}, projectOverview: {} });
  assert.deepEqual(head?.links.conversations, {}, 'no work conversation is created or linked');
  assert.equal(harness.core.listDrafts().length, 0);
  assert.equal(harness.core.history({ scopeKind: 'task', scopeId: task.taskId, objectKind: 'taskSummary', objectId: task.taskId }).length, 0);
});

test('F01-R04/REC-02: the same requestId can only ever produce one task — retries and double clicks included', async () => {
  const harness = createHarness();
  await registerProject(harness, PROJECT_A, SAME_TITLE, PATH_A);

  const first = await harness.core.createTask({ projectId: PROJECT_A, requestId: 'req-1', title: 'Retried task' });
  const retry = await harness.core.createTask({ projectId: PROJECT_A, requestId: 'req-1', title: 'Retried task' });
  assert.equal(first.status, 'created');
  assert.equal(retry.status, 'already-created');
  assert.equal(taskOf(retry).taskId, taskOf(first).taskId, 'the retry resolves to the same task');
  assert.equal(taskOf(retry).createdAt, taskOf(first).createdAt, 'and reports the original creation time');
  assert.equal(okBoard(harness.core.readBoard({ projectId: PROJECT_A })).tasks.length, 1);

  // Eight simultaneous submissions of one request (连点) still yield one task.
  const clicks = await Promise.all(
    Array.from({ length: 8 }, () => harness.core.createTask({ projectId: PROJECT_A, requestId: 'req-2', title: 'Double clicked' })),
  );
  assert.equal(okBoard(harness.core.readBoard({ projectId: PROJECT_A })).tasks.length, 2, 'one task per request, not one per click');
  assert.equal(
    new Set(clicks.map((outcome) => (outcome.status === 'created' || outcome.status === 'already-created' ? outcome.taskId : outcome.status))).size,
    1,
  );
  assert.equal(clicks.filter((outcome) => outcome.status === 'failed').length, 0);

  // A deliberate new creation is an independent operation and may reuse the title.
  const deliberate = await harness.core.createTask({ projectId: PROJECT_A, requestId: 'req-3', title: 'Retried task' });
  assert.equal(deliberate.status, 'created');
  assert.notEqual(taskOf(deliberate).taskId, taskOf(first).taskId, 'identical titles never auto-merge');
  const board = okBoard(harness.core.readBoard({ projectId: PROJECT_A }));
  assert.deepEqual(board.tasks.map((task) => task.title), ['Retried task', 'Double clicked', 'Retried task']);

  // The same requestId in another project is a different task (identity includes the project).
  await registerProject(harness, PROJECT_B, SAME_TITLE, 'D:\\BaiduSyncdisk\\work\\beta');
  const other = await harness.core.createTask({ projectId: PROJECT_B, requestId: 'req-1', title: 'Retried task' });
  assert.equal(other.status, 'created');
  assert.notEqual(taskOf(other).taskId, taskOf(first).taskId);
  assert.equal(okBoard(harness.core.readBoard({ projectId: PROJECT_B })).tasks.length, 1, 'no cross-project bleed');
});

test('REC-03: a failed creation leaves nothing behind, and lookupCreate + retry recover without a second task', async () => {
  const harness = createHarness();
  await registerProject(harness, PROJECT_A, SAME_TITLE, PATH_A);
  const expectedId = taskIdOf({ projectId: PROJECT_A, requestId: 'req-x' });

  harness.failNext((event) => event.kind === 'put' && event.table === SCOPE);
  const failed = await harness.core.createTask({ projectId: PROJECT_A, requestId: 'req-x', title: 'Doomed' });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.status === 'failed' ? failed.code : null, 'write-failed');
  assert.equal(failed.status === 'failed' ? failed.taskId : null, expectedId);
  assert.equal(failed.status === 'failed' ? failed.keptInput.title : null, 'Doomed', 'the input is reported back for retry');
  assert.equal(okBoard(harness.core.readBoard({ projectId: PROJECT_A })).tasks.length, 0, 'a failed create creates nothing');

  const lookup = harness.core.lookupCreate({ projectId: PROJECT_A, requestId: 'req-x' });
  assert.equal(lookup.status, 'not-created', 'the caller checks the actual result before retrying');

  harness.clearFaults();
  const retry = await harness.core.createTask({ projectId: PROJECT_A, requestId: 'req-x', title: 'Doomed' });
  assert.equal(retry.status, 'created');
  assert.equal(okBoard(harness.core.readBoard({ projectId: PROJECT_A })).tasks.length, 1);

  // A write that did land while the answer was lost: the SAME requestId is
  // resolved by lookup, and a repeated submission is not a second task.
  const lookupAfter = harness.core.lookupCreate({ projectId: PROJECT_A, requestId: 'req-x' });
  assert.equal(lookupAfter.status, 'created');
  const again = await harness.core.createTask({ projectId: PROJECT_A, requestId: 'req-x', title: 'Doomed' });
  assert.equal(again.status, 'already-created');
  assert.equal(okBoard(harness.core.readBoard({ projectId: PROJECT_A })).tasks.length, 1, '核对后重试不产生第二项');
});

test('F01-R02: a blocked-column creation requires a reason; an invalid reason creates no half-made task', async () => {
  const harness = createHarness();
  await registerProject(harness, PROJECT_A, SAME_TITLE, PATH_A);
  harness.resetJournal();

  const noReason = await harness.core.createTask({ projectId: PROJECT_A, requestId: 'req-b', title: 'Blocked', initialStatus: 'blocked' });
  assert.equal(noReason.status, 'rejected');
  assert.equal(noReason.status === 'rejected' ? noReason.code : null, 'blocked-reason-required');
  const blankReason = await harness.core.createTask({
    projectId: PROJECT_A,
    requestId: 'req-b',
    title: 'Blocked',
    initialStatus: 'blocked',
    blockedReason: '   ',
  });
  assert.equal(blankReason.status, 'rejected');
  assert.equal(harness.writes(), 0, 'cancelling the reason input creates no task at all');
  assert.equal(okBoard(harness.core.readBoard({ projectId: PROJECT_A })).tasks.length, 0);

  const created = await harness.core.createTask({
    projectId: PROJECT_A,
    requestId: 'req-b2',
    title: 'Blocked',
    initialStatus: 'blocked',
    blockedReason: '等外部接口',
  });
  assert.equal(taskOf(created).status, 'blocked');
  assert.equal(taskOf(created).blockedReason, '等外部接口');

  const unknownStatus = await harness.core.createTask({
    projectId: PROJECT_A,
    requestId: 'req-s',
    title: 'Nope',
    initialStatus: 'archived' as never,
  });
  assert.equal(unknownStatus.status, 'rejected');
  assert.equal(unknownStatus.status === 'rejected' ? unknownStatus.code : null, 'invalid-status', '归档 is not a status (OBJ-02)');
});

test('F01-R03: attribution is fixed at creation time even when the board has already switched project', async () => {
  const harness = createHarness();
  await registerBoth(harness);

  const created = await harness.core.createTask({ projectId: PROJECT_A, requestId: 'req-a', title: 'Created while A was open' });
  const task = taskOf(created);

  // The user switches to B (same title) and creates there.
  const switched = okBoard(harness.core.readBoard({ projectId: PROJECT_B }));
  assert.equal(switched.project.title, SAME_TITLE);
  const inB = taskOf(await harness.core.createTask({ projectId: PROJECT_B, requestId: 'req-b', title: 'Created while B was open' }));

  assert.equal(task.projectId, PROJECT_A);
  assert.equal(inB.projectId, PROJECT_B);
  assert.deepEqual(okBoard(harness.core.readBoard({ projectId: PROJECT_A })).tasks.map((entry) => entry.taskId), [task.taskId]);
  assert.deepEqual(okBoard(harness.core.readBoard({ projectId: PROJECT_B })).tasks.map((entry) => entry.taskId), [inB.taskId]);
  assert.equal(created.status === 'created' ? created.project.projectId : null, PROJECT_A, 'the outcome reports the project, not the page title');
});

test('F01-R05/REC-01: opening and typing never advance the official fields; a substantive save does', async () => {
  const harness = createHarness();
  await registerProject(harness, PROJECT_A, SAME_TITLE, PATH_A);
  const created = taskOf(await harness.core.createTask({ projectId: PROJECT_A, requestId: 'req-1', title: 'Original', goal: 'Old goal' }));
  const before = harness.core.readTask({ taskId: created.taskId });
  assert.ok(before !== null);

  // Opening the detail page and the board is a read only.
  harness.resetJournal();
  harness.core.readTask({ taskId: created.taskId });
  okBoard(harness.core.readBoard({ projectId: PROJECT_A }));
  assert.equal(harness.writes(), 0, '打开页面不算实质更新 (F01-R05)');

  harness.resetJournal();
  await harness.core.saveFieldDraft({ taskId: created.taskId, requestId: 'draft-1', title: 'Typed title' });
  await harness.core.saveFieldDraft({ taskId: created.taskId, requestId: 'draft-1', title: 'Typed title 2' });
  await harness.core.saveFieldDraft({ taskId: created.taskId, requestId: 'draft-1', title: 'Typed title 3', goal: 'Typed goal' });
  const afterTyping = harness.core.readTask({ taskId: created.taskId });
  assert.ok(afterTyping !== null);
  assert.equal(afterTyping.title, 'Original', 'typing does not change the official title');
  assert.equal(afterTyping.goal, 'Old goal');
  assert.equal(afterTyping.updatedAt, before.updatedAt, '每次键入不算实质更新 (F01-R05)');
  assert.equal(afterTyping.fieldsRevision, 0);
  assert.equal(afterTyping.pendingFieldDraft?.title, 'Typed title 3', 'the input is recoverable');
  assert.equal(afterTyping.pendingFieldDraft?.goal, 'Typed goal');
  assert.equal(harness.writes(SCOPE), 3, 'three keystroke saves, none of them an official update');
  assert.equal(harness.core.readActivity({ scopeKind: 'task', scopeId: created.taskId }).length, 1, 'no keystroke is history');

  const saved = await harness.core.updateTaskFields({
    taskId: created.taskId,
    requestId: 'edit-1',
    expected: { fieldsRevision: 0, statusRevision: 0 },
    title: '  New title  ',
    goal: 'New goal',
  });
  assert.equal(saved.status, 'saved');
  assert.deepEqual(saved.status === 'saved' ? saved.changed : [], ['title', 'goal']);
  assert.equal(saved.status === 'saved' ? saved.task.title : null, 'New title');
  assert.equal(saved.status === 'saved' ? saved.task.goal : null, 'New goal');
  assert.equal(saved.status === 'saved' ? saved.task.fieldsRevision : null, 1);
  assert.equal(saved.status === 'saved' ? saved.task.pendingFieldDraft : 'x', null, 'a successful save discards the local draft');
  assert.equal(saved.status === 'saved' ? saved.draftDiscarded : null, true);
  assert.equal(saved.status === 'saved' ? saved.recheckMarked : null, true, 'a substantive goal change marks the summary 待核对');
  assert.ok((saved.status === 'saved' ? saved.task.updatedAt : '') > before.updatedAt, 'a successful substantive change updates the time');

  // Retrying the same request must not bump the revision twice.
  const retried = await harness.core.updateTaskFields({
    taskId: created.taskId,
    requestId: 'edit-1',
    expected: { fieldsRevision: 1, statusRevision: 0 },
    title: 'New title',
  });
  assert.equal(retried.status, 'already-applied');
  assert.equal(harness.core.readTask({ taskId: created.taskId })?.fieldsRevision, 1);

  // A different request that states the current values is a no-change: no write, no version.
  harness.resetJournal();
  const noChange = await harness.core.updateTaskFields({
    taskId: created.taskId,
    requestId: 'edit-2',
    expected: { fieldsRevision: 1, statusRevision: 0 },
    title: 'New title',
    goal: 'New goal',
  });
  assert.equal(noChange.status, 'no-change');
  assert.equal(harness.writes(), 0, '无变化不制造新版本 (SAVE-02/10)');
});

test('SAVE-04: a formatting-only goal edit is 纯排版 — no write, no recheck', async () => {
  const harness = createHarness();
  await registerProject(harness, PROJECT_A, SAME_TITLE, PATH_A);
  const task = taskOf(await harness.core.createTask({ projectId: PROJECT_A, requestId: 'req-1', title: 'Task', goal: '目标 A' }));
  harness.resetJournal();

  const cosmetic = await harness.core.updateTaskFields({
    taskId: task.taskId,
    requestId: 'edit-cosmetic',
    expected: { fieldsRevision: 0, statusRevision: 0 },
    goal: '目标  A',
  });
  assert.equal(cosmetic.status, 'no-change');
  assert.deepEqual(cosmetic.status === 'no-change' ? cosmetic.cosmeticOnly : [], ['goal']);
  assert.equal(harness.writes(), 0);
  assert.equal(harness.core.readTask({ taskId: task.taskId })?.needsRecheck, false, '纯排版无需核对');
  assert.equal(harness.core.readTask({ taskId: task.taskId })?.goalRevision, 0);
});

test('F01-R05/R06: a rename keeps records and drafts; a substantive goal change marks them 待核对', async () => {
  const harness = createHarness();
  await registerProject(harness, PROJECT_A, SAME_TITLE, PATH_A);
  const task = taskOf(await harness.core.createTask({ projectId: PROJECT_A, requestId: 'req-1', title: 'Original title', goal: 'Goal v1' }));

  await harness.core.linkConversation({ taskId: task.taskId, conversationId: 'conv-1' });
  const scope = { scopeKind: 'task' as const, scopeId: task.taskId, recordObjectId: 'conv-1' };
  const first = await harness.core.confirmPaired({
    updateId: 'u1',
    ...scope,
    expected: expectationOf(harness.core, scope),
    origin: 'ai',
    record: { content: content('record v1') },
    summary: { content: content('summary v1') },
  });
  assert.equal(first.status, 'committed');
  const draft = await harness.core.saveDraft({
    kind: 'taskRecord',
    scopeKind: 'task',
    scopeId: task.taskId,
    objectId: 'conv-1',
    content: content('draft v1'),
  });

  const renamed = await harness.core.updateTaskFields({
    taskId: task.taskId,
    requestId: 'edit-rename',
    expected: { fieldsRevision: 0, statusRevision: 0 },
    title: 'Renamed',
  });
  assert.equal(renamed.status, 'saved');
  assert.equal(renamed.status === 'saved' ? renamed.recheckMarked : null, false, '普通重命名不改目标');
  const afterRename = harness.core.readTask({ taskId: task.taskId });
  assert.equal(afterRename?.needsRecheck, false, '普通重命名不整体废弃已有成果或全部记录草稿');
  assert.equal(harness.core.getDraft(draft.draftId)?.state, 'editing', 'the record draft survives a rename');
  assert.equal(
    harness.core.history({ scopeKind: 'task', scopeId: task.taskId, objectKind: 'taskSummary', objectId: task.taskId }).length,
    1,
    'existing official versions survive a rename',
  );
  assert.equal(
    harness.core.readObject({ scopeKind: 'task', scopeId: task.taskId, objectKind: 'taskSummary', objectId: task.taskId })?.content.sections[0]?.body,
    'summary v1',
  );

  // A substantive goal change does mark the affected summary.
  const goalEdit = await harness.core.updateTaskFields({
    taskId: task.taskId,
    requestId: 'edit-goal',
    expected: { fieldsRevision: 1, statusRevision: 0 },
    goal: 'Goal v2 (different scope)',
  });
  assert.equal(goalEdit.status, 'saved');
  assert.equal(goalEdit.status === 'saved' ? goalEdit.recheckMarked : null, true);
  const afterGoal = harness.core.readTask({ taskId: task.taskId });
  assert.equal(afterGoal?.needsRecheck, true, '目标实质变化标记需要核对相关概况与结论适用范围');
  assert.equal(afterGoal?.goalRevision, 1);
  assert.deepEqual(afterGoal?.recheckCodes, ['goal-changed'], 'the machine-readable reason names the goal change');
  assert.ok(
    (afterGoal?.recheckReasons ?? []).some((reason) => reason.includes('结论适用范围')),
    'and the human-readable detail explains what has to be reviewed',
  );

  // An unreconciled paired save is blocked; a reconciled one lands and clears it.
  const blocked = await harness.core.confirmPaired({
    updateId: 'u2',
    ...scope,
    expected: expectationOf(harness.core, scope),
    origin: 'ai',
    record: { content: content('record v2') },
    summary: {},
  });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.status === 'blocked' ? blocked.code : null, 'recheck-pending');
  assert.equal(blocked.status === 'blocked' ? blocked.revision : null, 1, 'the blocked save wrote no official content');

  const reconciled = await harness.core.confirmPaired({
    updateId: 'u3',
    ...scope,
    expected: expectationOf(harness.core, scope),
    origin: 'ai',
    record: { content: content('record v3') },
    summary: { confirmUnchanged: true },
  });
  assert.equal(reconciled.status, 'committed');
  const afterReconcile = harness.core.readTask({ taskId: task.taskId });
  assert.deepEqual(
    afterReconcile?.recheckCodes,
    ['draft-stale'],
    'the goal-change marker is cleared; the surviving draft, whose baseline moved, independently keeps the summary flagged (SAVE-04/05)',
  );
  await harness.core.abandonDraft(draft.draftId);
  assert.equal(
    harness.core.readTask({ taskId: task.taskId })?.needsRecheck,
    false,
    'once the stale draft is resolved the summary is clean again',
  );
});

test('REC-01/03: a failed field save keeps the official fields and retains the input as a draft that survives a restart', async () => {
  const harness = createHarness();
  await registerProject(harness, PROJECT_A, SAME_TITLE, PATH_A);
  const task = taskOf(await harness.core.createTask({ projectId: PROJECT_A, requestId: 'req-1', title: 'Untouched', goal: 'Goal' }));
  const before = harness.core.readTask({ taskId: task.taskId });
  assert.ok(before !== null);

  harness.failNext((event) => event.kind === 'update' && event.table === SCOPE);
  const failed = await harness.core.updateTaskFields({
    taskId: task.taskId,
    requestId: 'edit-fail',
    expected: { fieldsRevision: 0, statusRevision: 0 },
    title: 'Unsaved title',
  });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.status === 'failed' ? failed.code : null, 'write-failed');
  assert.equal(failed.status === 'failed' ? failed.draftPersisted : null, true);

  const afterFailure = harness.core.readTask({ taskId: task.taskId });
  assert.equal(afterFailure?.title, 'Untouched', '保存失败维持此前正式字段');
  assert.equal(afterFailure?.fieldsRevision, 0);
  assert.equal(afterFailure?.updatedAt, before.updatedAt, 'a failed save does not advance the official time');
  assert.equal(harness.core.readFieldDraft({ taskId: task.taskId })?.title, 'Unsaved title', '输入保留为草稿');

  // REC-03: the draft and the official value are both recoverable after a restart.
  const restarted = harness.restart();
  assert.equal(restarted.core.readTask({ taskId: task.taskId })?.title, 'Untouched');
  assert.equal(restarted.core.readFieldDraft({ taskId: task.taskId })?.title, 'Unsaved title');

  // The same request was never applied, so retrying it lands exactly once.
  const retry = await restarted.core.updateTaskFields({
    taskId: task.taskId,
    requestId: 'edit-fail',
    expected: { fieldsRevision: 0, statusRevision: 0 },
    title: 'Unsaved title',
  });
  assert.equal(retry.status, 'saved');
  assert.equal(retry.status === 'saved' ? retry.task.title : null, 'Unsaved title');
  assert.equal(retry.status === 'saved' ? retry.task.fieldsRevision : null, 1);
  assert.equal(restarted.core.readFieldDraft({ taskId: task.taskId }), null);

  // A subsequent discard is explicit and only clears the draft slot.
  await restarted.core.saveFieldDraft({ taskId: task.taskId, requestId: 'draft-2', title: 'Later typing' });
  assert.equal(await restarted.core.discardFieldDraft({ taskId: task.taskId }), true);
  assert.equal(restarted.core.readFieldDraft({ taskId: task.taskId }), null);
  assert.equal(restarted.core.readTask({ taskId: task.taskId })?.title, 'Unsaved title', 'discarding a draft never touches official fields');
  assert.equal(await restarted.core.discardFieldDraft({ taskId: task.taskId }), false, 'nothing to discard is not a write');
});

test('SAVE-05: a stale field baseline never overwrites a concurrent edit, and the local input is kept', async () => {
  const harness = createHarness();
  await registerProject(harness, PROJECT_A, SAME_TITLE, PATH_A);
  const task = taskOf(await harness.core.createTask({ projectId: PROJECT_A, requestId: 'req-1', title: 'Original' }));

  // Window 1 saves; window 2 still holds the baseline it read earlier.
  const winner = await harness.core.updateTaskFields({
    taskId: task.taskId,
    requestId: 'edit-win',
    expected: { fieldsRevision: 0, statusRevision: 0 },
    title: 'Winner',
  });
  assert.equal(winner.status, 'saved');
  harness.resetJournal();

  const stale = await harness.core.updateTaskFields({
    taskId: task.taskId,
    requestId: 'edit-lose',
    expected: { fieldsRevision: 0, statusRevision: 0 },
    title: 'Loser',
  });
  assert.equal(stale.status, 'baseline-changed');
  assert.equal(stale.status === 'baseline-changed' ? stale.actual.fieldsRevision : null, 1);
  assert.equal(stale.status === 'baseline-changed' ? stale.draft?.title : null, 'Loser', 'the local input is kept as a draft');
  assert.equal(stale.status === 'baseline-changed' ? stale.draftPersisted : null, true);
  assert.equal(harness.core.readTask({ taskId: task.taskId })?.title, 'Winner', '不用旧草稿覆盖新事实');
  assert.equal(harness.writes(), 1, 'only the draft slot was written; the official fields were not touched');

  // A request that was applied stays applied even after later edits (no resurrection).
  const later = await harness.core.updateTaskFields({
    taskId: task.taskId,
    requestId: 'edit-later',
    expected: { fieldsRevision: 1, statusRevision: 0 },
    title: 'Later',
  });
  assert.equal(later.status, 'saved');
  const retriedOld = await harness.core.updateTaskFields({
    taskId: task.taskId,
    requestId: 'edit-win',
    expected: { fieldsRevision: 2, statusRevision: 0 },
    title: 'Winner again',
  });
  assert.equal(retriedOld.status, 'already-applied');
  assert.equal(harness.core.readTask({ taskId: task.taskId })?.title, 'Later', 'a stale retry cannot resurrect an old value');
});

test('F01-R06/AT-29: a confirmation during a field edit never rolls the new fields back, and reports the stale baseline', async () => {
  const harness = createHarness();
  await registerProject(harness, PROJECT_A, SAME_TITLE, PATH_A);
  const task = taskOf(await harness.core.createTask({ projectId: PROJECT_A, requestId: 'req-1', title: 'Original', goal: 'Goal v1' }));
  await harness.core.linkConversation({ taskId: task.taskId, conversationId: 'conv-1' });
  const scope = { scopeKind: 'task' as const, scopeId: task.taskId, recordObjectId: 'conv-1' };

  // The review screen opens and holds both baselines.
  const expected = expectationOf(harness.core, scope);
  const fieldBaseline = { fieldsRevision: 0, statusRevision: 0 };

  // While the review is open the user edits the goal.
  const edit = await harness.core.updateTaskFields({
    taskId: task.taskId,
    requestId: 'edit-during-review',
    expected: fieldBaseline,
    goal: 'Goal v2 (edited during review)',
  });
  assert.equal(edit.status, 'saved');

  const confirmed = await harness.core.confirmPaired({
    updateId: 'u-review',
    ...scope,
    expected,
    origin: 'ai',
    record: { content: content('record from the review') },
    summary: { content: content('summary from the review') },
    fieldBaseline,
  });
  assert.equal(confirmed.status, 'committed');
  assert.equal(confirmed.status === 'committed' ? confirmed.fieldsChangedSinceBaseline : null, true, 'SAVE-05 checks 任务字段');
  assert.deepEqual(confirmed.status === 'committed' ? confirmed.fieldsBaseline : null, { fieldsRevision: 1, statusRevision: 0 });

  const after = harness.core.readTask({ taskId: task.taskId });
  assert.equal(after?.goal, 'Goal v2 (edited during review)', '记录确认不回滚字段 (F01-R06)');
  assert.equal(after?.title, 'Original');
  assert.equal(after?.fieldsRevision, 1);
  assert.equal(after?.goalRevision, 1);
  assert.equal(after?.updatedAt, edit.status === 'saved' ? edit.task.updatedAt : 'x', 'the confirmation did not touch the task record');
  assert.equal(after?.needsRecheck, false, 'the summary was updated in the same confirmation, so the marker is cleared');

  // Omitting the field baseline keeps the previous behaviour (no false alarm).
  const noBaseline = await harness.core.confirmPaired({
    updateId: 'u-no-baseline',
    ...scope,
    expected: expectationOf(harness.core, scope),
    origin: 'ai',
    record: { content: content('record v2') },
    summary: { confirmUnchanged: true },
  });
  assert.equal(noBaseline.status === 'committed' ? noBaseline.fieldsChangedSinceBaseline : null, false);
});
