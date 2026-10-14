/**
 * The storage port: the only way the core model touches a medium.
 *
 * The interface is deliberately narrow and structural. It mirrors the
 * `ctx.storageDomain` surface (`Domain` / `KvTable` in
 * `@deepseek-ai/dsh-storage-domain`) without importing any DSH type, so the
 * core is unit-testable against an in-memory medium and, in production, is
 * driven by a real `storageDomain`.
 *
 * Measured contract (see `experiments/storage-domain-atomicity.mjs`, ADR-002):
 *  - exactly one record is published per `put`/`update`, and that publish is
 *    atomic (temp file + fsync + rename);
 *  - a change spanning two records is NOT a transaction, so a caller must fit
 *    a whole confirmation into ONE record;
 *  - `update` runs its transform at its queue slot, so read-modify-write never
 *    interleaves, and the transform MUST be synchronous;
 *  - durability happens before the in-memory value changes, so a rejected
 *    write leaves reads untouched;
 *  - `update` on an absent key rejects with code `missing-key`.
 *
 * @module @aikanban/core/port
 */

/** A write attempt, as observed by `createMemoryStoragePort`'s journal. */
export interface WriteEvent {
  readonly kind: 'put' | 'delete' | 'update';
  readonly table: string;
  readonly key: string;
  readonly ok: boolean;
  readonly attempt: number;
  readonly error: string | null;
}

/** Errors raised by a port, with a stable discriminant. */
export class PortError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'PortError';
    this.code = code;
  }
}

/** Errors raised by the core model itself (as opposed to a rejected outcome). */
export class CoreError extends Error {
  readonly code:
    | 'invalid-input'
    | 'missing-scope'
    | 'missing-draft'
    | 'unsupported-pair'
    | 'unknown-conclusion'
    | 'unknown-object';
  constructor(code: CoreError['code'], message: string) {
    super(message);
    this.name = 'CoreError';
    this.code = code;
  }
}

/** The narrow port the core depends on. */
export interface StoragePort {
  readonly name: string;
  get<T>(table: string, key: string): T | undefined;
  put<T>(table: string, key: string, value: T): Promise<void>;
  delete(table: string, key: string): Promise<boolean>;
  update<T>(table: string, key: string, transform: (current: T) => T): Promise<T>;
  entries<T>(table: string): IterableIterator<[string, T]>;
  keys(table: string): IterableIterator<string>;
  size(table: string): number;
}

/**
 * The durable fake medium. Kept separate from the port so that constructing a
 * new port over the same medium is exactly a process restart.
 */
export interface MemoryMedium {
  readonly tables: Map<string, Map<string, unknown>>;
}

/** Fault injection for tests. Throwing/returning an error fails the write before it is durable. */
export interface MemoryPortOptions {
  readonly beforeWrite?: (event: {
    readonly kind: 'put' | 'delete' | 'update';
    readonly table: string;
    readonly key: string;
    readonly value: unknown;
    /** 1-based count of durable-write attempts on this port. */
    readonly attempt: number;
  }) => Error | undefined;
}

/** A memory port, plus observability hooks used by the tests as evidence. */
export interface MemoryStoragePort extends StoragePort {
  readonly journal: readonly WriteEvent[];
  resetJournal(): void;
  /** Count of durable-write attempts since port creation. */
  readonly attempts: number;
}

/** Create an empty durable medium (or seed one). */
export function createMemoryMedium(seed?: Readonly<Record<string, Readonly<Record<string, unknown>>>>): MemoryMedium {
  const tables = new Map<string, Map<string, unknown>>();
  for (const [table, records] of Object.entries(seed ?? {})) tables.set(table, new Map(Object.entries(records)));
  return { tables };
}

/** Emulate the JSON medium's serialization boundary: only JSON-survivable data is stored. */
function serialize<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * In-memory medium implementing the measured `storageDomain` contract:
 * one write chain per port, durability first then memory, and a synchronous
 * transform invoked at its queue slot.
 *
 * Reads return the stored reference (no defensive copy), exactly like
 * `KvTable`; writing serializes through JSON, exactly like the JSON backend.
 */
