/**
 * APP-01…07 / F08-R02 / F09-R02/R03/R06: applicability is tracked separately
 * from the body, is scoped to the task or project it was confirmed in, and its
 * changes are part of the same atomic write as any text they correct.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { AIKANBAN_TABLES } from '../src/domainSpec.ts';
import { conclusion, content, contentWith, createHarness, expectationOf, seedTask, scopeStateOf } from './harness.ts';

const SCOPE = AIKANBAN_TABLES.scopeState;

const decided = contentWith([{ id: 's1', title: 'Decision', body: 'Use plan A' }], [conclusion('c1', 'plan A verified', 'current')]);

test('a correction alone is one atomic write that adds no body version (F09-R06)', async () => {
  const harness = createHarness();
  await seedTask(harness);
  await harness.core.confirmPaired({
    updateId: 'v1',
    scopeKind: 'task',
    scopeId: 'task-1',
    recordObjectId: 'conv-1',
    expected: expectationOf(harness.core, { scopeKind: 'task', scopeId: 'task-1', recordObjectId: 'conv-1' }),
    origin: 'ai',
    record: { content: decided },
    summary: { content: content('summary v1') },
  });
  const before = harness.core.readObject({ scopeKind: 'task', scopeId: 'task-1', objectKind: 'taskRecord', objectId: 'conv-1' });

  harness.resetJournal();
  const outcome = await harness.core.amendApplicability({
    updateId: 'amend',
    scopeKind: 'task',
    scopeId: 'task-1',
    recordObjectId: 'conv-1',
    expected: expectationOf(harness.core, { scopeKind: 'task', scopeId: 'task-1', recordObjectId: 'conv-1' }),
    origin: 'user',
    amendments: [
      {
        conclusionId: 'c1',
        targetMember: 'record',
        state: 'superseded',
        affectedFragments: ['s1'],
        substitute: 'plan B verified instead',
        sourceVersionIds: ['conv-1@30'],
        note: 'explicit substitution',
      },
    ],
  });
  assert.equal(outcome.status, 'committed');
  assert.equal(harness.writes(SCOPE), 1, 'the correction is one atomic write');
  assert.deepEqual(outcome.status === 'committed' ? outcome.versions : ['unexpected'], [], 'no body version was manufactured');
  const scope = scopeStateOf(harness, 'task', 'task-1');
  assert.equal(scope.revision, 1, 'the body revision is untouched');
  assert.equal(scope.applicabilityRevision, 1);
  assert.equal(scope.chains.taskRecord['conv-1']?.length, 1);

  const after = harness.core.readObject({ scopeKind: 'task', scopeId: 'task-1', objectKind: 'taskRecord', objectId: 'conv-1' });
  assert.equal(after?.versionId, before?.versionId, 'the served body version is still the same');
  assert.equal(after?.conclusions[0]?.statedState, 'current', 'the original wording is preserved as history');
  assert.equal(after?.conclusions[0]?.state, 'superseded', 'APP-01: the newest body does not decide applicability');
  assert.equal(after?.conclusions[0]?.amendment?.substitute, 'plan B verified instead');
  assert.deepEqual(after?.conclusions[0]?.amendment?.affectedFragments, ['s1']);
  assert.deepEqual(after?.conclusions[0]?.amendment?.appliesTo, { scopeKind: 'task', scopeId: 'task-1' }, 'F09-R03: the correction carries its scope');

  // F09-R06: a correction must be detectable by readers even though the body
  // version did not change.
  assert.notEqual(after?.readToken, before?.readToken, 'the read token changes so F11 can tell material is stale');
});

test('baseline validation covers applicability, not just the body version (F08-R02)', async () => {
  const harness = createHarness();
  await seedTask(harness);
  await harness.core.confirmPaired({
    updateId: 'v1',
    scopeKind: 'task',
    scopeId: 'task-1',
    recordObjectId: 'conv-1',
    expected: expectationOf(harness.core, { scopeKind: 'task', scopeId: 'task-1', recordObjectId: 'conv-1' }),
    origin: 'ai',
    record: { content: decided },
    summary: { content: content('summary v1') },
  });
  const staleExpectation = expectationOf(harness.core, { scopeKind: 'task', scopeId: 'task-1', recordObjectId: 'conv-1' });

  await harness.core.amendApplicability({
    updateId: 'amend',
    scopeKind: 'task',
    scopeId: 'task-1',
    recordObjectId: 'conv-1',
    expected: staleExpectation,
    origin: 'user',
    amendments: [{ conclusionId: 'c1', targetMember: 'record', state: 'negated', affectedFragments: ['s1'] }],
  });

  const blocked = await harness.core.confirmPaired({
    updateId: 'v2',
    scopeKind: 'task',
    scopeId: 'task-1',
    recordObjectId: 'conv-1',
    expected: staleExpectation,
    origin: 'ai',
    record: { content: content('new body') },
    summary: { content: content('new summary') },
  });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.status === 'blocked' ? blocked.code : null, 'baseline-changed');
  assert.equal(blocked.status === 'blocked' ? blocked.actual?.applicabilityRevision : -1, 1);
  const baseline = harness.core.checkBaseline({
    scopeKind: 'task',
    scopeId: 'task-1',
    recordObjectId: 'conv-1',
    expected: staleExpectation,
  });
  assert.ok(baseline.issues.some((issue) => issue.code === 'applicability-changed'), 'a correction invalidates an old baseline');

  // A fresh baseline works, and the negation survives the new body version (APP-07).
  const committed = await harness.core.confirmPaired({
    updateId: 'v2',
    scopeKind: 'task',
    scopeId: 'task-1',
    recordObjectId: 'conv-1',
    expected: expectationOf(harness.core, { scopeKind: 'task', scopeId: 'task-1', recordObjectId: 'conv-1' }),
    origin: 'ai',
    record: { content: contentWith([{ id: 's1', title: 'Decision', body: 'Use plan A still' }], [conclusion('c1', 'plan A verified', 'current')]) },
    summary: { content: content('new summary') },
  });
  assert.equal(committed.status, 'committed');
  const view = harness.core.readObject({ scopeKind: 'task', scopeId: 'task-1', objectKind: 'taskRecord', objectId: 'conv-1' });
  assert.equal(view?.seq, 2);
  assert.equal(view?.conclusions[0]?.state, 'negated', 'F09-R06: rewriting the body must not revive a retired conclusion');
});

test('applicability is scoped to its own task: an identical conclusion elsewhere is unaffected (F09-R03)', async () => {
  const harness = createHarness();
  await seedTask(harness, 'task-1', 'conv-1');
  await harness.core.confirmPaired({
    updateId: 't1',
    scopeKind: 'task',
    scopeId: 'task-1',
    recordObjectId: 'conv-1',
    expected: expectationOf(harness.core, { scopeKind: 'task', scopeId: 'task-1', recordObjectId: 'conv-1' }),
    origin: 'ai',
    record: { content: decided },
    summary: { content: content('summary 1') },
  });
  await seedTask(harness, 'task-2', 'conv-9');
  await harness.core.confirmPaired({
    updateId: 't2',
    scopeKind: 'task',
    scopeId: 'task-2',
    recordObjectId: 'conv-9',
    expected: expectationOf(harness.core, { scopeKind: 'task', scopeId: 'task-2', recordObjectId: 'conv-9' }),
    origin: 'ai',
    record: { content: decided },
    summary: { content: content('summary 2') },
  });

  await harness.core.amendApplicability({
    updateId: 'negate-in-task-1',
    scopeKind: 'task',
    scopeId: 'task-1',
    recordObjectId: 'conv-1',
    expected: expectationOf(harness.core, { scopeKind: 'task', scopeId: 'task-1', recordObjectId: 'conv-1' }),
    origin: 'user',
    amendments: [{ conclusionId: 'c1', targetMember: 'record', state: 'negated' }],
  });

  assert.equal(
    harness.core.readObject({ scopeKind: 'task', scopeId: 'task-1', objectKind: 'taskRecord', objectId: 'conv-1' })?.conclusions[0]?.state,
    'negated',
  );
  assert.equal(
    harness.core.readObject({ scopeKind: 'task', scopeId: 'task-2', objectKind: 'taskRecord', objectId: 'conv-9' })?.conclusions[0]?.state,
    'current',
    'F09-R03: identical wording in another task is not negated by this correction',
  );
  assert.equal(scopeStateOf(harness, 'task', 'task-2').applicabilityRevision, 0);
});

test('an unknown conclusion, or silence about both members, is refused without writing anything (APP-03)', async () => {
  const harness = createHarness();
  await seedTask(harness);
  await harness.core.confirmPaired({
    updateId: 'v1',
    scopeKind: 'task',
    scopeId: 'task-1',
    recordObjectId: 'conv-1',
    expected: expectationOf(harness.core, { scopeKind: 'task', scopeId: 'task-1', recordObjectId: 'conv-1' }),
    origin: 'ai',
    record: { content: decided },
    summary: { content: content('summary v1') },
  });
  harness.resetJournal();

  const unknown = await harness.core.amendApplicability({
    updateId: 'amend-unknown',
    scopeKind: 'task',
    scopeId: 'task-1',
    recordObjectId: 'conv-1',
    expected: expectationOf(harness.core, { scopeKind: 'task', scopeId: 'task-1', recordObjectId: 'conv-1' }),
    origin: 'user',
    amendments: [{ conclusionId: 'nope', targetMember: 'record', state: 'negated' }],
  });
  assert.equal(unknown.status, 'rejected');
  assert.equal(unknown.status === 'rejected' ? unknown.code : null, 'unknown-conclusion');

  const silent = await harness.core.confirmPaired({
    updateId: 'silent',
    scopeKind: 'task',
    scopeId: 'task-1',
    recordObjectId: 'conv-1',
    expected: expectationOf(harness.core, { scopeKind: 'task', scopeId: 'task-1', recordObjectId: 'conv-1' }),
    origin: 'ai',
    record: {},
    summary: {},
  });
  assert.equal(silent.status, 'rejected');
  assert.equal(silent.status === 'rejected' ? silent.code : null, 'nothing-to-confirm');
  assert.equal(harness.writes(SCOPE), 0, 'a refused confirmation performs no write');
});

test('a correction and the text it corrects take effect in the same single write (APP-04, F09-R04)', async () => {
  const harness = createHarness();
  await seedTask(harness);
  harness.resetJournal();
  const outcome = await harness.core.confirmPaired({
    updateId: 'together',
    scopeKind: 'task',
    scopeId: 'task-1',
    recordObjectId: 'conv-1',
    expected: expectationOf(harness.core, { scopeKind: 'task', scopeId: 'task-1', recordObjectId: 'conv-1' }),
    origin: 'user',
    record: { content: decided },
    summary: { content: contentWith([{ id: 's1', title: 'Status', body: 'plan A no longer valid' }], [conclusion('c1', 'plan A verified', 'current')]) },
    amendments: [{ conclusionId: 'c1', targetMember: 'summary', state: 'negated', affectedFragments: ['s1'], substitute: 'plan B' }],
  });
  assert.equal(outcome.status, 'committed');
  assert.equal(harness.writes(SCOPE), 1, '文案与状态不能半生效: text and state land in one write');
  assert.deepEqual(outcome.status === 'committed' ? outcome.changed : [], ['record', 'summary']);
  assert.equal(outcome.status === 'committed' ? outcome.amendments.length : -1, 1);
  const scope = scopeStateOf(harness, 'task', 'task-1');
  assert.equal(scope.revision, 1);
  assert.equal(scope.applicabilityRevision, 1);
  const summary = harness.core.readObject({ scopeKind: 'task', scopeId: 'task-1', objectKind: 'taskSummary', objectId: 'task-1' });
  assert.equal(summary?.content.sections[0]?.body, 'plan A no longer valid');
  assert.equal(summary?.conclusions[0]?.state, 'negated');
  assert.equal(summary?.conclusions[0]?.amendment?.substitute, 'plan B');
});
