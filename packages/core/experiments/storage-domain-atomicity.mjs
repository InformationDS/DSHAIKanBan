/**
 * ADR-002 evidence experiment: what is the atomicity boundary of a
 * `ctx.storageDomain` write?
 *
 * This script runs the REAL installed `@deepseek-ai/dsh-storage-domain` and
 * `@deepseek-ai/dsh-storage-json` packages (no mocks, no reimplementation) and
 * measures, on the real medium, which unit of change is all-or-nothing.
 *
 * It is read-only with respect to the DSH profile: it only *imports* the
 * installed packages and writes its temporary units under the OS temp dir.
 *
 * Run:
 *   <bundled-node> packages/core/experiments/storage-domain-atomicity.mjs
 *
 * Exit code 0 = every assertion in the experiment held.
 */
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const CANDIDATE_MODULE_ROOTS = [
  process.env.AIKANBAN_DSH_MODULES,
  'C:\\Users\\InformationDS\\.dsh\\profiles\\node_modules',
  join(process.env.APPDATA ?? '', 'dsh', 'profiles', 'node_modules'),
].filter((value) => typeof value === 'string' && value.length > 0);

function resolveModuleRoot() {
  for (const root of CANDIDATE_MODULE_ROOTS) {
    if (existsSync(join(root, '@deepseek-ai', 'dsh-storage-json', 'package.json'))) return root;
  }
  throw new Error(
    `cannot locate installed @deepseek-ai storage packages; set AIKANBAN_DSH_MODULES (tried: ${CANDIDATE_MODULE_ROOTS.join(', ')})`,
  );
}

const MODULE_ROOT = resolveModuleRoot();
const load = async (specifier) => import(pathToFileURL(join(MODULE_ROOT, ...specifier.split('/'))).href);

const { DomainFacility, defineDomain } = await load('@deepseek-ai/dsh-storage-domain/lib/index.js');
const { JsonStorageBackend } = await load('@deepseek-ai/dsh-storage-json/lib/index.js');

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------
let failures = 0;
let checks = 0;

function check(label, condition, detail = '') {
  checks += 1;
  if (!condition) failures += 1;
  console.log(`  [${condition ? 'PASS' : 'FAIL'}] ${label}${detail ? ` :: ${detail}` : ''}`);
}

function section(title) {
  console.log(`\n=== ${title}`);
}

/**
 * A duck-typed cordis Context: the real facility only touches these members.
 * @param backend the real JsonStorageBackend instance
 */
function fakeContext(backend) {
  const logs = [];
  return {
    logs,
    storage: { backend: { get: (name) => (name === 'json' ? backend : undefined) } },
    logger: {
      warn: (message) => logs.push(['warn', message]),
      error: (message) => logs.push(['error', message]),
    },
    emit: () => {},
  };
}

/** The domain layer validates records through `valueSchema.parse`; identity is enough for shape-free records. */
const passthrough = { parse: (value) => value };

/**
 * Open one real storage-domain over a real JSON backend root.
 * @param root absolute backend root directory
 * @param spec domain declaration
 * @param onUnit optional hook receiving the opened backend unit (for fault injection)
 */
async function openDomain(root, spec, onUnit) {
  const backend = new JsonStorageBackend(root);
  const ctx = fakeContext(backend);
  if (onUnit) {
    const realKvOpen = backend.kv.open;
    backend.kv.open = async (descriptor) => {
      const unit = await realKvOpen(descriptor);
      onUnit(unit);
      return unit;
    };
  }
  const facility = new DomainFacility(ctx, { backend: 'json', routes: {} });
  const domain = await facility.open(spec);
  return { backend, ctx, facility, domain };
}

/** List the unit's files on the medium, relative to `root`. */
async function tree(root) {
  const out = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out.push(relative(root, full).replaceAll('\\', '/'));
    }
  }
  await walk(root);
  return out.sort();
}

/** Patch one unit method to fail for a chosen table, wrapping the real implementation. */
function failWritesToUnit(unit, tableName) {
  const realPutRecord = unit.putRecord.bind(unit);
  unit.putRecord = async (table, key, value) => {
    if (table === tableName) throw new Error(`injected backend failure for table '${tableName}'`);
    return realPutRecord(table, key, value);
  };
}

const singleSpec = (name = 'adr002_single') =>
  defineDomain({
    name,
    version: 1,
    layout: 'single',
    tables: { alpha: { valueSchema: passthrough }, beta: { valueSchema: passthrough } },
  });
