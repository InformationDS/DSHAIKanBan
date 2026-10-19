/**
 * The port boundary: the in-memory port must reproduce the measured
 * `storageDomain` contract, and the production adapter must drive a real
 * `Domain`/`KvTable` shape without importing any DSH type.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { AIKANBAN_TABLES, draftKey, scopeKey, versionIdOf } from '../src/domainSpec.ts';
import { createMemoryMedium, createMemoryStoragePort, createStorageDomainPort, PortError } from '../src/port.ts';
import { canonicalJson, encodeKey, fingerprint } from '../src/keys.ts';

const TABLE = AIKANBAN_TABLES.scopeState;
const SAFE_KEY_RE = /^[a-zA-Z0-9_-]+$/;

/** A structural stand-in for a real `ctx.storageDomain` domain. */
function fakeDomain() {
  const tables = new Map<string, Map<string, unknown>>();
  const chain: Promise<unknown>[] = [];
  let tail: Promise<unknown> = Promise.resolve();
  const serialize = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  const enqueue = <T>(job: () => Promise<T>): Promise<T> => {
    const result = tail.then(job);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    chain.push(result);
    return result;
  };
  const tableOf = (name: string): Map<string, unknown> => {
    let records = tables.get(name);
    if (records === undefined) {
      records = new Map<string, unknown>();
      tables.set(name, records);
    }
    return records;
  };
  return {
    writes: chain,
    name: 'fake-domain',
    table(name: string) {
      const records = tableOf(name);
      return {
        get: (key: string) => records.get(key),
        entries: () => [...records.entries()][Symbol.iterator]() as IterableIterator<[string, unknown]>,
        keys: () => [...records.keys()][Symbol.iterator](),
        get size() {
          return records.size;
        },
        put: (key: string, value: unknown) =>
          enqueue(async () => {
            records.set(key, serialize(value));
          }),
        delete: (key: string) =>
          enqueue(async () => {
            const had = records.delete(key);
            return had;
          }),
        update: (key: string, transform: (current: unknown) => unknown) =>
          enqueue(async () => {
            if (!records.has(key)) throw new PortError('missing-key', `no '${key}'`);
            const next = serialize(transform(records.get(key)));
            records.set(key, next);
            return next;
          }),
      };
    },
  };
}

test('the production adapter drives a Domain/KvTable shape with no DSH import', async () => {
  const port = createStorageDomainPort(fakeDomain());
  assert.equal(port.name, 'fake-domain');
  assert.equal(port.get(TABLE, 'k'), undefined);
  assert.equal(port.size(TABLE), 0);
  await port.put(TABLE, 'k', { n: 1 });
  assert.deepEqual(port.get(TABLE, 'k'), { n: 1 });
  assert.equal(port.size(TABLE), 1);
  assert.deepEqual([...port.keys(TABLE)], ['k']);
  assert.deepEqual([...port.entries(TABLE)], [['k', { n: 1 }]]);
  const updated = await port.update<{ n: number }>(TABLE, 'k', (current) => ({ n: current.n + 1 }));
  assert.deepEqual(updated, { n: 2 });
  assert.equal(await port.delete(TABLE, 'k'), true);
  assert.equal(port.get(TABLE, 'k'), undefined);
  assert.equal(await port.delete(TABLE, 'k'), false, 'deleting a missing record is a no-op');
  await assert.rejects(port.update<{ n: number }>(TABLE, 'absent', (current) => current), (error: unknown) => {
    assert.ok(error instanceof PortError);
    assert.equal(error.code, 'missing-key');
    return true;
  });
});

test('the memory port reproduces the measured write contract: serialized updates, durability first, no memory divergence', async () => {
  const medium = createMemoryMedium();
  const port = createMemoryStoragePort(medium);
  await port.put(TABLE, 'counter', { n: 0 });
  const racing = 32;
  await Promise.all(Array.from({ length: racing }, () => port.update<{ n: number }>(TABLE, 'counter', (current) => ({ n: current.n + 1 }))));
  assert.equal(port.get<{ n: number }>(TABLE, 'counter')?.n, racing, 'update() never interleaves at its queue slot');
  assert.equal((medium.tables.get(TABLE)?.get('counter') as { n: number }).n, racing, 'the medium agrees with memory');

  // A failed write must leave both layers on the previous value.
  const failing = createMemoryStoragePort(medium, {
    beforeWrite: (event) => (event.table === TABLE ? new Error('injected') : undefined),
  });
  await assert.rejects(failing.put(TABLE, 'counter', { n: 999 }), /injected/);
  assert.equal(failing.get<{ n: number }>(TABLE, 'counter')?.n, racing);
  assert.equal((medium.tables.get(TABLE)?.get('counter') as { n: number }).n, racing);
  assert.equal(failing.journal.filter((event) => !event.ok).length, 1);

  // A restart port sees exactly the durable state.
  const restarted = createMemoryStoragePort(medium);
  assert.equal(restarted.get<{ n: number }>(TABLE, 'counter')?.n, racing);
  assert.equal(restarted.journal.length, 0, 'a fresh port starts with an empty journal');
  await assert.rejects(restarted.update(TABLE, 'nope', (current) => current), (error: unknown) => {
    assert.ok(error instanceof PortError);
    assert.equal(error.code, 'missing-key', 'the discriminant matches the real DomainError code');
    return true;
  });
});

