import { createPostgresGlobalRulesBuilder } from './create-postgres-global-rules-builder.js';
import { createPostgresLedgerBuilder } from './create-postgres-ledger-builder.js';
import { createPostgresLessonsBuilder } from './create-postgres-lessons-builder.js';
import { createPostgresTopologyBuilder } from './create-postgres-topology-builder.js';
import type { PostgresNamespace } from './postgres-namespace-contract.js';

/**
 * Frozen `postgres` builder namespace exported by `@metaharness/postgres`.
 *
 * Exposes `postgres.ledger(uri)`, `postgres.topologyStore(uri)`, `postgres.lessonStore(uri)`,
 * and `postgres.globalRules(uri, { table })` for declarative harness composition.
 */
export const postgres: PostgresNamespace = Object.freeze<PostgresNamespace>({
  ledger: createPostgresLedgerBuilder,
  topologyStore: createPostgresTopologyBuilder,
  lessonStore: createPostgresLessonsBuilder,
  globalRules: createPostgresGlobalRulesBuilder,
});
