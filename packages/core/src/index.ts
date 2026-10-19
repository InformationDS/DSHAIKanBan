/**
 * Public surface of `@aikanban/core`.
 *
 * Host integration (`packages/plugin`) needs three things from here:
 *  1. `buildDomainSpec(zod)` + `AIKANBAN_*` to open the domain:
 *     `createStorageDomainPort(await ctx.storageDomain.open(defineDomain(buildDomainSpec(z))))`;
 *  2. `createKanbanCore({ port })` to get the model;
 *  3. `createMemoryStoragePort(createMemoryMedium())` for tests.
 *
 * @module @aikanban/core
 */

export * from './types.ts';
export { createKanbanCore } from './core.ts';
export { isConfirmableDraftState } from './scopeRecord.ts';
export { CoreError, PortError, createMemoryMedium, createMemoryStoragePort, createStorageDomainPort } from './port.ts';
export type { PlanningApi, PlanningDeps } from './planning.ts';
export type { ActivityInput } from './scopeRecord.ts';
export {
  BOARD_COLUMNS,
  TASK_STATUSES,
  TASK_STATUS_LABELS,
  TASK_STATUS_SET,
  WORK_SCOPE_AVAILABILITIES,
  WORK_SCOPE_AVAILABILITY_SET,
  compareTasks,
  encodeTaskId,
  isCosmeticGoalChange,
  isTaskStatus,
  isTerminalStatus,
  isValidTaskTitle,
  isWorkScopeAvailability,
  normalizeGoal,
  normalizeTaskTitle,
  progressLineOf,
  statusLabelOf,
  statusRank,
  summarize,
  taskIdOf,
} from './taskModel.ts';
export {
  CANDIDATE_STATES,
  EMPTY_CONTENT,
  appendActivity,
  computeRecheck,
  emptyScope,
  markRecheck,
  normalizeScope,
  readAllScopeRecords,
  readScopeRecord,
} from './scopeRecord.ts';
export type {
  DomainLike,
  KvTableLike,
  MemoryMedium,
  MemoryPortOptions,
  MemoryStoragePort,
  StoragePort,
  WriteEvent,
} from './port.ts';
export {
  AIKANBAN_DOMAIN_LAYOUT,
  AIKANBAN_DOMAIN_NAME,
  AIKANBAN_DOMAIN_VERSION,
  AIKANBAN_TABLES,
  AIKANBAN_TABLE_LIST,
  amendmentIdOf,
  buildDomainSpec,
  draftKey,
  isDraftRecord,
  isObjectContent,
  isScopeStateRecord,
  pairShapeOf,
  scopeKey,
  versionIdOf,
} from './domainSpec.ts';
export type { DomainSpecLike, TableName, ZodLike } from './domainSpec.ts';
export { canonicalJson, collapseWhitespace, encodeKey, fingerprint } from './keys.ts';
