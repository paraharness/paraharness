import type {
  LedgerStore,
  LessonStore,
  RuntimeDriverContext,
  RuntimeExecutorRegistrySlice,
  SqliteLedgerNode,
  SqliteLessonsNode,
  SqliteTopologyNode,
  TopologyStore,
} from '@harness-dsl/core';
import { SqliteLedgerStore } from '../stores/sqlite-ledger-store.js';
import { SqliteLessonStore } from '../stores/sqlite-lesson-store.js';
import { SqliteTopologyStore } from '../stores/sqlite-topology-store.js';
import { executeSqliteGlobalRulesSource } from './sqlite-rules-source-executor.js';

/**
 * Creates a `RuntimeExecutorRegistrySlice` registering all `@harness-dsl/sqlite` storage and source executors.
 *
 * Binds `'sqlite:ledger'`, `'sqlite:topology'`, `'sqlite:lessons'`, and `'sqlite:global-rules'`
 * with late-bound `ctx.resolveEnv(node.uri)` resolution and zero import-time I/O.
 *
 * @returns {RuntimeExecutorRegistrySlice} Frozen executor registry slice for `@harness-dsl/sqlite`.
 */
export function createSqliteExecutors(): RuntimeExecutorRegistrySlice {
  return Object.freeze<RuntimeExecutorRegistrySlice>({
    sources: Object.freeze({
      'sqlite:global-rules': executeSqliteGlobalRulesSource,
    }),
    ledgers: Object.freeze({
      'sqlite:ledger': (node: SqliteLedgerNode, ctx: RuntimeDriverContext): LedgerStore => {
        const uri = ctx.resolveEnv(node.uri) ?? node.uri;
        return new SqliteLedgerStore(uri);
      },
    }),
    topologies: Object.freeze({
      'sqlite:topology': (node: SqliteTopologyNode, ctx: RuntimeDriverContext): TopologyStore => {
        const uri = ctx.resolveEnv(node.uri) ?? node.uri;
        return new SqliteTopologyStore(uri);
      },
    }),
    lessons: Object.freeze({
      'sqlite:lessons': (node: SqliteLessonsNode, ctx: RuntimeDriverContext): LessonStore => {
        const uri = ctx.resolveEnv(node.uri) ?? node.uri;
        return new SqliteLessonStore(uri);
      },
    }),
  });
}
