import { createSqliteGlobalRulesBuilder } from './create-sqlite-global-rules-builder.js';
import { createSqliteLedgerBuilder } from './create-sqlite-ledger-builder.js';
import { createSqliteLessonsBuilder } from './create-sqlite-lessons-builder.js';
import { createSqliteTopologyBuilder } from './create-sqlite-topology-builder.js';
import type { SqliteNamespace } from './sqlite-namespace-contract.js';

/**
 * Pure AST builder namespace for `@harness-dsl/sqlite` storage and source adapters.
 *
 * Exposes `sqlite.ledger`, `sqlite.topologyStore`, `sqlite.lessonStore`, and `sqlite.globalRules`
 * with zero import-time or declaration-time side effects.
 */
export const sqlite: SqliteNamespace = Object.freeze<SqliteNamespace>({
  ledger: createSqliteLedgerBuilder,
  topologyStore: createSqliteTopologyBuilder,
  lessonStore: createSqliteLessonsBuilder,
  globalRules: createSqliteGlobalRulesBuilder,
});
