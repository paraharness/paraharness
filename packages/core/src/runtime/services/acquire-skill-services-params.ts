import type { InlineSkillNode } from '../../ast/inline-skill-node.js';
import type { RuntimeDriverContext } from '../../ports/runtime-driver-context.js';

/**
 * Parameters for acquiring skill-backed `ServiceSession` daemons in an isolation scope.
 *
 * Supplies the run identifier, canonical scope key, scope handle, skill node, and runtime driver context.
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
