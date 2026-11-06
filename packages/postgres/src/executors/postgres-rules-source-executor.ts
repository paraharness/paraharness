import { createHash } from 'node:crypto';
import {
  type GlobalRule,
  GlobalRuleSchema,
  type PostgresRulesSourceNode,
  type ResolutionContext,
  type ResolvedSourceArtifact,
  z,
} from '@harness-dsl/core';
import {
  assertValidPostgresIdentifier,
  resolvePostgresClient,
} from '../ddl/internal/resolve-postgres-client.js';
import type { PostgresPoolFactory } from '../ddl/postgres-pool-factory.js';
import type { PostgresQueryClient } from '../ddl/postgres-query-client.js';

/**
 * Executes a `PostgresRulesSourceNode` (`type: 'postgres:global-rules'`) to load ordered global rules.
 *
 * Validates `node.table` against `^[A-Za-z_][A-Za-z0-9_]*$`, queries `SELECT id, directive FROM "<table>" ORDER BY id ASC`,
 * validates all rows via `z.array(GlobalRuleSchema)`, and computes a deterministic SHA-256 hex digest.
 *
 * @param {PostgresRulesSourceNode}                     node          - Passive PostgreSQL global rules source AST node.
 * @param {ResolutionContext}                           ctx           - Active source resolution context.
 * @param {PostgresPoolFactory | PostgresQueryClient}   [poolFactory] - Pool factory or query client used to run the query.
 *
 * @returns {Promise<ResolvedSourceArtifact<readonly GlobalRule[]>>} Validated global rules and SHA-256 digest.
 */
export async function executePostgresGlobalRulesSource(
  node: PostgresRulesSourceNode,
  ctx: ResolutionContext,
  poolFactory?: PostgresPoolFactory | PostgresQueryClient,
): Promise<ResolvedSourceArtifact<readonly GlobalRule[]>> {
  assertValidPostgresIdentifier(node.table, 'table');
  if (poolFactory === undefined) {
    throw new Error(
      `Cannot execute PostgresRulesSourceNode '${node.id}': no PostgresPoolFactory or PostgresQueryClient was provided to createPostgresExecutors().`,
    );
  }
  const client = await resolvePostgresClient(
    node.uri,
    (value) => ctx.resolveEnv(value),
    poolFactory,
  );
  const queryResult = await client.query<{ readonly id: string; readonly directive: string }>(
    `SELECT id, directive FROM "${node.table}" ORDER BY id ASC`,
  );
  const parsedRules = z.array(GlobalRuleSchema).parse(queryResult.rows);
  const frozenRules: GlobalRule[] = [];
  for (const rule of parsedRules) {
    frozenRules.push(
      Object.freeze<GlobalRule>({
        id: rule.id,
        directive: rule.directive,
      }),
    );
  }
  const digest = createHash('sha256')
    .update(JSON.stringify(frozenRules), 'utf8')
    .digest('hex');
  return Object.freeze<ResolvedSourceArtifact<readonly GlobalRule[]>>({
    content: Object.freeze(frozenRules),
    digest,
  });
}
