/**
 * Host-half data layer: open the `aikanban_core` storage domain and create the
 * core model over it.
 *
 * ## Why this module imports neither the host packages nor zod
 *
 * `ctx.storageDomain.open(spec)` consumes a `DomainSpec`: names plus one
 * `valueSchema` per table. The core deliberately has no zod dependency — its
 * `buildDomainSpec(zod)` accepts any object exposing `custom(check)` whose
 * result exposes `parse(value)` (`packages/core/src/domainSpec.ts`). The shim
 * below satisfies exactly that surface, so the host bundle gains no package
 * resolution and no bare specifier (`tools/verify-host-import.mjs` scans the
 * *built* graph; see docs/engineering/s1-wiring.md §5.2 and §5.3).
 *
 * ## Contracts
 *
 * - Nothing here throws. Every failure is a {@link DataLayerFailure} result:
 *   the caller is `apply()`, where a rejected promise may be treated as a host
 *   crash.
 * - Opening includes one real read through the domain. A domain whose medium
 *   cannot be read is not "ready", even if `open()` resolved.
 *
 * @module @aikanban/dsh-aikanban/data-layer
 */

import {
  AIKANBAN_DOMAIN_NAME,
  buildDomainSpec,
  createKanbanCore,
  createStorageDomainPort,
  type DomainLike,
  type KanbanCore,
} from '@aikanban/core'

/** The subset of `ctx.storageDomain` the host half uses. */
export interface StorageDomainLike {
  open(spec: unknown): Promise<unknown>
}

/**
 * Tolerant probe for the host `storageDomain` service.
 *
 * @param value - a candidate service (as delivered by `ctx.reflect.get`).
 * @returns whether it can open a domain.
 */
export function isStorageDomainLike(value: unknown): value is StorageDomainLike {
  if (typeof value !== 'object' || value === null) return false
  return typeof (value as { open?: unknown }).open === 'function'
}

/** The one zod call `buildDomainSpec` makes. */
interface SchemaShimLike {
  custom(check: (value: unknown) => boolean, params?: { readonly message?: string }): { parse(value: unknown): unknown }
}

/**
 * Build the zod-shaped validator shim `buildDomainSpec` consumes.
 *
 * The real zod is never called: the domain layer only invokes
 * `valueSchema.parse(raw)` when loading stored records, and the core's own
 * validators (`isScopeStateRecord`/`isDraftRecord`) are the checks that matter.
 *
 * @returns a validator factory with the `custom()` surface the core expects.
 */
export function createSchemaShim(): SchemaShimLike {
  return {
    custom(check, params) {
      return {
        parse(value: unknown): unknown {
          if (!check(value)) throw new Error(params?.message ?? 'invalid aikanban record')
          return value
        },
      }
    },
  }
}

/** The domain handle `open()` returned is structurally usable. */
function isDomainLike(value: unknown): value is DomainLike {
  if (typeof value !== 'object' || value === null) return false
  const domain = value as { name?: unknown; table?: unknown }
  return typeof domain.name === 'string' && typeof domain.table === 'function'
}

/** The data layer is open: the host-owned domain plus the core built over it. */
export interface DataLayerReady {
  readonly ok: true
  readonly domain: DomainLike
  readonly core: KanbanCore
}

/** The data layer did not open. Never thrown — returned. */
export interface DataLayerFailure {
  readonly ok: false
  /** Which step failed (diagnostic only; never travels the wire). */
  readonly stage: 'open-failed' | 'invalid-domain' | 'read-failed' | 'create-failed'
  readonly message: string
}

/** Result of one data-layer bootstrap attempt. */
export type DataLayerOpenResult = DataLayerReady | DataLayerFailure

/**
 * Open the `aikanban_core` domain through the host's `storageDomain` service
 * and create the core model over it.
 *
 * @param storageDomain - the host facility (`ctx.storageDomain`).
 * @returns the opened domain and core, or the failure stage and message.
 */
export async function openDataLayer(storageDomain: StorageDomainLike): Promise<DataLayerOpenResult> {
  let opened: unknown
  try {
    opened = await storageDomain.open(buildDomainSpec(createSchemaShim()))
  } catch (error) {
    return { ok: false, stage: 'open-failed', message: `storageDomain.open 拒绝了 aikanban_core 域：${messageOf(error)}` }
  }
  if (!isDomainLike(opened)) {
    return {
      ok: false,
      stage: 'invalid-domain',
      message: `storageDomain.open 返回的域不可用（需要 name + table()）：${describe(opened)}`,
    }
  }
  if (opened.name !== AIKANBAN_DOMAIN_NAME) {
    return {
      ok: false,
      stage: 'invalid-domain',
      message: `storageDomain.open 返回了意外的域名 ${JSON.stringify(opened.name)}`,
    }
  }
  let core: KanbanCore
  try {
    core = createKanbanCore({ port: createStorageDomainPort(opened) })
  } catch (error) {
    return { ok: false, stage: 'create-failed', message: `createKanbanCore 失败：${messageOf(error)}` }
  }
  // One read through the opened domain: `open()` resolving is not evidence that
  // the medium is readable. A missing draft is the expected answer; a throw
  // means the domain is not usable as a data layer.
  try {
    core.getDraft('aikanban-open-probe')
  } catch (error) {
    return { ok: false, stage: 'read-failed', message: `域已打开但读取失败：${messageOf(error)}` }
  }
  return { ok: true, domain: opened, core }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function describe(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'object') {
    return `object keys=[${Object.keys(value as Record<string, unknown>).join(',')}]`
  }
  return typeof value
}
