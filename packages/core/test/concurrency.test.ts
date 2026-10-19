/**
 * SAVE-06 / F08-R06 / REC-04: one updateId produces exactly one result, and two
 * competing updates never lose a draft. No lock is taken anywhere.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { AIKANBAN_TABLES } from '../src/domainSpec.ts';
import { content, expectationOf, createHarness, seedTask, scopeStateOf } from './harness.ts';
import type { Harness } from './harness.ts';
import type { ConfirmOutcome } from '../src/types.ts';

const SCOPE = AIKANBAN_TABLES.scopeState;

function confirmation(harness: Harness, updateId: string, conversationId: string, recordBody: string, summaryBody: string) {
  return harness.core.confirmPaired({
    updateId,
    scopeKind: 'task',
    scopeId: 'task-1',
    recordObjectId: conversationId,
    expected: expectationOf(harness.core, { scopeKind: 'task', scopeId: 'task-1', recordObjectId: conversationId }),
    origin: 'ai',
    record: { content: content(recordBody) },
    summary: { content: content(summaryBody) },
  });
}

test('the same updateId submitted N times concurrently produces exactly one version (SAVE-06)', async () => {
  const harness = createHarness();
  await seedTask(harness);
  const expected = expectationOf(harness.core, { scopeKind: 'task', scopeId: 'task-1', recordObjectId: 'conv-1' });
  const submissions = 24;
  const outcomes: ConfirmOutcome[] = await Promise.all(
    Array.from({ length: submissions }, () =>
      harness.core.confirmPaired({
        updateId: 'double-click',
        scopeKind: 'task',
        scopeId: 'task-1',
        recordObjectId: 'conv-1',
        expected,
        origin: 'ai',
        record: { content: content('record once') },
        summary: { content: content('summary once') },
      }),
    ),
  );

  const committed = outcomes.filter((outcome) => outcome.status === 'committed');
  const alreadyApplied = outcomes.filter((outcome) => outcome.status === 'already-applied');
  assert.equal(committed.length, 1, 'exactly one caller committed');
  assert.equal(alreadyApplied.length, submissions - 1, 'every other entry point saw the already-processed result (F08-R06)');
  assert.equal(scopeStateOf(harness, 'task', 'task-1').revision, 1);
  assert.equal(harness.core.history({ scopeKind: 'task', scopeId: 'task-1', objectKind: 'taskRecord', objectId: 'conv-1' }).length, 1);
  assert.equal(harness.core.history({ scopeKind: 'task', scopeId: 'task-1', objectKind: 'taskSummary', objectId: 'task-1' }).length, 1);
  const versionIds = new Set(
    outcomes.flatMap((outcome) => ('versions' in outcome ? outcome.versions.map((version) => version.versionId) : [])),
  );
  assert.equal(versionIds.size, 2, 'both callers agree on the same two version ids');
  assert.equal(
    committed.filter((outcome) => outcome.status === 'committed' && outcome.versions.length === 2).length,
    1,
  );
});

test('a sequential retry of the same updateId returns the recorded result, never a second version', async () => {
  const harness = createHarness();
  await seedTask(harness);
  const first = await confirmation(harness, 'retry-me', 'conv-1', 'record a', 'summary a');
  assert.equal(first.status, 'committed');
  harness.resetJournal();
  // Same identity, different payload: SAVE-06 says the real result is returned.
  const retry = await harness.core.confirmPaired({
    updateId: 'retry-me',
    scopeKind: 'task',
    scopeId: 'task-1',
    recordObjectId: 'conv-1',
    expected: { revision: 99, applicabilityRevision: 99, baseVersionIds: {} },
    origin: 'user',
    record: { content: content('record b') },
    summary: { content: content('summary b') },
  });
  assert.equal(retry.status, 'already-applied');
  assert.equal(retry.status === 'already-applied' ? retry.appliedRevision : -1, 1);
  assert.equal(retry.status === 'already-applied' ? retry.versions.length : -1, 2);
  assert.equal(harness.writes(SCOPE), 0, 'an already-processed entry point does not write again');
  assert.equal(harness.core.readObject({ scopeKind: 'task', scopeId: 'task-1', objectKind: 'taskRecord', objectId: 'conv-1' })?.content.sections[0]?.body, 'record a');
});

test('two different updates competing for the same summary: one commits, the other must re-check, both drafts survive (SAVE-05, F08-R06, REC-04)', async () => {
  const harness = createHarness();
  await seedTask(harness, 'task-1', 'conv-1');
  await harness.core.linkConversation({ taskId: 'task-1', conversationId: 'conv-2' });

  // Both conversations hold an independent draft, so nothing may discard them.
  const draftA = await harness.core.saveDraft({
    kind: 'taskRecord',
    scopeKind: 'task',
    scopeId: 'task-1',
    objectId: 'conv-1',
    content: content('conv-1 candidate'),
    updateId: 'update-A',
    state: 'ready',
  });
  const draftB = await harness.core.saveDraft({
    kind: 'taskRecord',
    scopeKind: 'task',
    scopeId: 'task-1',
    objectId: 'conv-2',
    content: content('conv-2 candidate'),
    updateId: 'update-B',
    state: 'ready',
  });
  assert.notEqual(draftA.draftId, draftB.draftId, 'OBJ-07: each conversation has its own draft slot, no task-wide lock');

  const expectedA = expectationOf(harness.core, { scopeKind: 'task', scopeId: 'task-1', recordObjectId: 'conv-1' });
  const expectedB = expectationOf(harness.core, { scopeKind: 'task', scopeId: 'task-1', recordObjectId: 'conv-2' });
  const [outcomeA, outcomeB] = await Promise.all([
    harness.core.confirmPaired({
      updateId: 'update-A',
      scopeKind: 'task',
      scopeId: 'task-1',
      recordObjectId: 'conv-1',
      expected: expectedA,
      origin: 'ai',
      record: { content: content('conv-1 official') },
      summary: { content: content('summary from A') },
    }),
    harness.core.confirmPaired({
      updateId: 'update-B',
      scopeKind: 'task',
      scopeId: 'task-1',
      recordObjectId: 'conv-2',
      expected: expectedB,
      origin: 'ai',
      record: { content: content('conv-2 official') },
      summary: { content: content('summary from B') },
    }),
  ]);

  const statuses = [outcomeA.status, outcomeB.status].sort();
  assert.deepEqual(statuses, ['blocked', 'committed'], 'exactly one of the two competing updates takes effect');
  const loser = outcomeA.status === 'blocked' ? outcomeA : outcomeB;
  const winnerUpdateId = outcomeA.status === 'committed' ? 'update-A' : 'update-B';
  const loserDraft = winnerUpdateId === 'update-A' ? draftB : draftA;
  const winnerDraft = winnerUpdateId === 'update-A' ? draftA : draftB;
  assert.equal(loser.status === 'blocked' ? loser.code : null, 'baseline-changed');
  assert.deepEqual(loser.status === 'blocked' ? loser.needsRecheck : [], ['taskSummary'], 'only the affected summary must be re-checked');
  assert.ok(
    loser.status === 'blocked' && loser.preservedDraftIds.includes(loserDraft.draftId),
    'the losing draft is preserved; F08-R06 forbids discarding it',
  );

  // Nothing was deleted: the winner's draft was consumed by its own commit, the
  // loser's draft is untouched and still carries its candidate text.
  assert.equal(harness.core.getDraft(winnerDraft.draftId)?.state, 'saved');
  assert.deepEqual(harness.core.getDraft(winnerDraft.draftId)?.consumedBy, { updateId: winnerUpdateId, revision: 1 });
  assert.equal(harness.core.getDraft(loserDraft.draftId)?.state, 'ready');
  assert.equal(harness.core.getDraft(loserDraft.draftId)?.content.sections[0]?.body, 'conv-2 candidate');

  // The summary is marked 待核对, derived from the stale draft (no discarded draft needed).
  const recheck = harness.core.readRecheck({ scopeKind: 'task', scopeId: 'task-1' });
  assert.equal(recheck.taskSummary.pending, true);
  assert.equal(recheck.staleDrafts.length, 1, 'the draft that did not commit is stale against the new baseline');
  assert.equal(recheck.staleDrafts[0]?.draftId, loserDraft.draftId);

  // The loser's own record is untouched by the winner.
  assert.equal(harness.core.readObject({ scopeKind: 'task', scopeId: 'task-1', objectKind: 'taskRecord', objectId: 'conv-2' }), null);
  assert.equal(scopeStateOf(harness, 'task', 'task-1').revision, 1);
});

test('an unresolved 待核对 blocks the official save, and re-checking against the current baseline lets it through (F07-R06)', async () => {
  const harness = createHarness();
  await seedTask(harness, 'task-1', 'conv-1');
  await harness.core.linkConversation({ taskId: 'task-1', conversationId: 'conv-2' });
  const draftB = await harness.core.saveDraft({
    kind: 'taskRecord',
    scopeKind: 'task',
    scopeId: 'task-1',
    objectId: 'conv-2',
    content: content('conv-2 candidate'),
    updateId: 'update-B',
  });
  const winner = await confirmation(harness, 'update-A', 'conv-1', 'conv-1 official', 'summary A');
  assert.equal(winner.status, 'committed');

  // conv-2 tries to save while the summary is 待核对 and leaves the summary
  // side unreconciled: F07-R06 requires the save to be blocked, not applied.
  harness.resetJournal();
  const blocked = await harness.core.confirmPaired({
    updateId: 'update-B',
    scopeKind: 'task',
    scopeId: 'task-1',
    recordObjectId: 'conv-2',
    expected: expectationOf(harness.core, { scopeKind: 'task', scopeId: 'task-1', recordObjectId: 'conv-2' }),
    origin: 'ai',
    record: { content: content('conv-2 official') },
    summary: {},
  });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.status === 'blocked' ? blocked.code : null, 'recheck-pending');
  assert.equal(blocked.status === 'blocked' ? blocked.recheckPersisted : null, true, 'the 待核对 marker is durable, not just derived');
  // A blocked confirmation may write the marker, but never official content.
  const blockedWrites = harness.port.journal.filter((event) => event.ok && event.table === SCOPE);
  assert.ok(blockedWrites.every((event) => event.kind === 'update'), 'a blocked attempt only updates the head record, never publishes a version');
  assert.equal(scopeStateOf(harness, 'task', 'task-1').revision, 1, 'no revision was consumed by the blocked attempt');
  assert.equal(harness.core.history({ scopeKind: 'task', scopeId: 'task-1', objectKind: 'taskRecord', objectId: 'conv-2' }).length, 0);
  assert.equal(
    harness.core.readObject({ scopeKind: 'task', scopeId: 'task-1', objectKind: 'taskRecord', objectId: 'conv-2' }),
    null,
    'F08-R07: no half-published result and no official record for the blocked side',
  );

  // F07-R05: a manual reconciliation fixes the gate without AI and without a version.
  await harness.core.clearRecheck({ scopeKind: 'task', scopeId: 'task-1', target: 'taskSummary' });
  assert.equal(harness.core.readRecheck({ scopeKind: 'task', scopeId: 'task-1' }).taskSummary.pending, true, 'a stale draft re-derives the marker until it is resolved');

  // Re-check against the current baseline: a fresh summary candidate resolves it.
  const resolved = await harness.core.confirmPaired({
    updateId: 'update-B2',
    scopeKind: 'task',
    scopeId: 'task-1',
    recordObjectId: 'conv-2',
    expected: expectationOf(harness.core, { scopeKind: 'task', scopeId: 'task-1', recordObjectId: 'conv-2' }),
    origin: 'ai',
    record: { content: content('conv-2 official') },
    summary: { content: content('summary from A plus conv-2') },
    consumeDraftIds: [draftB.draftId],
  });
  assert.equal(resolved.status, 'committed');
  assert.equal(scopeStateOf(harness, 'task', 'task-1').revision, 2);
  assert.equal(harness.core.readRecheck({ scopeKind: 'task', scopeId: 'task-1' }).taskSummary.pending, false);
  assert.equal(harness.core.readObject({ scopeKind: 'task', scopeId: 'task-1', objectKind: 'taskSummary', objectId: 'task-1' })?.content.sections[0]?.body, 'summary from A plus conv-2');
});

test('确认概况无需修改 (F07-R05) resolves a 待核对 summary and lets the record save in the same write', async () => {
  const harness = createHarness();
  await seedTask(harness, 'task-1', 'conv-1');
  await harness.core.linkConversation({ taskId: 'task-1', conversationId: 'conv-2' });
  await harness.core.saveDraft({
    kind: 'taskRecord',
    scopeKind: 'task',
    scopeId: 'task-1',
    objectId: 'conv-2',
    content: content('conv-2 candidate'),
  });
  assert.equal((await confirmation(harness, 'a1', 'conv-1', 'r1', 's1')).status, 'committed');

  harness.resetJournal();
  const outcome = await harness.core.confirmPaired({
    updateId: 'b1',
    scopeKind: 'task',
    scopeId: 'task-1',
    recordObjectId: 'conv-2',
    expected: expectationOf(harness.core, { scopeKind: 'task', scopeId: 'task-1', recordObjectId: 'conv-2' }),
    origin: 'user',
    record: { content: content('conv-2 official') },
    summary: { confirmUnchanged: true },
    consumeDraftIds: [harness.core.draftIdFor({ kind: 'taskRecord', scopeKind: 'task', scopeId: 'task-1', objectId: 'conv-2' })],
  });
  assert.equal(outcome.status, 'committed');
  assert.equal(harness.writes(SCOPE), 1, 'the reconciliation and the record version land in one write');
  assert.deepEqual(outcome.status === 'committed' ? outcome.changed : [], ['record']);
  assert.equal(harness.core.readRecheck({ scopeKind: 'task', scopeId: 'task-1' }).taskSummary.pending, false);
});

test('an unresolved summary in one task does not block work in another task (REC-04: no project-wide lock)', async () => {
  const harness = createHarness();
  await seedTask(harness, 'task-1', 'conv-1');
  await harness.core.linkConversation({ taskId: 'task-1', conversationId: 'conv-2' });
  await harness.core.saveDraft({
    kind: 'taskRecord',
    scopeKind: 'task',
    scopeId: 'task-1',
    objectId: 'conv-2',
    content: content('conv-2 candidate'),
  });
  assert.equal((await confirmation(harness, 'a1', 'conv-1', 'r1', 's1')).status, 'committed');
  assert.equal(harness.core.readRecheck({ scopeKind: 'task', scopeId: 'task-1' }).taskSummary.pending, true);

  await seedTask(harness, 'task-2', 'conv-9');
  const other = await harness.core.confirmPaired({
    updateId: 'a2',
    scopeKind: 'task',
    scopeId: 'task-2',
    recordObjectId: 'conv-9',
    expected: expectationOf(harness.core, { scopeKind: 'task', scopeId: 'task-2', recordObjectId: 'conv-9' }),
    origin: 'user',
    record: { content: content('unrelated record') },
    summary: { content: content('unrelated summary') },
  });
  assert.equal(other.status, 'committed', 'a pending re-check is scoped to its own pair, not global');
  assert.equal(scopeStateOf(harness, 'task', 'task-2').revision, 1);
});
