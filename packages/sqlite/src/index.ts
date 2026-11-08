export type {
  SqliteLedgerNode,
  SqliteLessonsNode,
  SqliteRulesSourceNode,
  SqliteTopologyNode,
} from '@paraharness/core';
export type {
  CompactionConfigBuilder,
  CompactionSignalTriggerOptions,
  CompactionTerminalExitOptions,
} from './builders/compaction-config-builder.js';
export { createCompactionConfigBuilder } from './builders/create-compaction-config-builder.js';
export { createSqliteGlobalRulesBuilder } from './builders/create-sqlite-global-rules-builder.js';
export { createSqliteLedgerBuilder } from './builders/create-sqlite-ledger-builder.js';
export { createSqliteLessonsBuilder } from './builders/create-sqlite-lessons-builder.js';
export { createSqliteTopologyBuilder } from './builders/create-sqlite-topology-builder.js';
export type { SqliteGlobalRulesBuilder } from './builders/sqlite-global-rules-builder.js';
export type { SqliteLedgerBuilder } from './builders/sqlite-ledger-builder.js';
export type { SqliteLessonsBuilder } from './builders/sqlite-lessons-builder.js';
export type {
  SqliteGlobalRulesOptions,
  SqliteNamespace,
} from './builders/sqlite-namespace-contract.js';
export { sqlite } from './builders/sqlite-namespace.js';
export type { SqliteTopologyBuilder } from './builders/sqlite-topology-builder.js';
export {
  assertValidSqlIdentifier,
  openSqliteConnection,
} from './ddl/internal/open-sqlite-connection.js';
export {
  SQLITE_DDL_STATEMENTS,
  SQLITE_PRAGMA_STATEMENTS,
  SQL_IDENTIFIER_REGEX,
} from './ddl/sqlite-schema.constants.js';
export { createSqliteExecutors } from './executors/create-sqlite-executors.js';
export { sqliteExecutors } from './executors/sqlite-executors.constants.js';
export { executeSqliteGlobalRulesSource } from './executors/sqlite-rules-source-executor.js';
export {
  computeNormalizedRelevance,
  computeNormalizedRelevanceScores,
} from './stores/internal/compute-normalized-relevance.js';
export { SqliteLedgerStore } from './stores/sqlite-ledger-store.js';
export { SqliteLessonStore } from './stores/sqlite-lesson-store.js';
export { SqliteTopologyStore } from './stores/sqlite-topology-store.js';

