/**
 * SAVE-02 / SAVE-06 / F06-R07 / F08-R07: one paired confirmation is one
 * atomic write, and a failure can never publish half a pair.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { AIKANBAN_TABLES } from '../src/domainSpec.ts';
import { conclusion, content, contentWith, expectationOf, createHarness, seedTask, scopeStateOf } from './harness.ts';

const SCOPE = AIKANBAN_TABLES.scopeState;

test('one confirmation writes exactly one record, and both members become official together', async () => {
  const harness = createHarness();
  await seedTask(harness);
  const expected = expectationOf(harness.core, { scopeKind: 'task', scopeId: 'task-1', recordObjectId: 'conv-1' });

  harness.resetJournal();
  const outcome = await harness.core.confirmPaired({
    updateId: 'update-1',
    scopeKind: 'task',
    scopeId: 'task-1',
    recordObjectId: 'conv-1',
    expected,
    origin: 'ai',
    source: { conversationId: 'conv-1', taskId: 'task-1', generator: 'organize-chat' },
    record: { content: content('record body v1') },
    summary: { content: content('summary body v1') },
  });

  assert.equal(outcome.status, 'committed');
  assert.equal(harness.writes(SCOPE), 1, 'the whole paired confirmation is one durable write');
  assert.equal(harness.port.journal.filter((event) => !event.ok).length, 0);

  const pair = harness.core.readPair({ scopeKind: 'task', scopeId: 'task-1', recordObjectId: 'conv-1' });
  assert.ok(pair !== null);
  assert.equal(pair.consistent, true);
  assert.equal(pair.revision, 1);
  assert.equal(pair.record?.content.sections[0]?.body, 'record body v1');
  assert.equal(pair.summary?.content.sections[0]?.body, 'summary body v1');
  assert.deepEqual(
    outcome.status === 'committed' ? outcome.changed : [],
    ['record', 'summary'],
  );
});

test('a failed commit leaves the previous pair untouched, in memory and after a restart (SAVE-06, REC-01)', async () => {
  const harness = createHarness();
  await seedTask(harness);
  const first = expectationOf(harness.core, { scopeKind: 'task', scopeId: 'task-1', recordObjectId: 'conv-1' });
  await harness.core.confirmPaired({
    updateId: 'update-ok',
    scopeKind: 'task',
    scopeId: 'task-1',
    recordObjectId: 'conv-1',
    expected: first,
    origin: 'ai',
    record: { content: content('record v1') },
    summary: { content: content('summary v1') },
  });

  // Inject a failure into the single commit write.
  harness.failNext(
    (event) => event.table === SCOPE && event.key.startsWith('scope1_'),
    new Error('injected: disk full while publishing the confirmation'),
  );
  const second = expectationOf(harness.core, { scopeKind: 'task', scopeId: 'task-1', recordObjectId: 'conv-1' });
  await assert.rejects(
    harness.core.confirmPaired({
      updateId: 'update-fails',
      scopeKind: 'task',
      scopeId: 'task-1',
      recordObjectId: 'conv-1',
      expected: second,
      origin: 'ai',
      record: { content: content('record v2 (never published)') },
      summary: { content: content('summary v2 (never published)') },
    }),
    /disk full/,
  );

  const afterFailure = harness.core.readPair({ scopeKind: 'task', scopeId: 'task-1', recordObjectId: 'conv-1' });
  assert.equal(afterFailure?.revision, 1);
  assert.equal(afterFailure?.record?.content.sections[0]?.body, 'record v1');
  assert.equal(afterFailure?.summary?.content.sections[0]?.body, 'summary v1');
  assert.equal(harness.core.history({ scopeKind: 'task', scopeId: 'task-1', objectKind: 'taskRecord', objectId: 'conv-1' }).length, 1);
  assert.equal(harness.core.history({ scopeKind: 'task', scopeId: 'task-1', objectKind: 'taskSummary', objectId: 'task-1' }).length, 1);

  // Restarting proves the medium holds the same old, consistent pair.
  const restarted = harness.restart();
  const durable = restarted.core.readPair({ scopeKind: 'task', scopeId: 'task-1', recordObjectId: 'conv-1' });
  assert.equal(durable?.revision, 1);
  assert.equal(durable?.record?.content.sections[0]?.body, 'record v1');
  assert.equal(durable?.summary?.content.sections[0]?.body, 'summary v1');

  // REC-01: the same confirmation retried succeeds and publishes both members.
  const retry = await restarted.core.confirmPaired({
    updateId: 'update-fails',
    scopeKind: 'task',
    scopeId: 'task-1',
    recordObjectId: 'conv-1',
    expected: expectationOf(restarted.core, { scopeKind: 'task', scopeId: 'task-1', recordObjectId: 'conv-1' }),
    origin: 'ai',
    record: { content: content('record v2 (never published)') },
    summary: { content: content('summary v2 (never published)') },
  });
  assert.equal(retry.status, 'committed');
  assert.equal(restarted.core.readPair({ scopeKind: 'task', scopeId: 'task-1', recordObjectId: 'conv-1' })?.summary?.content.sections[0]?.body, 'summary v2 (never published)');
});

test('negative control: a two-record confirmation really would half-apply, which is why the pair shares one record', async () => {
  const harness = createHarness();
  await seedTask(harness);
  // A naive design writes the two members as two records. Fail the second write.
  harness.failNext((event) => event.table === SCOPE && event.key === 'naive_summary', new Error('injected: second write fails'));
  await harness.port.put(SCOPE, 'naive_record', { member: 'record', value: 'v2' });
  await assert.rejects(harness.port.put(SCOPE, 'naive_summary', { member: 'summary', value: 'v2' }), /second write fails/);

  const restarted = harness.restart();
  assert.equal(restarted.port.get<{ value: string }>(SCOPE, 'naive_record')?.value, 'v2', 'the first record is durably applied');
  assert.equal(restarted.port.get(SCOPE, 'naive_summary'), undefined, 'the second never landed');
  // The core model cannot reach this state: it has no second write to fail.
  assert.equal(harness.core.readPair({ scopeKind: 'task', scopeId: 'task-1', recordObjectId: 'conv-1' })?.record, null);
});

test('only a member with a real change gets a version (SAVE-02)', async () => {
  const harness = createHarness();
  await seedTask(harness);
  await harness.core.confirmPaired({
    updateId: 'u1',
    scopeKind: 'task',
    scopeId: 'task-1',
    recordObjectId: 'conv-1',
    expected: expectationOf(harness.core, { scopeKind: 'task', scopeId: 'task-1', recordObjectId: 'conv-1' }),
    origin: 'ai',
    record: { content: content('record v1') },
    summary: { content: content('summary v1') },
  });

  const outcome = await harness.core.confirmPaired({
    updateId: 'u2',
    scopeKind: 'task',
    scopeId: 'task-1',
    recordObjectId: 'conv-1',
    expected: expectationOf(harness.core, { scopeKind: 'task', scopeId: 'task-1', recordObjectId: 'conv-1' }),
    origin: 'ai',
    record: { content: content('record v2') },
    summary: { confirmUnchanged: true },
  });
  assert.equal(outcome.status, 'committed');
  assert.deepEqual(outcome.status === 'committed' ? outcome.changed : [], ['record']);
  assert.deepEqual(outcome.status === 'committed' ? outcome.unchanged : [], ['summary']);
  assert.equal(outcome.status === 'committed' ? outcome.versions.length : -1, 1, 'no duplicate version for an unchanged member');
  assert.deepEqual(
    harness.core.history({ scopeKind: 'task', scopeId: 'task-1', objectKind: 'taskSummary', objectId: 'task-1' }).map((view) => view.seq),
    [1],
    'the summary chain did not grow',
  );
});

test('an explicit clearing is a delete change, not "no update needed" (SAVE-02)', async () => {
  const harness = createHarness();
  await seedTask(harness);
  await harness.core.confirmPaired({
    updateId: 'u1',
    scopeKind: 'task',
    scopeId: 'task-1',
    recordObjectId: 'conv-1',
    expected: expectationOf(harness.core, { scopeKind: 'task', scopeId: 'task-1', recordObjectId: 'conv-1' }),
    origin: 'ai',
    record: { content: contentWith([{ id: 's1', title: 'Goal', body: 'ship it' }], [conclusion('c1', 'login undecided', 'pending')]) },
    summary: { content: content('summary v1') },
  });

  const cleared = await harness.core.confirmPaired({
    updateId: 'u2',
    scopeKind: 'task',
    scopeId: 'task-1',
    recordObjectId: 'conv-1',
    expected: expectationOf(harness.core, { scopeKind: 'task', scopeId: 'task-1', recordObjectId: 'conv-1' }),
    origin: 'user',
    record: { cleared: true },
    summary: { confirmUnchanged: true },
  });
  assert.equal(cleared.status, 'committed');
  assert.deepEqual(cleared.status === 'committed' ? cleared.cleared : [], ['record']);
  const record = harness.core.readObject({ scopeKind: 'task', scopeId: 'task-1', objectKind: 'taskRecord', objectId: 'conv-1' });
  assert.deepEqual(record?.content, { sections: [], conclusions: [] });
  const chain = harness.core.readScopeState({ scopeKind: 'task', scopeId: 'task-1' });
  assert.equal(chain?.chains.taskRecord['conv-1']?.[1]?.changeKind, 'cleared');

  // Clearing an already-empty object is genuinely nothing to do.
  harness.resetJournal();
  const again = await harness.core.confirmPaired({
    updateId: 'u3',
    scopeKind: 'task',
    scopeId: 'task-1',
    recordObjectId: 'conv-1',
    expected: expectationOf(harness.core, { scopeKind: 'task', scopeId: 'task-1', recordObjectId: 'conv-1' }),
    origin: 'user',
    record: { cleared: true },
    summary: { confirmUnchanged: true },
  });
  assert.equal(again.status, 'no-change');
  assert.equal(harness.writes(SCOPE), 0, 'a no-change answer performs no write at all');
});

test('a confirmation with nothing to do performs zero writes and only a checked no-update may advance (SAVE-10)', async () => {
  const harness = createHarness();
  await seedTask(harness);
  await harness.core.confirmPaired({
    updateId: 'u1',
    scopeKind: 'task',
    scopeId: 'task-1',
    recordObjectId: 'conv-1',
    expected: expectationOf(harness.core, { scopeKind: 'task', scopeId: 'task-1', recordObjectId: 'conv-1' }),
    origin: 'ai',
    record: { content: content('record v1') },
    summary: { content: content('summary v1') },
  });
  harness.resetJournal();
  const outcome = await harness.core.confirmPaired({
    updateId: 'u2',
    scopeKind: 'task',
    scopeId: 'task-1',
    recordObjectId: 'conv-1',
    expected: expectationOf(harness.core, { scopeKind: 'task', scopeId: 'task-1', recordObjectId: 'conv-1' }),
    origin: 'ai',
    record: { content: content('record v1') },
    summary: { content: content('summary v1') },
    bothCheckedNoUpdate: true,
  });
  assert.equal(outcome.status, 'no-change');
  assert.equal(outcome.status === 'no-change' ? outcome.processingPositionHint : null, 'advance');
  assert.equal(outcome.status === 'no-change' ? outcome.wrote : null, false);
  assert.equal(harness.writes(SCOPE), 0, 'no empty version was manufactured to advance the processing position');
  assert.equal(scopeStateOf(harness, 'task', 'task-1').revision, 1);
});

test('a project pair uses projectRecord + projectOverview and is atomic in the same way (OBJ-05, SAVE-02)', async () => {
  const harness = createHarness();
  await harness.core.ensureScope({ scopeKind: 'project', scopeId: 'proj-1' });
  await harness.core.linkOutcomeTask({ projectId: 'proj-1', taskId: 'outcome-1' });
  harness.resetJournal();
  const outcome = await harness.core.confirmPaired({
    updateId: 'p1',
    scopeKind: 'project',
    scopeId: 'proj-1',
    recordObjectId: 'outcome-1',
    expected: expectationOf(harness.core, { scopeKind: 'project', scopeId: 'proj-1', recordObjectId: 'outcome-1' }),
    origin: 'ai',
    source: { projectId: 'proj-1', taskId: 'outcome-1', generator: 'organize-chat' },
    record: { content: content('outcome detail') },
    summary: { content: content('project overview v1') },
  });
  assert.equal(outcome.status, 'committed');
  assert.equal(harness.writes(SCOPE), 1);
  const pair = harness.core.readPair({ scopeKind: 'project', scopeId: 'proj-1', recordObjectId: 'outcome-1' });
  assert.equal(pair?.record?.objectKind, 'projectRecord');
  assert.equal(pair?.summary?.objectKind, 'projectOverview');
  assert.equal(pair?.summary?.content.sections[0]?.body, 'project overview v1');
});

test('confirmation is refused without a fixed attribution, and a rebind is forbidden (OBJ-03, F06-R01)', async () => {
  const harness = createHarness();
  await harness.core.ensureScope({ scopeKind: 'task', scopeId: 'task-1' });
  await harness.core.ensureScope({ scopeKind: 'task', scopeId: 'task-2' });
  const notLinked = await harness.core.confirmPaired({
    updateId: 'x1',
    scopeKind: 'task',
    scopeId: 'task-1',
    recordObjectId: 'conv-1',
    expected: expectationOf(harness.core, { scopeKind: 'task', scopeId: 'task-1', recordObjectId: 'conv-1' }),
    origin: 'ai',
    record: { content: content('x') },
    summary: { content: content('y') },
  });
  assert.equal(notLinked.status, 'rejected');
  assert.equal(notLinked.status === 'rejected' ? notLinked.code : null, 'unlinked-conversation');

  await harness.core.linkConversation({ taskId: 'task-1', conversationId: 'conv-1' });
  assert.deepEqual(await harness.core.linkConversation({ taskId: 'task-1', conversationId: 'conv-1' }), {
    status: 'already-linked',
    taskId: 'task-1',
    conversationId: 'conv-1',
  });
  const rebind = await harness.core.linkConversation({ taskId: 'task-2', conversationId: 'conv-1' });
  assert.equal(rebind.status, 'rejected');
  assert.equal(rebind.status === 'rejected' ? rebind.code : null, 'rebind-forbidden');
});
