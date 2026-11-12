/**
 * F03-R01/R02/R03/R04/R07: a manual summary / project overview is an
 * independent, user-authored body on the scope's existing summary chain.
 *
 * It is deliberately not a paired confirmation: no conversation or outcome
 * task has to exist, the fixed-attribution link check never runs, and a save
 * touches only the summary chain/current/revision/activity of ONE scope.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { AIKANBAN_TABLES } from '../src/domainSpec.ts';
import type { SummaryBaseline, SummaryView } from '../src/types.ts';
import { content, createHarness, seedProject, seedTask, scopeStateOf } from './harness.ts';
import type { Harness } from './harness.ts';

const SCOPE = AIKANBAN_TABLES.scopeState;

function baselineOf(harness: Harness, scopeKind: 'task' | 'project', scopeId: string): SummaryBaseline {
  const view = harness.core.readSummary({ scopeKind, scopeId });
  if (view === null) throw new Error(`no ${scopeKind} scope ${scopeId}`);
  return view.baseline;
}

function summaryOf(harness: Harness, scopeKind: 'task' | 'project', scopeId: string): SummaryView {
  const view = harness.core.readSummary({ scopeKind, scopeId });
  if (view === null) throw new Error(`no ${scopeKind} scope ${scopeId}`);
  return view;
}

test('F03-R01: a task overview saves on a scope with no conversation and no finished task', async () => {
  const harness = createHarness();
  await harness.core.ensureScope({ scopeKind: 'task', scopeId: 'task-1' });
  harness.resetJournal();

  const outcome = await harness.core.saveManualSummary({
    updateId: 'manual-1',
    scopeKind: 'task',
    scopeId: 'task-1',
    expected: baselineOf(harness, 'task', 'task-1'),
    content: content('手动写下的概况：先做存储，再做界面。'),
  });

  assert.equal(outcome.status, 'committed');
  assert.equal(harness.writes(SCOPE), 1, 'one manual summary save is one scope write');  const view = summaryOf(harness, 'task', 'task-1');
  assert.equal(view.revision, 1);
  assert.equal(view.current?.content.sections[0]?.body, '手动写下的概况：先做存储，再做界面。');
  assert.equal(view.current?.changeKind, 'created');
  assert.equal(view.current?.origin, 'user');
  assert.equal(view.current?.source.generator, 'manual');
  assert.equal(view.current?.source.taskId, 'task-1');
  assert.equal(view.history.length, 1);
  assert.equal(view.draft, null);

  // The paired-record/outcome link tables stay empty: nothing was faked.
  const scope = scopeStateOf(harness, 'task', 'task-1');
  assert.deepEqual(scope.links.conversations, {});
  assert.deepEqual(scope.links.outcomeTasks, {});
  assert.equal(Object.keys(scope.chains.taskRecord).length, 0, 'no record chain is created');
  assert.equal(scope.task, null);
});

test('F03-R01: a project overview saves on a scope with no linked outcome task', async () => {
  const harness = createHarness();
  await harness.core.ensureScope({ scopeKind: 'project', scopeId: 'proj-1' });

  const outcome = await harness.core.saveManualSummary({
    updateId: 'manual-p1',
    scopeKind: 'project',
    scopeId: 'proj-1',
    expected: baselineOf(harness, 'project', 'proj-1'),
    content: content('项目总览：三条线并行，先完成契约层。'),
  });

  assert.equal(outcome.status, 'committed');
  const view = summaryOf(harness, 'project', 'proj-1');
  assert.equal(view.current?.source.generator, 'manual');
  assert.equal(view.current?.source.projectId, 'proj-1');
  assert.equal(Object.keys(scopeStateOf(harness, 'project', 'proj-1').links.outcomeTasks).length, 0);
});

test('F03-R02: a substantive edit produces the next version and keeps the previous one', async () => {
  const harness = createHarness();
  await seedTask(harness);

  const first = await harness.core.saveManualSummary({
    updateId: 'manual-1',
    scopeKind: 'task',
    scopeId: 'task-1',
    expected: baselineOf(harness, 'task', 'task-1'),
    content: content('第一版概况。'),
  });
  assert.equal(first.status, 'committed');
  const firstVersionId = first.status === 'committed' ? first.versionId : '';

  const second = await harness.core.saveManualSummary({
    updateId: 'manual-2',
    scopeKind: 'task',
    scopeId: 'task-1',
    expected: baselineOf(harness, 'task', 'task-1'),
    content: content('第二版概况：补上风险。'),
  });
  assert.equal(second.status, 'committed');
  assert.equal(second.status === 'committed' ? second.changeKind : '', 'modified');

  const view = summaryOf(harness, 'task', 'task-1');
  assert.equal(view.revision, 2);
  assert.equal(view.history.length, 2);
  assert.equal(view.history[0]?.content.sections[0]?.body, '第二版概况：补上风险。', 'history is newest first');
  assert.equal(view.history[1]?.versionId, firstVersionId);
  assert.equal(view.history[0]?.previousVersionId, firstVersionId);
  assert.equal(view.history[0]?.seq, 2);
  assert.equal(view.baseline.summaryVersionId, view.current?.versionId ?? null);
});

test('F03-R02: re-saving the same body with a fresh updateId is no-change and creates no version', async () => {
  const harness = createHarness();
  await seedTask(harness);

  await harness.core.saveManualSummary({
    updateId: 'manual-1',
    scopeKind: 'task',
    scopeId: 'task-1',
    expected: baselineOf(harness, 'task', 'task-1'),
    content: content('同一份概况。'),
  });
  harness.resetJournal();

  const same = await harness.core.saveManualSummary({
    updateId: 'manual-2',
    scopeKind: 'task',
    scopeId: 'task-1',
    expected: baselineOf(harness, 'task', 'task-1'),
    content: content('同一份概况。'),
  });

  assert.equal(same.status, 'no-change');
  assert.equal(summaryOf(harness, 'task', 'task-1').revision, 1);
  assert.equal(summaryOf(harness, 'task', 'task-1').history.length, 1);
  assert.equal(harness.port.journal.filter((event) => event.kind === 'put').length, 0, 'no-change publishes nothing');
});

test('F03-R05 boundary: clearing the body is an explicit cleared version', async () => {
  const harness = createHarness();
  await seedTask(harness);
  await harness.core.saveManualSummary({
    updateId: 'manual-1',
    scopeKind: 'task',
    scopeId: 'task-1',
    expected: baselineOf(harness, 'task', 'task-1'),
    content: content('先写一版。'),
  });

  const cleared = await harness.core.saveManualSummary({
    updateId: 'manual-2',
    scopeKind: 'task',
    scopeId: 'task-1',
    expected: baselineOf(harness, 'task', 'task-1'),
    cleared: true,
  });

  assert.equal(cleared.status, 'committed');
  assert.equal(cleared.status === 'committed' ? cleared.changeKind : '', 'cleared');
  const view = summaryOf(harness, 'task', 'task-1');
  assert.equal(view.current?.content.sections.length, 0);
  assert.equal(view.history.length, 2);
  assert.equal(view.history[1]?.content.sections[0]?.body, '先写一版。');
});

test('F03-R04: a stale baseline is blocked with the actual baseline and publishes nothing', async () => {
  const harness = createHarness();
  await seedTask(harness);
  const stale = baselineOf(harness, 'task', 'task-1');
  await harness.core.saveManualSummary({
    updateId: 'manual-1',
    scopeKind: 'task',
    scopeId: 'task-1',
    expected: stale,
    content: content('第一版。'),
  });
  harness.resetJournal();

  const blocked = await harness.core.saveManualSummary({
    updateId: 'manual-stale',
    scopeKind: 'task',
    scopeId: 'task-1',
    expected: stale, // the pre-save baseline
    content: content('基于旧基线的修改。'),
  });

  assert.equal(blocked.status, 'blocked');
  if (blocked.status === 'blocked') {
    assert.equal(blocked.code, 'baseline-changed');
    assert.equal(blocked.expected, stale);
    assert.equal(blocked.actual.revision, stale.revision + 1);
    assert.equal(blocked.actual.summaryVersionId, summaryOf(harness, 'task', 'task-1').current?.versionId);
  }
  assert.equal(harness.port.journal.filter((event) => event.kind === 'put').length, 0);
  assert.equal(summaryOf(harness, 'task', 'task-1').revision, 1);
  assert.equal(summaryOf(harness, 'task', 'task-1').history.length, 1);
});

test('F03-R07: the same updateId retried with different content is already-applied, not a second version', async () => {
  const harness = createHarness();
  await seedTask(harness);

  const first = await harness.core.saveManualSummary({
    updateId: 'manual-1',
    scopeKind: 'task',
    scopeId: 'task-1',
    expected: baselineOf(harness, 'task', 'task-1'),
    content: content('双击第一次的正文。'),
  });
  assert.equal(first.status, 'committed');
  const versionId = first.status === 'committed' ? first.versionId : '';

  const retry = await harness.core.saveManualSummary({
    updateId: 'manual-1',
    scopeKind: 'task',
    scopeId: 'task-1',
    expected: baselineOf(harness, 'task', 'task-1'),
    content: content('重试时误改的正文。'),
  });

  assert.equal(retry.status, 'already-applied');
  if (retry.status === 'already-applied') {
    assert.equal(retry.versionId, versionId);
    assert.equal(retry.appliedRevision, 1);
  }
  const view = summaryOf(harness, 'task', 'task-1');
  assert.equal(view.revision, 1);
  assert.equal(view.history.length, 1);
  assert.equal(view.current?.content.sections[0]?.body, '双击第一次的正文。');
  assert.equal(view.current?.versionId, versionId);
});

test('F03-R07: a committed save consumes only the manual drafts it names, after the commit', async () => {
  const harness = createHarness();
  await seedTask(harness);
  const draft = await harness.core.saveDraft({
    kind: 'summaryDraft',
    scopeKind: 'task',
    scopeId: 'task-1',
    objectId: 'task-1',
    content: content('草稿里的正文。'),
    updateId: 'draft-1',
  });

  const outcome = await harness.core.saveManualSummary({
    updateId: 'manual-1',
    scopeKind: 'task',
    scopeId: 'task-1',
    expected: baselineOf(harness, 'task', 'task-1'),
    content: content('正式保存的正文。'),
    consumeDraftIds: [draft.draftId],
  });

  assert.equal(outcome.status, 'committed');
  assert.deepEqual(outcome.status === 'committed' ? outcome.consumedDraftIds : [], [draft.draftId]);
  const consumed = harness.core.getDraft(draft.draftId);
  assert.equal(consumed?.state, 'saved');
  assert.equal(consumed?.consumedBy?.updateId, 'manual-1');
  assert.equal(summaryOf(harness, 'task', 'task-1').draft, null);
});

test('F03-R07: no-change and blocked saves never consume the draft', async () => {
  const harness = createHarness();
  await seedTask(harness);
  await harness.core.saveManualSummary({
    updateId: 'manual-0',
    scopeKind: 'task',
    scopeId: 'task-1',
    expected: baselineOf(harness, 'task', 'task-1'),
    content: content('草稿里的正文。'),
  });
  const draft = await harness.core.saveDraft({
    kind: 'summaryDraft',
    scopeKind: 'task',
    scopeId: 'task-1',
    objectId: 'task-1',
    content: content('草稿里的正文。'),
    updateId: 'draft-1',
  });

  const blocked = await harness.core.saveManualSummary({
    updateId: 'manual-stale',
    scopeKind: 'task',
    scopeId: 'task-1',
    expected: { revision: 9, applicabilityRevision: 0, summaryVersionId: null },
    content: content('基于旧基线。'),
    consumeDraftIds: [draft.draftId],
  });
  assert.equal(blocked.status, 'blocked');
  assert.equal(harness.core.getDraft(draft.draftId)?.state, 'editing');

  const noChange = await harness.core.saveManualSummary({
    updateId: 'manual-1',
    scopeKind: 'task',
    scopeId: 'task-1',
    expected: baselineOf(harness, 'task', 'task-1'),
    content: content('草稿里的正文。'),
    consumeDraftIds: [draft.draftId],
  });
  assert.equal(noChange.status, 'no-change');
  assert.equal(harness.core.getDraft(draft.draftId)?.state, 'editing');
  assert.equal(summaryOf(harness, 'task', 'task-1').draft?.draftId, draft.draftId, 'the active manual draft is still listed');
});

test('F03-R03: saving a task summary never touches task fields, status, title or goal', async () => {
  const harness = createHarness();
  const registered = await harness.core.registerProject({ projectId: 'proj-1', title: 'P', path: 'C:\\work\\p' });
  assert.equal(registered.status, 'registered');
  const created = await harness.core.createTask({
    projectId: 'proj-1',
    requestId: 'req-1',
    title: '原始标题',
    goal: '原始目标',
  });
  assert.equal(created.status, 'created');
  const taskId = created.status === 'created' ? created.taskId : '';
  const before = scopeStateOf(harness, 'task', taskId);
  assert.ok(before.task !== null);
  const fieldsBefore = before.task.fieldsRevision;
  const statusBefore = before.task.statusRevision;

  const outcome = await harness.core.saveManualSummary({
    updateId: 'manual-1',
    scopeKind: 'task',
    scopeId: taskId,
    expected: baselineOf(harness, 'task', taskId),
    content: content('只改概况，不改任务字段。'),
  });
  assert.equal(outcome.status, 'committed');

  const after = scopeStateOf(harness, 'task', taskId);
  assert.ok(after.task !== null);
  assert.equal(after.task.title, '原始标题');
  assert.equal(after.task.goal, '原始目标');
  assert.equal(after.task.fieldsRevision, fieldsBefore);
  assert.equal(after.task.statusRevision, statusBefore);
  assert.equal(after.task.status, 'todo');
  assert.equal(Object.keys(after.chains.taskRecord).length, 0, 'the taskRecord chain is untouched');
  assert.equal(after.chains.taskSummary[taskId]?.length, 1);
});

test('F03-R02/R07: the activity feed records one summary-saved entry with details', async () => {
  const harness = createHarness();
  await seedTask(harness);

  const outcome = await harness.core.saveManualSummary({
    updateId: 'manual-1',
    scopeKind: 'task',
    scopeId: 'task-1',
    expected: baselineOf(harness, 'task', 'task-1'),
    content: content('活动记录用正文。'),
  });
  assert.equal(outcome.status, 'committed');

  const activity = harness.core.readActivity({ scopeKind: 'task', scopeId: 'task-1' });
  const saved = activity.find((entry) => entry.code === 'summary-saved');
  assert.ok(saved !== undefined, 'summary-saved is in the activity feed');
  assert.equal(saved?.details.updateId, 'manual-1');
  assert.equal(saved?.details.changeKind, 'created');
  assert.equal(saved?.details.generator, 'manual');
  assert.equal(saved?.details.revision, '1');
  assert.equal(saved?.summary, '已保存手动任务概况（第 1 次提交）');
});

test('unknown scope and malformed input are rejected without a write', async () => {
  const harness = createHarness();

  const unknown = await harness.core.saveManualSummary({
    updateId: 'manual-1',
    scopeKind: 'task',
    scopeId: 'missing',
    expected: { revision: 0, applicabilityRevision: 0, summaryVersionId: null },
    content: content('x'),
  });
  assert.equal(unknown.status, 'rejected');
  assert.equal(unknown.status === 'rejected' ? unknown.code : '', 'unknown-scope');

  await seedTask(harness);
  const both = await harness.core.saveManualSummary({
    updateId: 'manual-1',
    scopeKind: 'task',
    scopeId: 'task-1',
    expected: baselineOf(harness, 'task', 'task-1'),
    content: content('x'),
    cleared: true,
  });
  assert.equal(both.status, 'rejected');
  assert.equal(both.status === 'rejected' ? both.code : '', 'invalid-input');

  const neither = await harness.core.saveManualSummary({
    updateId: 'manual-2',
    scopeKind: 'task',
    scopeId: 'task-1',
    expected: baselineOf(harness, 'task', 'task-1'),
  });
  assert.equal(neither.status, 'rejected');
  assert.equal(neither.status === 'rejected' ? neither.code : '', 'invalid-input');
  assert.equal(summaryOf(harness, 'task', 'task-1').current, null);
});

test('a manual summary survives a restart', async () => {
  const harness = createHarness();
  await seedTask(harness);
  await harness.core.saveManualSummary({
    updateId: 'manual-1',
    scopeKind: 'task',
    scopeId: 'task-1',
    expected: baselineOf(harness, 'task', 'task-1'),
    content: content('重启后仍可见。'),
  });

  const restarted = harness.restart();
  const view = restarted.core.readSummary({ scopeKind: 'task', scopeId: 'task-1' });
  assert.equal(view?.current?.content.sections[0]?.body, '重启后仍可见。');
  assert.equal(view?.history.length, 1);
  assert.equal(view?.baseline.revision, view?.revision);
  assert.equal(restarted.core.readSummary({ scopeKind: 'task', scopeId: 'nope' }), null);
});

test('a project overview save leaves the project record chain alone', async () => {
  const harness = createHarness();
  await seedProject(harness);

  const outcome = await harness.core.saveManualSummary({
    updateId: 'manual-p1',
    scopeKind: 'project',
    scopeId: 'proj-1',
    expected: baselineOf(harness, 'project', 'proj-1'),
    content: content('只用人工总览，不碰 AI 记录。'),
  });
  assert.equal(outcome.status, 'committed');

  const scope = scopeStateOf(harness, 'project', 'proj-1');
  assert.equal(Object.keys(scope.chains.projectRecord).length, 0);
  assert.equal(scope.chains.projectOverview['proj-1']?.length, 1);
  assert.equal(scope.project, null);
});
