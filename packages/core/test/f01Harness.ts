/**
 * F01 test fixtures.
 *
 * Two projects deliberately share the SAME title: ADR-003 measured that two
 * different workspace paths may carry the same title, so every isolation test
 * must be able to prove that identity comes from `workspace.id` and never from
 * the display name.
 */
import assert from 'node:assert/strict';
import type { Harness } from './harness.ts';
import type { BoardReadResult, CreateTaskOutcome, ProjectView, TaskView } from '../src/types.ts';

export const PROJECT_A = 'ws-03696d17-12c2-4d78-9b3e-ff3bdf9e6f10';
export const PROJECT_B = 'ws-7f4a2c11-9c33-4f10-8a55-1234567890ab';
export const PATH_A = 'D:\\BaiduSyncdisk\\work\\alpha';
export const PATH_B = 'D:\\BaiduSyncdisk\\work\\beta';
/** A third id that never gets registered. */
export const PROJECT_MISSING = 'ws-nobody-registered-this';

export const SAME_TITLE = 'AIKanBan';

/** Register one project and assert the registration landed. */
export async function registerProject(
  harness: Harness,
  projectId: string,
  title = SAME_TITLE,
  path = PATH_A,
): Promise<ProjectView> {
  const outcome = await harness.core.registerProject({ projectId, title, path });
  assert.equal(outcome.status, 'registered', `registration of ${projectId} failed: ${JSON.stringify(outcome)}`);
  return outcome.project;
}

/** Register the two same-titled projects every isolation test needs. */
export async function registerBoth(harness: Harness): Promise<void> {
  await registerProject(harness, PROJECT_A, SAME_TITLE, PATH_A);
  await registerProject(harness, PROJECT_B, SAME_TITLE, PATH_B);
}

/** Narrow a board read to its successful variant. */
export function okBoard(result: BoardReadResult): Extract<BoardReadResult, { status: 'ok' }> {
  if (result.status !== 'ok') {
    throw new Error(`expected an ok board, got '${result.status}': ${JSON.stringify(result)}`);
  }
  return result;
}

/** Narrow a creation to a task-bearing variant. */
export function taskOf(result: CreateTaskOutcome): TaskView {
  if (result.status !== 'created' && result.status !== 'already-created') {
    throw new Error(`expected a task, got '${result.status}': ${JSON.stringify(result)}`);
  }
  return result.task;
}

/** Every returned task must carry its own project id (F01-R01: no cross-project bleed). */
export function assertAttribution(tasks: readonly TaskView[], projectId: string): void {
  for (const task of tasks) {
    assert.equal(task.projectId, projectId, `task '${task.taskId}' leaked into project '${projectId}'`);
  }
}
