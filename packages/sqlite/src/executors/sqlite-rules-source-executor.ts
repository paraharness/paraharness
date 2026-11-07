import { createHash } from 'node:crypto';
import {
  type GlobalRule,
  GlobalRuleSchema,
  type ResolutionContext,
  type ResolvedSourceArtifact,
  type SqliteRulesSourceNode,
  z,
} from '@harness-dsl/core';
import {
  assertValidSqlIdentifier,
  openSqliteConnection,
} from '../ddl/internal/open-sqlite-connection.js';

/**
 * Executes a `SqliteRulesSourceNode` (`type: 'sqlite:global-rules'`) to load ordered global rules.
 *
 * Validates `node.table` against `^[A-Za-z_][A-Za-z0-9_]*$`, queries `SELECT id, directive FROM <table> ORDER BY id ASC`,
 * validates all rows via `z.array(GlobalRuleSchema)`, and computes a deterministic SHA-256 hex digest.
 *
 * @param {SqliteRulesSourceNode} node   - Passive SQLite global rules source AST node.
 * @param {void}                  _input - Unused source executor input parameter.
 * @param {ResolutionContext}     ctx    - Active source resolution context.
 *
 * @returns {Promise<ResolvedSourceArtifact<readonly GlobalRule[]>>} Validated global rules and SHA-256 digest.
 */
export function executeSqliteGlobalRulesSource(
  node: SqliteRulesSourceNode,
  _input: void,
  ctx: ResolutionContext,
): Promise<ResolvedSourceArtifact<readonly GlobalRule[]>> {
  assertValidSqlIdentifier(node.table, 'table');
  const resolvedUri = ctx.resolveEnv(node.uri) ?? node.uri;
  if (resolvedUri.trim().length === 0) {
    throw new Error(
      `Cannot execute SqliteRulesSourceNode '${node.id}': resolved database URI is empty.`,
    );
  }
  const db = openSqliteConnection(resolvedUri);
  try {
    const rawRows = db
      .prepare(`SELECT id, directive FROM "${node.table}" ORDER BY id ASC`)
      .all();
    const parsedRules = z.array(GlobalRuleSchema).parse(rawRows);
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
    return Promise.resolve(
      Object.freeze<ResolvedSourceArtifact<readonly GlobalRule[]>>({
        content: Object.freeze(frozenRules),
        digest,
      }),
    );
  } finally {
    db.close();
  }
}