test('the port stores JSON-round-tripped values, so nothing the medium cannot hold survives', async () => {
  const port = createMemoryStoragePort(createMemoryMedium());
  await port.put(TABLE, 'json', { kept: 1, nested: { also: 'kept' } });
  // JSON semantics: `undefined` members and functions are not durable state.
  await port.put(TABLE, 'partial', { kept: 1, dropped: undefined });
  assert.deepEqual(port.get(TABLE, 'partial'), { kept: 1 });
  assert.deepEqual(port.get(TABLE, 'json'), { kept: 1, nested: { also: 'kept' } });
});

test('every derived storage key is path-safe and distinct for distinct identities (per-record layout constraint)', () => {
  const identities = ['conv-1', 'conv 1', 'conv/1', 'conv:1', 'conv_1', 'conv-1-', '会话/1', ''];
  const encoded = identities.map(encodeKey);
  // `encodeKey` escapes one identifier *part*; an empty part is legal inside a
  // composite key because the composite always carries a literal prefix and
  // separators, so only non-empty parts are asserted to be safe alone.
  for (const key of encoded.filter((key) => key.length > 0)) assert.match(key, SAFE_KEY_RE, `'${key}' must be a safe path segment`);
  assert.equal(new Set(encoded).size, identities.length, 'distinct identifiers must never collide');
  assert.equal(encodeKey('a/b') !== encodeKey('a-2fb'), true, 'escaping is injective: a literal dash is escaped too');
  assert.match(scopeKey('task', ''), SAFE_KEY_RE, 'even an empty identifier yields a safe composite key');

  const keys = identities.map((id) => scopeKey('task', id));
  assert.equal(new Set(keys).size, identities.length);
  for (const key of keys) assert.match(key, SAFE_KEY_RE);

  const draftKeys = [
    draftKey({ kind: 'taskRecord', scopeKind: 'task', scopeId: 't1', objectId: 'c1' }),
    draftKey({ kind: 'taskRecord', scopeKind: 'task', scopeId: 't1', objectId: 'c2' }),
    draftKey({ kind: 'summaryDraft', scopeKind: 'task', scopeId: 't1', objectId: 't1' }),
    draftKey({ kind: 'projectRecord', scopeKind: 'project', scopeId: 't1', objectId: 'c1' }),
  ];
  assert.equal(new Set(draftKeys).size, draftKeys.length, 'draft slots are distinct across kinds and scopes');
  for (const key of draftKeys) assert.match(key, SAFE_KEY_RE);

  // Version ids are deterministic: the same confirmation derives the same id,
  // which is what makes a retry incapable of producing a second version.
  assert.equal(
    versionIdOf({ updateId: 'u/1', objectKind: 'taskRecord', objectId: 'conv:1' }),
    versionIdOf({ updateId: 'u/1', objectKind: 'taskRecord', objectId: 'conv:1' }),
  );
  assert.notEqual(
    versionIdOf({ updateId: 'u/1', objectKind: 'taskRecord', objectId: 'conv:1' }),
    versionIdOf({ updateId: 'u/2', objectKind: 'taskRecord', objectId: 'conv:1' }),
  );
  assert.match(versionIdOf({ updateId: 'u/1', objectKind: 'taskRecord', objectId: 'conv:1' }), SAFE_KEY_RE);
});

test('canonicalJson and fingerprint are order-independent and stable', () => {
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] }), canonicalJson({ a: [2, { c: 4, d: 3 }], b: 1 }));
  assert.notEqual(canonicalJson({ a: 1 }), canonicalJson({ a: 2 }));
  assert.equal(fingerprint({ a: 1, b: 2 }), fingerprint({ b: 2, a: 1 }));
  assert.match(fingerprint('x'), /^[0-9a-f]{16}$/);
});
