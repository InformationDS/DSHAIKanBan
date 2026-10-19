/**
 * SAVE-08 / SAVE-09 / APP-07: four independent, append-only version chains, and
 * restore-as-new-version that never deletes later versions and never revives a
 * conclusion that a confirmed correction has retired.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { content, contentWith, conclusion, createHarness, expectationOf, seedTask, scopeStateOf } from './harness.ts';
import type { Harness } from './harness.ts';
import type { ObjectContent, ObjectView } from '../src/types.ts';

function confirmRecord(
  harness: Harness,
  updateId: string,
  body: ObjectContent,
  options: { readonly summaryBody?: string; readonly summaryUnchanged?: boolean } = {},
) {
  return harness.core.confirmPaired({
    updateId,
    scopeKind: 'task',
    scopeId: 'task-1',
    recordObjectId: 'conv-1',
    expected: expectationOf(harness.core, { scopeKind: 'task', scopeId: 'task-1', recordObjectId: 'conv-1' }),
    origin: 'ai',
    record: { content: body, aiDraft: `draft for ${updateId}`, userResult: `result for ${updateId}` },
    summary:
      options.summaryBody === undefined
        ? { confirmUnchanged: true }
        : { content: content(options.summaryBody) },
  });
}

async function seedChain(harness: Harness): Promise<void> {
  await seedTask(harness);
  await confirmRecord(harness, 'v1', contentWith([{ id: 's1', title: 'Stage', body: 'plan A' }], [conclusion('c1', 'login undecided', 'pending')]), {
    summaryBody: 'summary v1',
  });
  await confirmRecord(harness, 'v2', contentWith([{ id: 's1', title: 'Stage', body: 'plan B' }], [conclusion('c1', 'login decided', 'current')]), {
    summaryBody: 'summary v2',
  });
}

test('a version chain only ever appends: earlier entries are byte-identical after later confirmations (SAVE-08)', async () => {
  const harness = createHarness();
  await seedChain(harness);

  const snapshots: ObjectView[] = [];
  for (const round of ['v3', 'v4', 'v5']) {
    const outcome = await confirmRecord(harness, round, content(`${round} body`), { summaryBody: `summary ${round}` });
    assert.equal(outcome.status, 'committed');
    if (outcome.status === 'committed') {
      const recordVersionId = outcome.versions.find((version) => version.member === 'record')?.versionId ?? '';
      snapshots.push(
        harness.core.readVersion({ scopeKind: 'task', scopeId: 'task-1', objectKind: 'taskRecord', objectId: 'conv-1', versionId: recordVersionId }) as ObjectView,
      );
    }
  }

  const history = harness.core.history({ scopeKind: 'task', scopeId: 'task-1', objectKind: 'taskRecord', objectId: 'conv-1' });
  assert.equal(history.length, 5);
  assert.deepEqual(history.map((view) => view.seq), [1, 2, 3, 4, 5], 'sequence numbers stay dense');
  assert.equal(history[0]?.previousVersionId, null, 'the first version has no predecessor');
  for (let index = 1; index < history.length; index += 1) {
    assert.equal(history[index]?.previousVersionId, history[index - 1]?.versionId, 'each version links to the one before it');
  }
  // The three versions created after the seed are still exactly as they were.
  for (const snapshot of snapshots) {
    const current = harness.core.readVersion({
      scopeKind: 'task',
      scopeId: 'task-1',
      objectKind: 'taskRecord',
      objectId: 'conv-1',
      versionId: snapshot.versionId,
    });
    assert.deepEqual(current, snapshot, `version ${snapshot.versionId} was rewritten in place`);
  }
  // SAVE-08 metadata is carried per version.
  const latest = harness.core.readObject({ scopeKind: 'task', scopeId: 'task-1', objectKind: 'taskRecord', objectId: 'conv-1' });
  assert.equal(latest?.seq, 5);
  assert.equal(latest?.aiDraft, 'draft for v5');
  assert.equal(latest?.userResult, 'result for v5');
  assert.equal(latest?.origin, 'ai');
  assert.equal(latest?.source.taskId, undefined);

  // The summary chain is independent: it also has five versions here, but the
  // record chain never depends on it.
  assert.equal(harness.core.history({ scopeKind: 'task', scopeId: 'task-1', objectKind: 'taskSummary', objectId: 'task-1' }).length, 5);
  assert.equal(scopeStateOf(harness, 'task', 'task-1').revision, 5);
});

test('restore-as-new-version appends, keeps later versions, and does not revive a retired conclusion (SAVE-09, APP-07)', async () => {
  const harness = createHarness();
  await seedChain(harness);
  const chain = harness.core.readScopeState({ scopeKind: 'task', scopeId: 'task-1' });
  const v1 = chain?.chains.taskRecord['conv-1']?.[0];
  const v2 = chain?.chains.taskRecord['conv-1']?.[1];
  assert.ok(v1 !== undefined && v2 !== undefined);

  // A confirmed correction retires c1 (F09). It changes applicability only: no new body version.
  const amend = await harness.core.amendApplicability({
    updateId: 'amend-1',
    scopeKind: 'task',
    scopeId: 'task-1',
    recordObjectId: 'conv-1',
    expected: expectationOf(harness.core, { scopeKind: 'task', scopeId: 'task-1', recordObjectId: 'conv-1' }),
    origin: 'user',
    amendments: [
      {
        conclusionId: 'c1',
        targetMember: 'record',
        state: 'negated',
        affectedFragments: ['s1'],
        substitute: 'login replaced by SSO',
        sourceVersionIds: [v2.versionId],
        note: 'F09 explicit negation',
      },
    ],
  });
  assert.equal(amend.status, 'committed');
  assert.equal(scopeStateOf(harness, 'task', 'task-1').revision, 2, 'a correction alone does not add a body version (F09-R06)');
  assert.equal(scopeStateOf(harness, 'task', 'task-1').applicabilityRevision, 1);

  harness.resetJournal();
  const restored = await harness.core.restoreAsNewVersion({
    updateId: 'restore-v1',
    scopeKind: 'task',
    scopeId: 'task-1',
    recordObjectId: 'conv-1',
    versionId: v1.versionId,
    expected: expectationOf(harness.core, { scopeKind: 'task', scopeId: 'task-1', recordObjectId: 'conv-1' }),
    origin: 'user',
    summary: { confirmUnchanged: true },
  });
  assert.equal(restored.status, 'committed');
  assert.equal(harness.writes('scope_state'), 1, 'the restore is one atomic write');

  const history = harness.core.history({ scopeKind: 'task', scopeId: 'task-1', objectKind: 'taskRecord', objectId: 'conv-1' });
  assert.equal(history.length, 3, 'the restore appended a version instead of removing later ones');
  assert.equal(history[1]?.content.sections[0]?.body, 'plan B', 'the later version is still there');
  const restoredBody = harness.core.readObject({ scopeKind: 'task', scopeId: 'task-1', objectKind: 'taskRecord', objectId: 'conv-1' });
  assert.equal(restoredBody?.content.sections[0]?.body, 'plan A', 'the restored body is the new current version');
  assert.deepEqual(restoredBody?.restoredFrom, { versionId: v1.versionId, at: restoredBody?.confirmedAt });
  // APP-07: the confirmed correction still outranks the restored wording.
  assert.equal(restoredBody?.conclusions[0]?.statedState, 'pending');
  assert.equal(restoredBody?.conclusions[0]?.state, 'negated', 'restoring text must not revive a retired conclusion');

  // SAVE-09: re-adopting the old conclusion requires an explicit re-confirmation,
  // which rides the same write as the new body version.
  harness.resetJournal();
  const reconfirmed = await harness.core.restoreAsNewVersion({
    updateId: 'restore-v2',
    scopeKind: 'task',
    scopeId: 'task-1',
    recordObjectId: 'conv-1',
    versionId: v2.versionId,
    expected: expectationOf(harness.core, { scopeKind: 'task', scopeId: 'task-1', recordObjectId: 'conv-1' }),
    origin: 'user',
    summary: { confirmUnchanged: true },
    reconfirmApplicability: ['c1'],
  });
  assert.equal(reconfirmed.status, 'committed');
  assert.equal(harness.writes('scope_state'), 1, 'the body and its applicability re-confirmation land in the same atomic write');
  assert.equal(reconfirmed.status === 'committed' ? reconfirmed.amendments.length : -1, 1);
  const after = harness.core.readObject({ scopeKind: 'task', scopeId: 'task-1', objectKind: 'taskRecord', objectId: 'conv-1' });
  assert.equal(after?.content.sections[0]?.body, 'plan B');
  assert.equal(after?.conclusions[0]?.state, 'current', 'the explicit re-confirmation took effect');
  assert.equal(after?.conclusions[0]?.amendment?.note, `re-adopted from ${v2.versionId}; applicability explicitly re-confirmed (SAVE-09)`);
  assert.equal(scopeStateOf(harness, 'task', 'task-1').revision, 4);
  assert.equal(scopeStateOf(harness, 'task', 'task-1').applicabilityRevision, 2);
});

test('restoring the body that is already current is a no-change, and an unknown version is rejected', async () => {
  const harness = createHarness();
  await seedChain(harness);
  const chain = harness.core.readScopeState({ scopeKind: 'task', scopeId: 'task-1' });
  const current = chain?.chains.taskRecord['conv-1']?.[1];
  assert.ok(current !== undefined);
  const noChange = await harness.core.restoreAsNewVersion({
    updateId: 'restore-same',
    scopeKind: 'task',
    scopeId: 'task-1',
    recordObjectId: 'conv-1',
    versionId: current.versionId,
    expected: expectationOf(harness.core, { scopeKind: 'task', scopeId: 'task-1', recordObjectId: 'conv-1' }),
    origin: 'user',
    summary: { confirmUnchanged: true },
  });
  assert.equal(noChange.status, 'no-change');

  const unknown = await harness.core.restoreAsNewVersion({
    updateId: 'restore-unknown',
    scopeKind: 'task',
    scopeId: 'task-1',
    recordObjectId: 'conv-1',
    versionId: 'v1_taskRecord_nope_nope',
    expected: expectationOf(harness.core, { scopeKind: 'task', scopeId: 'task-1', recordObjectId: 'conv-1' }),
    origin: 'user',
    summary: { confirmUnchanged: true },
  });
  assert.equal(unknown.status, 'rejected');
  assert.equal(unknown.status === 'rejected' ? unknown.code : null, 'unknown-version');
});