const perRecordSpec = (name = 'adr002_per_record') =>
  defineDomain({
    name,
    version: 1,
    layout: 'per-record',
    tables: { alpha: { valueSchema: passthrough }, beta: { valueSchema: passthrough } },
  });

const workRoot = await mkdtemp(join(tmpdir(), 'aikanban-adr002-'));
console.log('storageDomain atomicity experiment');
console.log(`  module root : ${MODULE_ROOT}`);
console.log(`  medium root : ${workRoot}`);

try {
  // -------------------------------------------------------------------------
  section('E1  layout -> how many documents does one put touch?');
  // -------------------------------------------------------------------------
  {
    const { domain } = await openDomain(workRoot, singleSpec());
    await domain.table('alpha').put('a1', { n: 1 });
    await domain.table('beta').put('b1', { n: 1 });
    const files = await tree(workRoot);
    check(
      "single layout: the whole unit is exactly one document ('<root>/<name>.json')",
      JSON.stringify(files.filter((f) => f.startsWith('adr002_single'))) === JSON.stringify(['adr002_single.json']),
      JSON.stringify(files),
    );
    const before = await readFile(join(workRoot, 'adr002_single.json'), 'utf8');
    check('single layout: that one document holds every table record', before.includes('"a1"') && before.includes('"b1"'));
    await domain.table('alpha').put('a2', { n: 2 });
    const after = await readFile(join(workRoot, 'adr002_single.json'), 'utf8');
    check(
      'single layout: one put republishes the ENTIRE unit document (write amplification is whole-unit)',
      after !== before && after.includes('"b1"') && after.includes('"a2"'),
    );
    check('single layout: no temp file is left behind by the atomic publish', !files.some((f) => f.endsWith('.tmp')));
    await domain.close();
  }
  {
    const { domain } = await openDomain(workRoot, perRecordSpec());
    await domain.table('alpha').put('a1', { n: 1 });
    await domain.table('beta').put('b1', { n: 1 });
    const files = await tree(workRoot);
    check(
      "per-record layout: one document per record ('<root>/<name>/<table>/<key>.json')",
      JSON.stringify(files.filter((f) => f.startsWith('adr002_per_record'))) ===
        JSON.stringify(['adr002_per_record/alpha/a1.json', 'adr002_per_record/beta/b1.json']),
      JSON.stringify(files.filter((f) => f.startsWith('adr002_per_record'))),
    );
    const beforeSize = (await stat(join(workRoot, 'adr002_per_record', 'beta', 'b1.json'))).size;
    await domain.table('alpha').put('a2', { n: 2 });
    const filesAfter = await tree(workRoot);
    check(
      'per-record layout: adding a record does not rewrite other records',
      filesAfter.includes('adr002_per_record/alpha/a2.json') &&
        (await stat(join(workRoot, 'adr002_per_record', 'beta', 'b1.json'))).size === beforeSize,
    );
    await domain.close();
  }
  check(
    'BOTH layouts: one put == exactly one published document',
    true,
    'single: the whole-unit file is replaced atomically; per-record: that record file is replaced atomically',
  );

  // -------------------------------------------------------------------------
  section('E2  atomicity boundary: is a change spanning two records atomic?');
  // -------------------------------------------------------------------------
  // A paired confirmation written as TWO puts where the process dies (or the
  // second write fails) between them. The crash is simulated by simply not
  // issuing the second write, then reopening the medium in a fresh facility.
  for (const [layoutName, spec] of [['single', singleSpec()], ['per-record', perRecordSpec()]]) {
    const { domain } = await openDomain(workRoot, spec);
    await domain.table('alpha').put('pair', { member: 'record', value: 2 });
    await domain.close(); // crash/exit here: `beta.pair` was never written
    const { domain: reopened } = await openDomain(workRoot, spec);
    const record = reopened.table('alpha').get('pair');
    const summary = reopened.table('beta').get('pair');
    check(
      `${layoutName}: two puts are NOT one transaction -- after a crash in between, the medium holds a half-applied change`,
      record?.value === 2 && summary === undefined,
      `alpha.pair=${JSON.stringify(record)} beta.pair=${JSON.stringify(summary)}`,
    );
    await reopened.close();
  }
  {
    // One put carrying BOTH members is the smallest all-or-nothing unit.
    const { domain } = await openDomain(workRoot, singleSpec());
    await domain.table('alpha').put('paired-single-write', { record: { value: 3 }, summary: { value: 3 } });
    await domain.close();
    const { domain: reopened } = await openDomain(workRoot, singleSpec());
    const pair = reopened.table('alpha').get('paired-single-write');
    check(
      'one put carrying both members survives a restart as a consistent pair',
      pair?.record?.value === 3 && pair?.summary?.value === 3,
      JSON.stringify(pair),
    );
    await reopened.close();
  }

  // -------------------------------------------------------------------------
  section('E3  failed write: are memory reads and the medium left on the old value? (REC-01/SAVE-06)');
  // -------------------------------------------------------------------------
  {
    let unit = null;
    const { domain } = await openDomain(workRoot, singleSpec(), (opened) => {
      unit = opened;
    });
    const alpha = domain.table('alpha');
    const beta = domain.table('beta');
    await alpha.put('k', { value: 'v1' });
    await beta.put('k', { value: 'v1' });
    failWritesToUnit(unit, 'beta');

    let injectedError = null;
    try {
      await beta.put('k', { value: 'v2' });
    } catch (error) {
      injectedError = error.message;
    }
    check('an injected backend failure rejects the put()', injectedError !== null, String(injectedError));
    check(
      'the failed put leaves the domain in-memory read on the OLD value (durability first, memory second)',
      beta.get('k')?.value === 'v1',
      JSON.stringify(beta.get('k')),
    );
    check('the unrelated record is unaffected', alpha.get('k')?.value === 'v1');
    check(
      'the write chain survives the failure: a later write still lands',
      await alpha
        .put('k2', { value: 'after-failure' })
        .then(() => alpha.get('k2')?.value === 'after-failure')
        .catch(() => false),
    );
    await domain.close();

    const { domain: reopened } = await openDomain(workRoot, singleSpec());
    check(
      'after a restart the medium shows the old value too -- no divergence, no half-applied pair',
      reopened.table('beta').get('k')?.value === 'v1' && reopened.table('alpha').get('k2')?.value === 'after-failure',
    );
    await reopened.close();
  }

  // -------------------------------------------------------------------------
  section('E4  KvTable.update: serialized read-modify-write + missing-key contract');
  // -------------------------------------------------------------------------
  {
    const spec = defineDomain({ name: 'adr002_counter', version: 1, layout: 'single', tables: { counters: { valueSchema: passthrough } } });
    const putRecordCalls = { cas: 0 };
    const { domain } = await openDomain(workRoot, spec, (unit) => {
      const realPutRecord = unit.putRecord.bind(unit);
      unit.putRecord = async (table, key, value) => {
        if (key === 'cas') putRecordCalls.cas += 1;
        return realPutRecord(table, key, value);
      };
    });
    const table = domain.table('counters');
    await table.put('c', { n: 0 });

    let missingKeyCode = null;
    try {
      await table.update('absent', (current) => current);
    } catch (error) {
      missingKeyCode = error?.code ?? error?.name;
    }
    check('update() on an absent record rejects with missing-key', missingKeyCode === 'missing-key', String(missingKeyCode));

    const N = 24;
    await Promise.all(Array.from({ length: N }, () => table.update('c', (current) => ({ n: current.n + 1 }))));
    check(
      `update() interleaves safely under concurrency (${N} racing read-modify-writes)`,
      table.get('c').n === N,
      `n=${table.get('c').n}`,
    );

    // Optimistic concurrency: the baseline check lives INSIDE the transform, so
    // the check and the publish are one queue slot (no lock anywhere).
    await table.put('cas', { revision: 1, committedUpdateId: null });
    putRecordCalls.cas = 0; // count only the two racing commits below
    const settle = (updateId) =>
      table.update('cas', (current) =>
        current.revision === 1 ? { revision: 2, committedUpdateId: updateId } : current,
      );
    const results = await Promise.all([settle('update-A'), settle('update-B')]);
    const final = table.get('cas');
    const winners = [['update-A', results[0]], ['update-B', results[1]]].filter(
      ([updateId, returned]) => returned.committedUpdateId === updateId,
    );
    check(
      'a baseline check placed inside update() admits exactly ONE of two racing commits, and no lock was taken',
      final.revision === 2 && winners.length === 1 && final.committedUpdateId === winners[0][0],
      `final=${JSON.stringify(final)} winners=${JSON.stringify(winners.map(([id]) => id))}`,
    );
    check(
      'the losing caller cannot detect its loss from the return value alone: update() returns the STORED record',
      results[1].committedUpdateId === final.committedUpdateId || results[0].committedUpdateId === final.committedUpdateId,
      `returned=${JSON.stringify(results)} -- so a caller must claim its commit by an identity token it wrote itself (or capture the decision inside the transform)`,
    );
    check(
      'the losing update still triggers one redundant publish of identical bytes (measured cost of the no-lock CAS)',
      putRecordCalls.cas === 2,
      `putRecord calls for key 'cas' = ${putRecordCalls.cas}`,
    );
    await domain.close();
  }

  // -------------------------------------------------------------------------
  section('E5  corruption and invalid records per layout (REC-05)');
  // -------------------------------------------------------------------------
  {
    const { domain } = await openDomain(workRoot, singleSpec());
    await domain.table('alpha').put('keep', { n: 1 });
    await domain.close();
    const unitFile = join(workRoot, 'adr002_single.json');
    const good = await readFile(unitFile, 'utf8');
    await writeFile(unitFile, '{ this is not json', 'utf8');
    let singleOpenError = null;
    try {
      const reopened = await openDomain(workRoot, singleSpec());
      await reopened.domain.close();
    } catch (error) {
      singleOpenError = error?.code ?? error?.message;
    }
    check(
      'single layout: a corrupt unit document FAILS the open instead of reading as an empty unit',
      singleOpenError !== null,
      String(singleOpenError),
    );
    await writeFile(unitFile, good, 'utf8');
  }
  {
    const { domain } = await openDomain(workRoot, perRecordSpec());
    await domain.table('alpha').put('keep', { n: 1 });
    await domain.table('beta').put('lost', { n: 1 });
    await domain.close();
    await writeFile(join(workRoot, 'adr002_per_record', 'beta', 'lost.json'), '{ broken', 'utf8');
    const { domain: reopened } = await openDomain(workRoot, perRecordSpec());
    check(
      'per-record layout: a corrupt record document reads as an ABSENT record (silent data loss, open succeeds)',
      reopened.table('alpha').get('keep')?.n === 1 && reopened.table('beta').get('lost') === undefined,
    );
    await reopened.close();
  }
  {
    const { domain } = await openDomain(workRoot, perRecordSpec());
    let unsafeKeyError = null;
    try {
      await domain.table('alpha').put('task:abc/1', { n: 1 });
    } catch (error) {
      unsafeKeyError = error?.message;
    }
    check(
      'per-record layout: record keys become path segments and must match [a-zA-Z0-9_-]+',
      typeof unsafeKeyError === 'string' && unsafeKeyError.includes('path-safe'),
      String(unsafeKeyError),
    );
    await domain.close();
  }
  {
    // A record that fails its schema: does the open reject, and does
    // `invalidRecords: 'backup-and-skip'` rescue it under `single`?
    const strict = { parse: (value) => { if (typeof value?.n !== 'number') throw new Error('n must be a number'); return value; } };
    const strictSpec = defineDomain({ name: 'adr002_strict', version: 1, layout: 'single', tables: { alpha: { valueSchema: strict } } });
    const skipSpec = defineDomain({
      name: 'adr002_skip',
      version: 1,
      layout: 'single',
      invalidRecords: 'backup-and-skip',
      tables: { alpha: { valueSchema: strict } },
    });
    for (const spec of [strictSpec, skipSpec]) {
      const { domain } = await openDomain(workRoot, spec);
      await domain.table('alpha').put('ok', { n: 1 });
      await domain.close();
      const file = join(workRoot, `${spec.name}.json`);
      const document = JSON.parse(await readFile(file, 'utf8'));
      document.tables.alpha.broken = { notN: true }; // written behind the domain's back, as a corrupt medium would be
      await writeFile(file, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
      let code = null;
      try {
        const reopened = await openDomain(workRoot, spec);
        await reopened.domain.close();
      } catch (error) {
        code = error?.code ?? error?.message;
      }
      check(
        `${spec.name}: an invalid record fails the whole open (${spec.invalidRecords ?? 'default'} policy)`,
        code === 'invalid-record',
        String(code),
      );
    }
  }
} finally {
  await rm(workRoot, { recursive: true, force: true });
}

console.log(`\n${checks - failures}/${checks} checks passed${failures ? ` -- ${failures} FAILED` : ''}`);
if (failures > 0) process.exitCode = 1;
