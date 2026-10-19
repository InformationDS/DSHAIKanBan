/**
 * REC-03 / REC-05 / F18-R03: a restart keeps every saved official version, the
 * current pointer and the recoverable drafts, and it never promotes unconfirmed
 * content into fact.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { AIKANBAN_DOMAIN_LAYOUT, AIKANBAN_DOMAIN_NAME, AIKANBAN_TABLES, buildDomainSpec, isDraftRecord, isScopeStateRecord } from '../src/domainSpec.ts';
import { content, createHarness, expectationOf, seedTask, scopeStateOf } from './harness.ts';
import type { DraftRecord, ScopeStateRecord } from '../src/types.ts';

const SCOPE = AIKANBAN_TABLES.scopeState;

/** A zod stand-in: enough of `z.custom` to exercise the spec's schemas. */
const fakeZod = {
  custom: (check: (value: unknown) => boolean, params?: { readonly message?: string }) => ({
    parse: (value: unknown): unknown => {
      if (!check(value)) throw new Error(params?.message ?? 'invalid');
      return value;
    },
  }),
};

test('restarting preserves the version chain, the current pointer and the draft, and promotes nothing', async () => {
  const harness = createHarness();
  await seedTask(harness);
  await harness.core.confirmPaired({
    updateId: 'u1',
    scopeKind: 'task',
    scopeId: 'task-1',
    recordObjectId: 'conv-1',
    expected: expectationOf(harness.core, { scopeKind: 'task', scopeId: 'task-1', recordObjectId: 'conv-1' }),
    origin: 'ai',
    source: { conversationId: 'conv-1', taskId: 'task-1', generator: 'organize-chat' },
    record: {
      content: content('official record v1'),
      readSourceVersionIds: ['conv-1@12'],
      coveredStage: '阶段一',
      aiDraft: 'AI 原稿 v1',
      userResult: '用户结果 v1',
    },
    summary: { content: content('official summary v1') },
  });
  const draftBefore = await harness.core.saveDraft({
    kind: 'taskRecord',
    scopeKind: 'task',
    scopeId: 'task-1',
    objectId: 'conv-1',
    content: content('unconfirmed candidate'),
    aiDraftContent: content('AI candidate'),
    rejectedSections: ['s9'],
    updateId: 'u2',
    state: 'ready',
    edited: true,
  });
  const beforeState = scopeStateOf(harness, 'task', 'task-1');

  const restarted = harness.restart();
  const afterState = restarted.core.readScopeState({ scopeKind: 'task', scopeId: 'task-1' });
  assert.deepEqual(afterState?.chains, beforeState.chains, 'version chains survive a restart unchanged');
  assert.deepEqual(afterState?.current, beforeState.current, 'the current pointer survives a restart');
  assert.equal(afterState?.revision, beforeState.revision);
  assert.deepEqual(afterState?.links, beforeState.links, 'fixed attribution survives a restart (OBJ-03)');

  const draftAfter = restarted.core.getDraft(draftBefore.draftId);
  assert.deepEqual(draftAfter, draftBefore, 'the draft is recoverable verbatim, including its baseline and rejected sections');

  const pair = restarted.core.readPair({ scopeKind: 'task', scopeId: 'task-1', recordObjectId: 'conv-1' });
  assert.equal(pair?.revision, 1);
  assert.equal(pair?.record?.content.sections[0]?.body, 'official record v1', 'unconfirmed content did not become fact');
  assert.ok(!pair?.record?.content.sections.some((section) => section.body === 'unconfirmed candidate'));
});

test('a 待核对 marker derived from a stale draft survives a restart (REC-03)', async () => {
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
  await harness.core.confirmPaired({
    updateId: 'u1',
    scopeKind: 'task',
    scopeId: 'task-1',
    recordObjectId: 'conv-1',
    expected: expectationOf(harness.core, { scopeKind: 'task', scopeId: 'task-1', recordObjectId: 'conv-1' }),
    origin: 'ai',
    record: { content: content('conv-1 official') },
    summary: { content: content('summary v1') },
  });

  const restarted = harness.restart();
  const recheck = restarted.core.readRecheck({ scopeKind: 'task', scopeId: 'task-1' });
  assert.equal(recheck.taskSummary.pending, true, 'the consistency marker is still expressed after a restart');
  assert.equal(recheck.staleDrafts.length, 1);
});

test('a corrupted head record is rejected by the schema the domain spec installs, so the open fails instead of serving an empty scope (REC-05)', async () => {
  const harness = createHarness();
  await seedTask(harness);
  await harness.core.confirmPaired({
    updateId: 'u1',
    scopeKind: 'task',
    scopeId: 'task-1',
    recordObjectId: 'conv-1',
    expected: expectationOf(harness.core, { scopeKind: 'task', scopeId: 'task-1', recordObjectId: 'conv-1' }),
    origin: 'ai',
    record: { content: content('record') },
    summary: { content: content('summary') },
  });
  const good = scopeStateOf(harness, 'task', 'task-1');
  assert.equal(isScopeStateRecord(good), true, 'a well-formed head record passes the validator');

  const spec = buildDomainSpec(fakeZod);
  const scopeSchema = spec.tables[AIKANBAN_TABLES.scopeState]?.valueSchema as { parse(value: unknown): unknown };
  assert.doesNotThrow(() => scopeSchema.parse(good));

  // Simulate a corrupted document on the medium: the domain validates every
  // stored record at open, so this must reject rather than read as empty.
  const corrupted: ScopeStateRecord = { ...good, chains: undefined as unknown as ScopeStateRecord['chains'] };
  assert.equal(isScopeStateRecord(corrupted), false);
  assert.throws(() => scopeSchema.parse(corrupted), /invalid aikanban scope_state record/);

  const brokenDraft = { ...(harness.core.getDraft('nope') ?? {}), draftId: 'x', kind: 'taskRecord' } as unknown as DraftRecord;
  assert.equal(isDraftRecord(brokenDraft), false, 'a malformed draft record is rejected rather than silently dropped');
});

test('the domain spec matches the measured constraints of the real storage layer (ADR-002)', () => {
  const spec = buildDomainSpec(fakeZod);
  assert.equal(spec.name, AIKANBAN_DOMAIN_NAME);
  assert.match(spec.name, /^[a-z][a-z0-9_]*$/, `UNIT_NAME_RE requires this shape (got ${spec.name})`);
  assert.equal(spec.layout, AIKANBAN_DOMAIN_LAYOUT);
  assert.equal(spec.layout, 'single', 'a corrupt document must fail the open instead of reading as an absent record');
  assert.equal(spec.version, 1);
  assert.deepEqual(Object.keys(spec.tables).sort(), ['drafts', 'scope_state']);
  for (const table of Object.keys(spec.tables)) assert.match(table, /^[a-z][a-z0-9_]*$/);
  assert.equal('invalidRecords' in spec, false, "'backup-and-skip' is for disposable derived data and is inert under single layout");
  assert.equal('global' in spec, false, 'no global slot: a nullable global cannot round-trip, and none is needed');
  assert.equal('compatibleVersions' in spec, false);
  assert.ok(SCOPE.length > 0);
});
