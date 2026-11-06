import type {
  AbortHookASTNode,
  QuotaTripwireASTNode,
} from '../ast/domain-ast.types.js';
import type { PolicyGuardClauseNode } from '../ast/policy-guard-clause-node.js';
import type { PolicyLimitExceededConfig } from '../ast/policy-node.js';

/**
 * Optional copy-on-write state for `createPolicyBuilder`.
 *
 * Holds accumulated guard clauses, quota tripwires, quantitative resource limits,
 * default abort hook, and limit-exceeded configuration.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 */
export interface CreatePolicyBuilderState<THandle = unknown> {
  /** Accumulated guard clauses. */
  readonly clauses?: readonly PolicyGuardClauseNode[];
  /** Accumulated quota tripwires. */
  readonly tripwires?: readonly QuotaTripwireASTNode[];
  /** Optional max turns ceiling. */
  readonly maxTurns?: number;
  /** Optional max cost USD ceiling. */
  readonly maxCostUsd?: number;
  /** Optional max duration seconds ceiling. */
  readonly maxDurationSeconds?: number;
  /** Optional default abort hook. */
  readonly abortHook?: AbortHookASTNode<THandle, Record<string, unknown>>;
  /** Optional limit-exceeded configuration. */
  readonly onLimitExceeded?: PolicyLimitExceededConfig<THandle>;
}

export type { CreatePolicyBuilderState as CreatePolicyBuilderOptions };
