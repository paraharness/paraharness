import type { ServiceASTNode } from '../../ast/domain-ast.types.js';
import type { ServiceSession } from '../../ports/service-session.js';

/**
 * Reference-counted runtime entry tracking a live `ServiceSession` mounted within an isolation scope (`SPEC.md` §3.4.2).
 *
 * Shares a single background daemon across multiple concurrently active skills that unlock the same `serviceNode.id`,
 * stopping the daemon only when `holdingSkillIds` becomes empty or the scope quiesces.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 */
export interface ActiveServiceEntry<THandle = unknown> {
  /** Canonical scope key where the service is mounted. */
  readonly scopeKey: string;
  /** Passive service AST node that spawned `session`. */
  readonly serviceNode: ServiceASTNode<THandle>;
  /** Live background daemon session instance. */
  readonly session: ServiceSession<THandle>;
  /** Set of currently active skill IDs holding a reference lease on this service session. */
  readonly holdingSkillIds: Set<string>;
}
