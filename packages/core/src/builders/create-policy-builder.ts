import type { MaybeBuilder } from '../ast/ast-foundation.types.js';
import type {
  AbortHookASTNode,
  PolicyGuardASTNode,
  QuotaTripwireASTNode,
} from '../ast/domain-ast.types.js';
import { extractAST } from '../ast/extract-ast.js';
import type { PolicyGuardClauseNode } from '../ast/policy-guard-clause-node.types.js';
import type { PolicyNode } from '../ast/policy-node.js';
import type { CreatePolicyBuilderState as CreatePolicyBuilderOptions } from './create-policy-builder-state.js';
import { assertNonEmptyIdentifier, deepFreeze } from './internal/deep-freeze.js';
import {
  createPolicyGuardClausePendingBuilder,
  createPolicyLimitExceededBuilder,
  rekeyPolicyGuardClauses,
} from './internal/policy-sub-builders.js';
import type {
  PolicyBuilder,
  PolicyGuardClauseBuilder as PolicyGuardClausePendingBuilder,
  PolicyLimitExceededBuilder,
} from './policy-builder.js';

/**
 * Creates a fluent `PolicyBuilder` for `H.policy(id)`.
 *
 * Assigns deterministic guard clause identifiers `"${id}:clause:${i}"` and supports
 * `.extend(newId)` inheritance with re-keyed clause identifiers.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {string}                              id        - Unique identifier of the policy.
 * @param {CreatePolicyBuilderOptions<THandle>} [options] - Optional internal copy-on-write state.
 *
 * @returns {PolicyBuilder<THandle>} Frozen `PolicyBuilder` instance.
 */
export function createPolicyBuilder<THandle = unknown>(
  id: string,
  options?: CreatePolicyBuilderOptions<THandle>,
): PolicyBuilder<THandle> {
  assertNonEmptyIdentifier('H.policy', id);
  const currentClauses = options?.clauses ?? Object.freeze([]);
  const currentTripwires = options?.tripwires ?? Object.freeze([]);

  return Object.freeze<PolicyBuilder<THandle>>({
    id,
    guard(...guards: ReadonlyArray<MaybeBuilder<PolicyGuardASTNode>>): PolicyGuardClausePendingBuilder<THandle> {
      const extractedGuards = guards.map((guard) => extractAST(guard));
      return createPolicyGuardClausePendingBuilder<THandle>(
        `${id}:clause:${currentClauses.length}`,
        extractedGuards,
        (clause: PolicyGuardClauseNode) =>
          createPolicyBuilder<THandle>(id, { ...options, clauses: Object.freeze([...currentClauses, clause]) }),
      );
    },
    tripwire(...tripwires: ReadonlyArray<MaybeBuilder<QuotaTripwireASTNode>>): PolicyBuilder<THandle> {
      const next = [...currentTripwires, ...tripwires.map((tw) => extractAST(tw))];
      return createPolicyBuilder<THandle>(id, { ...options, tripwires: Object.freeze(next) });
    },
    maxTurns: (turns: number) => createPolicyBuilder<THandle>(id, { ...options, maxTurns: turns }),
    maxCostUsd: (costUsd: number) => createPolicyBuilder<THandle>(id, { ...options, maxCostUsd: costUsd }),
    maxDurationSeconds: (seconds: number) =>
      createPolicyBuilder<THandle>(id, { ...options, maxDurationSeconds: seconds }),
    onAbort: (hook: MaybeBuilder<AbortHookASTNode<THandle, Record<string, unknown>>>) =>
      createPolicyBuilder<THandle>(id, { ...options, abortHook: extractAST(hook) }),
    onLimitExceeded: (configure: ($limit: PolicyLimitExceededBuilder<THandle>) => PolicyLimitExceededBuilder<THandle>) => {
      const built = configure(createPolicyLimitExceededBuilder<THandle>(id)).build();
      return createPolicyBuilder<THandle>(id, { ...options, onLimitExceeded: built });
    },
    extend(newId: string): PolicyBuilder<THandle> {
      assertNonEmptyIdentifier('H.policy.extend', newId);
      return createPolicyBuilder<THandle>(newId, {
        ...options,
        clauses: rekeyPolicyGuardClauses(newId, currentClauses),
        tripwires: currentTripwires,
      });
    },
    toAST(): PolicyNode<THandle> {
      return deepFreeze<PolicyNode<THandle>>({
        type: 'harness:policy',
        id,
        clauses: currentClauses,
        tripwires: currentTripwires,
        maxTurns: options?.maxTurns,
        maxCostUsd: options?.maxCostUsd,
        maxDurationSeconds: options?.maxDurationSeconds,
        abortHook: options?.abortHook,
        onLimitExceeded: options?.onLimitExceeded,
      });
    },
  });
}
