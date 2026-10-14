/**
 * OBJ-07 draft granularity, SAVE-01/03/10 draft lifecycle, and OBJ-06's
 * distinction between 待确认结论 (savable) and 概况待核对 (blocks the save).
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { content, contentWith, conclusion, createHarness, expectationOf, seedTask, scopeStateOf } from './harness.ts';
import { AIKANBAN_TABLES } from '../src/domainSpec.ts';

const SCOPE = AIKANBAN_TABLES.scopeState;

test('OBJ-07 granularity: one slot per conversation and per task, and manual summary drafts stay independent', async () => {
  const harness = createHarness();
  await seedTask(harness, 'task-1', 'conv-1');
  await harness.core.linkConversation({ taskId: 'task-1', conversationId: 'conv-2' });

  const first = await harness.core.saveDraft({
    kind: 'taskRecord',
    scopeKind: 'task',
    scopeId: 'task-1',
    objectId: 'conv-1',
    content: content('conv-1 draft'),
  });
  // Saving again for the same conversation replaces the SAME slot: at most one
  // active record draft per conversation.
  const replaced = await harness.core.saveDraft({
    kind: 'taskRecord',
    scopeKind: 'task',
    scopeId: 'task-1',
    objectId: 'conv-1',
    content: content('conv-1 draft v2'),
    aiDraftContent: content('AI original'),
    rejectedSections: ['s2'],
    edited: true,
  });
  assert.equal(replaced.draftId, first.draftId);
  assert.equal(replaced.createdAt, first.createdAt, 'the slot keeps its identity across edits');
  assert.equal(harness.core.listDrafts({ scopeKind: 'task', scopeId: 'task-1' }).length, 1);
  assert.deepEqual(replaced.rejectedSections, ['s2'], 'a rejected partition keeps the official value (F07-R01)');
  assert.equal(replaced.aiDraftContent?.sections[0]?.body, 'AI original', 'the AI original is kept beside the user result');

  // A different conversation is independent: no task-wide draft lock (F08-R01).
  const other = await harness.core.saveDraft({
    kind: 'taskRecord',
    scopeKind: 'task',
    scopeId: 'task-1',
    objectId: 'conv-2',
    content: content('conv-2 draft'),
  });
  assert.notEqual(other.draftId, first.draftId);

  // A manual summary draft is a separate slot and must not overwrite the record draft.
  const manual = await harness.core.saveDraft({
    kind: 'summaryDraft',
    scopeKind: 'task',
    scopeId: 'task-1',
    objectId: 'task-1',
    content: content('manual summary draft'),
  });
  assert.notEqual(manual.draftId, first.draftId);
  assert.notEqual(manual.draftId, other.draftId);
  assert.equal(harness.core.getDraft(first.draftId)?.content.sections[0]?.body, 'conv-1 draft v2');
  assert.equal(harness.core.listDrafts({ scopeKind: 'task', scopeId: 'task-1' }).length, 3);

  // Draft scoping is validated: a task-record draft cannot live in a project scope.
  await assert.rejects(
    harness.core.saveDraft({
      kind: 'taskRecord',
      scopeKind: 'project',
      scopeId: 'task-1',
      objectId: 'conv-1',
      content: content('wrong scope'),
    }),
    /belongs to a task scope/,
  );
});

test('abandoning a draft cancels only this candidate (SAVE-10) and a failed save keeps it (REC-01)', async () => {
  const harness = createHarness();
  await seedTask(harness, 'task-1', 'conv-1');
  await harness.core.linkConversation({ taskId: 'task-1', conversationId: 'conv-2' });
  const draft = await harness.core.saveDraft({
    kind: 'taskRecord',
    scopeKind: 'task',
    scopeId: 'task-1',
    objectId: 'conv-1',
    content: content('candidate with a change'),
    updateId: 'u1',
    state: 'ready',
  });
  const survivor = await harness.core.saveDraft({
    kind: 'taskRecord',
    scopeKind: 'task',
    scopeId: 'task-1',
    objectId: 'conv-2',
    content: content('other conversation candidate'),
    state: 'ready',
  });
  await harness.core.confirmPaired({
    updateId: 'seed',
    scopeKind: 'task',
    scopeId: 'task-1',
    recordObjectId: 'conv-1',
    expected: expectationOf(harness.core, { scopeKind: 'task', scopeId: 'task-1', recordObjectId: 'conv-1' }),
    origin: 'ai',
    record: { content: content('official') },
    summary: { content: content('official summary') },
  });

  // A save that fails must leave the candidate, the edits and the other draft intact.
  harness.failNext((event) => event.table === SCOPE, new Error('injected: publish failed'));
  await assert.rejects(
    harness.core.confirmPaired({
      updateId: 'u1',
      scopeKind: 'task',
      scopeId: 'task-1',
      recordObjectId: 'conv-1',
      expected: expectationOf(harness.core, { scopeKind: 'task', scopeId: 'task-1', recordObjectId: 'conv-1' }),
      origin: 'ai',
      record: { content: content('candidate with a change') },
      summary: { content: content('summary candidate') },
      consumeDraftIds: [draft.draftId],
    }),
    /publish failed/,
  );
  assert.equal(harness.core.getDraft(draft.draftId)?.state, 'ready', 'a failed save does not advance the draft');
  assert.equal(harness.core.getDraft(draft.draftId)?.content.sections[0]?.body, 'candidate with a change');
  assert.equal(harness.core.readObject({ scopeKind: 'task', scopeId: 'task-1', objectKind: 'taskRecord', objectId: 'conv-1' })?.content.sections[0]?.body, 'official');

  const abandoned = await harness.core.abandonDraft(draft.draftId);
  assert.equal(abandoned.state, 'abandoned');
  assert.equal(harness.core.getDraft(survivor.draftId)?.state, 'ready', 'abandoning one draft leaves other drafts alone');
  assert.equal(harness.core.readObject({ scopeKind: 'task', scopeId: 'task-1', objectKind: 'taskRecord', objectId: 'conv-1' })?.content.sections[0]?.body, 'official', 'abandoning never touches official content');
  assert.deepEqual(harness.core.listDrafts({ scopeKind: 'task', scopeId: 'task-1', activeOnly: true }).map((entry) => entry.draftId), [survivor.draftId]);
  assert.equal(await harness.core.deleteDraft(draft.draftId), true);
  assert.equal(harness.core.getDraft(draft.draftId), null);
});

test('a 待确认结论 saves as an undecided question, while 概况待核对 blocks the paired save (OBJ-06, APP-02, F07-R06)', async () => {
  const harness = createHarness();
  await seedTask(harness, 'task-1', 'conv-1');
  const record = contentWith(
    [{ id: 's1', title: 'Open questions', body: 'Login approach undecided' }],
    [conclusion('c-open', 'login approach undecided', 'pending')],
  );
  const saved = await harness.core.confirmPaired({
    updateId: 'with-pending-conclusion',
    scopeKind: 'task',
    scopeId: 'task-1',
    recordObjectId: 'conv-1',
    expected: expectationOf(harness.core, { scopeKind: 'task', scopeId: 'task-1', recordObjectId: 'conv-1' }),
    origin: 'ai',
    record: { content: record },
    summary: { content: contentWith([{ id: 's1', title: 'Undecided', body: 'login approach undecided' }], [conclusion('c-open', 'login approach undecided', 'pending')]) },
  });
  assert.equal(saved.status, 'committed', 'APP-02: 待确认结论 may be saved as an official undecided question');
  const view = harness.core.readObject({ scopeKind: 'task', scopeId: 'task-1', objectKind: 'taskRecord', objectId: 'conv-1' });
  assert.equal(view?.conclusions[0]?.state, 'pending');

  // The same task now has an unreconciled summary (another conversation's draft went stale).
  await harness.core.linkConversation({ taskId: 'task-1', conversationId: 'conv-2' });
  await harness.core.saveDraft({
    kind: 'taskRecord',
    scopeKind: 'task',
    scopeId: 'task-1',
    objectId: 'conv-2',
    content: content('conv-2 candidate'),
    updateId: 'later',
  });
  const before = scopeStateOf(harness, 'task', 'task-1').revision;
  const blocked = await harness.core.confirmPaired({
    updateId: 'while-pending',
    scopeKind: 'task',
    scopeId: 'task-1',
    recordObjectId: 'conv-1',
    expected: expectationOf(harness.core, { scopeKind: 'task', scopeId: 'task-1', recordObjectId: 'conv-1' }),
    origin: 'ai',
    record: { content: content('a substantive change while the summary is stale') },
    summary: {},
  });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.status === 'blocked' ? blocked.code : null, 'recheck-pending');
  assert.equal(scopeStateOf(harness, 'task', 'task-1').revision, before, 'the save gate held');

  // The pre-flight check tells the UI exactly what to fix (F08-R02).
  const baseline = harness.core.checkBaseline({
    scopeKind: 'task',
    scopeId: 'task-1',
    recordObjectId: 'conv-1',
    expected: expectationOf(harness.core, { scopeKind: 'task', scopeId: 'task-1', recordObjectId: 'conv-1' }),
  });
  assert.equal(baseline.ok, false);
  assert.deepEqual(baseline.issues.map((issue) => issue.code), ['recheck-pending']);
  assert.equal(baseline.recheck.taskSummary.pending, true);
  assert.match(baseline.issues[0]?.detail ?? '', /待核对/);

  // 手动核对完成 is a resolution, not a confirmation: no revision bump (SAVE-10),
  // and the marker really goes away because nothing else re-derives it (the
  // other conversation's draft still sits on the current baseline).
  const cleared = await harness.core.clearRecheck({ scopeKind: 'task', scopeId: 'task-1', target: 'taskSummary' });
  assert.equal(cleared.taskSummary.pending, false, 'F07-R05: the manual path clears the marker without AI');
  assert.equal(scopeStateOf(harness, 'task', 'task-1').revision, before);

  const after = harness.core.checkBaseline({
    scopeKind: 'task',
    scopeId: 'task-1',
    recordObjectId: 'conv-1',
    expected: expectationOf(harness.core, { scopeKind: 'task', scopeId: 'task-1', recordObjectId: 'conv-1' }),
  });
  assert.equal(after.ok, true, 'after the manual reconciliation the save gate is open');
  assert.equal(after.issues.length, 0);
});

test('the pre-flight baseline check reports a moved revision, a moved member and a missing scope', async () => {
  const harness = createHarness();
  await seedTask(harness);
  const before = expectationOf(harness.core, { scopeKind: 'task', scopeId: 'task-1', recordObjectId: 'conv-1' });
  await harness.core.confirmPaired({
    updateId: 'u1',
    scopeKind: 'task',
    scopeId: 'task-1',
    recordObjectId: 'conv-1',
    expected: before,
    origin: 'ai',
    record: { content: content('record') },
    summary: { content: content('summary') },
  });

  const stale = harness.core.checkBaseline({ scopeKind: 'task', scopeId: 'task-1', recordObjectId: 'conv-1', expected: before });
  assert.equal(stale.ok, false);
  assert.deepEqual(
    [...new Set(stale.issues.map((issue) => issue.code))].sort(),
    ['member-base-changed', 'revision-changed'],
    'both a moved revision and moved member versions are reported',
  );
  assert.equal(stale.issues.filter((issue) => issue.code === 'member-base-changed').length, 2, 'one issue per member');
  assert.equal(stale.actual?.revision, 1);

  const fresh = harness.core.checkBaseline({
    scopeKind: 'task',
    scopeId: 'task-1',
    recordObjectId: 'conv-1',
    expected: expectationOf(harness.core, { scopeKind: 'task', scopeId: 'task-1', recordObjectId: 'conv-1' }),
  });
  assert.equal(fresh.ok, true);
  assert.deepEqual(fresh.issues, []);

  const missing = harness.core.checkBaseline({ scopeKind: 'task', scopeId: 'nope', recordObjectId: 'conv-1', expected: before });
  assert.equal(missing.actual, null);
  assert.deepEqual(missing.issues.map((issue) => issue.code), ['scope-missing']);
  assert.equal(harness.core.readPair({ scopeKind: 'task', scopeId: 'nope', recordObjectId: 'c' }), null);
});
