import type { InlineSkillNode } from '../../ast/inline-skill-node.js';
import type { RuntimeDriverContext } from '../../ports/runtime-driver-context.js';

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
