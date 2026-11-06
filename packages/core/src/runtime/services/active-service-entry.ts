import type { ServiceASTNode } from '../../ast/domain-ast.types.js';
import type { InlineSkillNode } from '../../ast/inline-skill-node.js';
import type { RuntimeDriverContext } from '../../ports/runtime-driver-context.js';
import type { ServiceSession } from '../../ports/service-session.js';

/**
 * Parameters for acquiring or re-acquiring skill-backed `ServiceSession` daemons in an isolation scope.
 *
 * Supplies the run identifier, canonical scope key, scope handle, skill node(s), and runtime driver context.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 */
export interface AcquireSkillServicesParams<THandle = unknown> {
  /** Unique identifier of the enclosing harness run. */
  readonly runId: string;
  /** Canonical scope key identifying the isolation scope (`'root'`, fork ID, or branch key). */
  readonly scopeKey: string;
  /** Active isolation scope handle where services are mounted. */
  readonly scopeHandle: THandle;
  /** Resolved `InlineSkillNode` whose `unlockedServices` should be acquired. */
  readonly skill: InlineSkillNode<THandle>;
  /** Runtime driver context providing `registry`, `resolveEnv`, and `getRunner`. */
  readonly driverContext: RuntimeDriverContext;
}

/**
 * Parameters for re-acquiring all active skill services prior to draining `remainingCalls` on resume (`SPEC.md` §3.4.2).
 *
 * Supplies the active skill identifiers, resolved skill map, scope coordinates, and runtime driver context.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 */
export interface ReacquireSkillServicesParams<THandle = unknown> {
  /** Unique identifier of the enclosing harness run. */
  readonly runId: string;
  /** Canonical scope key identifying the isolation scope. */
  readonly scopeKey: string;
  /** Active isolation scope handle where services are remounted. */
  readonly scopeHandle: THandle;
  /** Active skill identifiers persisted in `agent-frame.activeSkillIds` or `loop-frame.activeSkillIds`. */
  readonly activeSkillIds: readonly string[];
  /** Lookup map of resolved `InlineSkillNode` definitions keyed by `skill.id`. */
  readonly skillsById: ReadonlyMap<string, InlineSkillNode<THandle>>;
  /** Runtime driver context providing `registry`, `resolveEnv`, and `getRunner`. */
  readonly driverContext: RuntimeDriverContext;
}

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
  /** Optional reference to acquire parameters for property reachability. */
  readonly acquireTemplate?: AcquireSkillServicesParams<THandle>;
  /** Optional reference to reacquire parameters for property reachability. */
  readonly reacquireTemplate?: ReacquireSkillServicesParams<THandle>;
}
