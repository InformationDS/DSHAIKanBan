/**
 * Shared test harness.
 *
 * The harness is deliberately thin: it wires the real core model to an
 * in-memory port that reproduces the measured `storageDomain` contract
 * (one write chain, durability before memory, `update` at its queue slot), and
 * it exposes the durable-write journal so tests can assert on the NUMBER of
 * writes a confirmation performs -- which is the whole point of ADR-002.
 */
import { createMemoryMedium, createMemoryStoragePort } from '../src/port.ts';
import type { MemoryMedium, MemoryStoragePort, MemoryPortOptions } from '../src/port.ts';
import { createKanbanCore } from '../src/core.ts';
import type {
  BaselineExpectation,
  Conclusion,
  ConclusionState,
  ContentSection,
  KanbanCore,
  ObjectContent,
  ObjectKind,
  ScopeKind,
  ScopeStateRecord,
} from '../src/types.ts';

export interface Fault {
  readonly error: Error;
  remaining: number;
  readonly match: (event: { readonly kind: string; readonly table: string; readonly key: string; readonly attempt: number }) => boolean;
}

export interface Harness {
  readonly core: KanbanCore;
  readonly medium: MemoryMedium;
  readonly port: MemoryStoragePort;
  /** Durable writes recorded so far, filtered to one table. */
  writes(table?: string): number;
  resetJournal(): void;
  /** Make the next matching durable write fail. */
  failNext(match: Fault['match'], error?: Error, times?: number): void;
  clearFaults(): void;
  /** A brand-new port over the SAME medium: exactly a process restart. */
  restart(): Harness;
  /** Deterministic, strictly increasing clock. */
  readonly clock: () => string;
}

let clockSeed = 0;

function makeClock(): () => string {
  return () => {
    clockSeed += 1;
    const seconds = String(clockSeed % 60).padStart(2, '0');
    const minutes = String(Math.floor(clockSeed / 60) % 60).padStart(2, '0');
    return `2026-01-01T00:${minutes}:${seconds}.000Z`;
  };
}

function attach(medium: MemoryMedium, faults: Fault[]): Harness {
  const options: MemoryPortOptions = {
    beforeWrite: (event) => {
      for (const fault of faults) {
        if (fault.remaining > 0 && fault.match(event)) {
          fault.remaining -= 1;
          return fault.error;
        }
      }
      return undefined;
    },
  };
  const port = createMemoryStoragePort(medium, options);
  const clock = makeClock();
  const core = createKanbanCore({ port, now: clock });
  const harness: Harness = {
    core,
    medium,
    port,
    clock,
    writes(table) {
      return port.journal.filter((event) => event.ok && (table === undefined || event.table === table)).length;
    },
    resetJournal() {
      port.resetJournal();
    },
    failNext(match, error = new Error('injected backend failure'), times = 1) {
      faults.push({ error, match, remaining: times });
    },
    clearFaults() {
      faults.length = 0;
    },
    restart() {
      return attach(medium, faults);
    },
  };
  return harness;
}

/** A fresh core over a fresh medium. */
export function createHarness(): Harness {
  return attach(createMemoryMedium(), []);
}

/** Build one content body from section bodies. */
export function content(...bodies: readonly (string | ContentSection)[]): ObjectContent {
  return {
    sections: bodies.map((body, index) =>
      typeof body === 'string' ? { id: `s${index + 1}`, title: `Section ${index + 1}`, body } : body,
    ),
    conclusions: [],
  };
}

/** Build a content body with conclusions. */
export function contentWith(sections: readonly ContentSection[], conclusions: readonly Conclusion[]): ObjectContent {
  return { sections, conclusions };
}

/** A conclusion helper. */
export function conclusion(id: string, text: string, statedState: ConclusionState = 'current'): Conclusion {
  return { id, text, statedState };
}

/** The baseline expectation a review screen would hold for a pair. */
export function expectationOf(
  core: KanbanCore,
  input: { scopeKind: ScopeKind; scopeId: string; recordObjectId: string },
): BaselineExpectation {
  const scope = core.readScopeState(input);
  if (scope === null) throw new Error(`no scope ${input.scopeKind}/${input.scopeId}`);
  const recordKind: ObjectKind = input.scopeKind === 'task' ? 'taskRecord' : 'projectRecord';
  const summaryKind: ObjectKind = input.scopeKind === 'task' ? 'taskSummary' : 'projectOverview';
  return {
    revision: scope.revision,
    applicabilityRevision: scope.applicabilityRevision,
    baseVersionIds: {
      record: scope.current[recordKind][input.recordObjectId] ?? null,
      summary: scope.current[summaryKind][input.scopeId] ?? null,
    },
  };
}

/** Create a task scope with one linked conversation. */
export async function seedTask(
  harness: Harness,
  taskId = 'task-1',
  conversationId = 'conv-1',
): Promise<void> {
  await harness.core.ensureScope({ scopeKind: 'task', scopeId: taskId });
  await harness.core.linkConversation({ taskId, conversationId });
}

/** Create a project scope with one linked outcome task. */
export async function seedProject(harness: Harness, projectId = 'proj-1', taskId = 'outcome-1'): Promise<void> {
  await harness.core.ensureScope({ scopeKind: 'project', scopeId: projectId });
  await harness.core.linkOutcomeTask({ projectId, taskId });
}

/** Read the raw head record for structural assertions. */
export function scopeStateOf(harness: Harness, scopeKind: ScopeKind, scopeId: string): ScopeStateRecord {
  const scope = harness.core.readScopeState({ scopeKind, scopeId });
  if (scope === null) throw new Error(`no scope ${scopeKind}/${scopeId}`);
  return scope;
}
