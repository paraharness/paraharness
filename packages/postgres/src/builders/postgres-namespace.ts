import type { EnvRef } from '@harness-dsl/core';
import { createPostgresGlobalRulesBuilder } from './create-postgres-global-rules-builder.js';
import { createPostgresLedgerBuilder } from './create-postgres-ledger-builder.js';
import { createPostgresLessonsBuilder } from './create-postgres-lessons-builder.js';
import { createPostgresTopologyBuilder } from './create-postgres-topology-builder.js';
import type { PostgresGlobalRulesBuilder } from './postgres-global-rules-builder.js';
import type { PostgresGlobalRulesOptions } from './postgres-global-rules-options.js';
import type { PostgresLedgerBuilder } from './postgres-ledger-builder.js';
import type { PostgresLessonsBuilder } from './postgres-lessons-builder.js';
import type { PostgresNamespace } from './postgres-namespace-contract.js';
import type { PostgresTopologyBuilder } from './postgres-topology-builder.js';

/**
 * Frozen `postgres` builder namespace exported by `@harness-dsl/postgres`.
 *
 * Exposes `postgres.ledger(uri)`, `postgres.topologyStore(uri)`, `postgres.lessonStore(uri)`,
 * and `postgres.globalRules(uri, { table })` for declarative harness composition.
 */
export const postgres: PostgresNamespace = Object.freeze<PostgresNamespace>({
  ledger(uri: string | EnvRef): PostgresLedgerBuilder {
    return createPostgresLedgerBuilder(uri);
  },
  topologyStore(uri: string | EnvRef): PostgresTopologyBuilder {
    return createPostgresTopologyBuilder(uri);
  },
  lessonStore(uri: string | EnvRef): PostgresLessonsBuilder {
    return createPostgresLessonsBuilder(uri);
  },
  globalRules(uri: string | EnvRef, options: PostgresGlobalRulesOptions): PostgresGlobalRulesBuilder {
    return createPostgresGlobalRulesBuilder(uri, options);
  },
});