export function createMemoryStoragePort(medium: MemoryMedium, options: MemoryPortOptions = {}): MemoryStoragePort {
  // Two distinct layers, mirroring the real stack:
  //  - `medium.tables` is the durable store (the JSON document / record files);
  //  - `memory` is the domain layer's authoritative read cache, seeded by the
  //    open-time load and mutated only AFTER a write is durable.
  const memory = new Map<string, Map<string, unknown>>();
  for (const [table, records] of medium.tables) memory.set(table, new Map(records));

  const journal: WriteEvent[] = [];
  let attempts = 0;
  let chain: Promise<unknown> = Promise.resolve();

  const mediumTableOf = (table: string, create: boolean): Map<string, unknown> | undefined => {
    let records = medium.tables.get(table);
    if (records === undefined && create) {
      records = new Map<string, unknown>();
      medium.tables.set(table, records);
    }
    return records;
  };

  const memoryTableOf = (table: string, create: boolean): Map<string, unknown> | undefined => {
    let records = memory.get(table);
    if (records === undefined && create) {
      records = new Map<string, unknown>();
      memory.set(table, records);
    }
    return records;
  };

  /** Queue one write job, mirroring `DomainImpl.enqueue`. */
  const enqueue = <T>(job: () => Promise<T>): Promise<T> => {
    const result = chain.then(job);
    chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const record = (kind: WriteEvent['kind'], table: string, key: string, error: unknown): void => {
    journal.push({
      kind,
      table,
      key,
      ok: error === undefined,
      attempt: attempts,
      error: error === undefined ? null : String(error instanceof Error ? error.message : error),
    });
  };

  /**
   * Durability first, memory second: a rejected write leaves the medium AND the
   * in-memory reads on the previous value, exactly like the real stack.
   */
  const durable = async (
    kind: WriteEvent['kind'],
    table: string,
    key: string,
    value: unknown,
    commitToMedium: () => void,
    commitToMemory: () => void,
  ): Promise<void> => {
    attempts += 1;
    const injected = options.beforeWrite?.({ kind, table, key, value, attempt: attempts });
    if (injected !== undefined) {
      record(kind, table, key, injected);
      throw injected;
    }
    try {
      commitToMedium();
      commitToMemory();
      record(kind, table, key, undefined);
    } catch (error) {
      record(kind, table, key, error);
      throw error;
    }
  };

  return {
    name: 'memory',
    journal,
    get attempts() {
      return attempts;
    },
    resetJournal() {
      journal.length = 0;
    },
    get<T>(table: string, key: string): T | undefined {
      return memory.get(table)?.get(key) as T | undefined;
    },
    entries<T>(table: string): IterableIterator<[string, T]> {
      return [...(memory.get(table)?.entries() ?? [])][Symbol.iterator]() as IterableIterator<[string, T]>;
    },
    keys(table: string): IterableIterator<string> {
      return [...(memory.get(table)?.keys() ?? [])][Symbol.iterator]();
    },
    size(table: string): number {
      return memory.get(table)?.size ?? 0;
    },
    put<T>(table: string, key: string, value: T): Promise<void> {
      const stored = serialize(value);
      return enqueue(() =>
        durable(
          'put',
          table,
          key,
          stored,
          () => {
            mediumTableOf(table, true)?.set(key, stored);
          },
          () => {
            memoryTableOf(table, true)?.set(key, stored);
          },
        ),
      );
    },
    delete(table: string, key: string): Promise<boolean> {
      return enqueue(async () => {
        const records = memoryTableOf(table, false);
        if (records === undefined || !records.has(key)) return false;
        await durable(
          'delete',
          table,
          key,
          undefined,
          () => {
            mediumTableOf(table, false)?.delete(key);
          },
          () => {
            records.delete(key);
          },
        );
        return true;
      });
    },
    update<T>(table: string, key: string, transform: (current: T) => T): Promise<T> {
      return enqueue(async () => {
        const records = memoryTableOf(table, false);
        if (records === undefined || !records.has(key)) {
          throw new PortError('missing-key', `table '${table}' has no record '${key}' to update`);
        }
        // The transform runs at this queue slot, against the value current now.
        const next = serialize(transform(records.get(key) as T));
        await durable(
          'update',
          table,
          key,
          next,
          () => {
            mediumTableOf(table, true)?.set(key, next);
          },
          () => {
            records.set(key, next);
          },
        );
        return next;
      });
    },
  };
}

/** The structural shape of `KvTable` in `@deepseek-ai/dsh-storage-domain`. */
export interface KvTableLike {
  get(key: string): unknown;
  entries(): IterableIterator<[string, unknown]>;
  keys(): IterableIterator<string>;
  readonly size: number;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  update(key: string, transform: (current: unknown) => unknown): Promise<unknown>;
}

/** The structural shape of `Domain` in `@deepseek-ai/dsh-storage-domain`. */
export interface DomainLike {
  readonly name: string;
  table(name: string): KvTableLike;
}

/**
 * Production adapter: drive a real `ctx.storageDomain` domain through the port.
 * Pass `await ctx.storageDomain.open(spec)` (see `buildDomainSpec`).
 */
export function createStorageDomainPort(domain: DomainLike): StoragePort {
  return {
    name: domain.name,
    get<T>(table: string, key: string): T | undefined {
      return domain.table(table).get(key) as T | undefined;
    },
    put<T>(table: string, key: string, value: T): Promise<void> {
      return domain.table(table).put(key, value);
    },
    delete(table: string, key: string): Promise<boolean> {
      return domain.table(table).delete(key);
    },
    update<T>(table: string, key: string, transform: (current: T) => T): Promise<T> {
      return domain.table(table).update(key, transform as (current: unknown) => unknown) as Promise<T>;
    },
    entries<T>(table: string): IterableIterator<[string, T]> {
      return domain.table(table).entries() as IterableIterator<[string, T]>;
    },
    keys(table: string): IterableIterator<string> {
      return domain.table(table).keys();
    },
    size(table: string): number {
      return domain.table(table).size;
    },
  };
}
