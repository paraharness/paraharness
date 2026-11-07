import type { MaybeBuilder } from '../../ast/ast-foundation.types.js';
import type {
  AbortHookASTNode,
  PolicyGuardASTNode,
} from '../../ast/domain-ast.types.js';
import { extractAST } from '../../ast/extract-ast.js';
import type { DenyWithErrorPolicyGuardClauseNode } from '../../ast/deny-with-error-policy-guard-clause-node.js';
import type { InterruptNode } from '../../ast/interrupt-node.js';
import type { PolicyGuardClauseNode } from '../../ast/policy-guard-clause-node.types.js';
import type { PolicyLimitExceededConfig } from '../../ast/policy-node.js';
import type { PolicyViolation } from '../../ast/policy-violation.js';
import type { RaiseInterruptPolicyGuardClauseNode } from '../../ast/raise-interrupt-policy-guard-clause-node.js';
import type {
  PolicyBuilder,
  PolicyGuardClauseBuilder as PolicyGuardClausePendingBuilder,
  PolicyLimitExceededBuilder,
} from '../policy-builder.js';
import { deepFreeze } from './deep-freeze.js';

/**
 * Type guard checking whether `secondArg` in `onViolation('deny-with-error', secondArg)` is a message mapper function.
 *
 * Returns `true` when `arg` is `undefined` or a function `(violation: PolicyViolation) => string`.
 *
 * @template TPayload Interrupt payload type.
 *
 * @param {((violation: PolicyViolation) => string) | MaybeBuilder<InterruptNode<TPayload>> | undefined} arg - Candidate second argument.
 *
 * @returns {arg is ((violation: PolicyViolation) => string) | undefined} True when `arg` is `undefined` or a function.
 */
function isMessageMapper<TPayload>(
  arg: ((violation: PolicyViolation) => string) | MaybeBuilder<InterruptNode<TPayload>> | undefined,
): arg is ((violation: PolicyViolation) => string) | undefined {
  return arg === undefined || typeof arg === 'function';
}

/**
 * Creates a `PolicyLimitExceededBuilder` for `H.policy(id).onLimitExceeded($limit => ...)`.
 *
 * Captures the mandatory flush interrupt and optional abort hook invoked when
 * a policy resource budget ceiling is breached.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {string}                                             policyId         - Owning policy identifier.
 * @param {InterruptNode<unknown>}                             [flushInterrupt] - Configured flush interrupt node.
 * @param {AbortHookASTNode<THandle, Record<string, unknown>>} [abortHook]      - Optional abort hook node.
 *
 * @returns {PolicyLimitExceededBuilder<THandle>} Frozen limit-exceeded builder.
 */
export function createPolicyLimitExceededBuilder<THandle>(
  policyId: string,
  flushInterrupt?: InterruptNode<unknown>,
  abortHook?: AbortHookASTNode<THandle, Record<string, unknown>>,
): PolicyLimitExceededBuilder<THandle> {
  return Object.freeze<PolicyLimitExceededBuilder<THandle>>({
    flushWithInterrupt<TPayload = unknown>(
      intr: MaybeBuilder<InterruptNode<TPayload>>,
    ): PolicyLimitExceededBuilder<THandle> {
      return createPolicyLimitExceededBuilder<THandle>(policyId, extractAST(intr), abortHook);
    },
    onAbort<TAbortMeta extends Record<string, unknown> = Record<string, unknown>>(
      hook: MaybeBuilder<AbortHookASTNode<THandle, TAbortMeta>>,
    ): PolicyLimitExceededBuilder<THandle> {
      return createPolicyLimitExceededBuilder<THandle>(policyId, flushInterrupt, extractAST(hook));
    },
    build: (): PolicyLimitExceededConfig<THandle> => {
      if (flushInterrupt === undefined) {
        throw new Error(
          `Policy '${policyId}' .onLimitExceeded(...) requires .flushWithInterrupt(interrupt).`,
        );
      }
      return deepFreeze<PolicyLimitExceededConfig<THandle>>({ flushInterrupt, abortHook });
    },
  });
}

/**
 * Creates a `PolicyGuardClausePendingBuilder` for `H.policy(id).guard(...guards)`.
 *
 * Compiles `.onViolation('deny-with-error', ...)` or `.onViolation('raise-interrupt', ...)`
 * into a frozen `PolicyGuardClauseNode` and appends it to the owning `PolicyBuilder`.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {string}                                                    clauseId        - Deterministic clause identifier.
 * @param {readonly PolicyGuardASTNode[]}                             extractedGuards - Guard AST nodes in this clause.
 * @param {(clause: PolicyGuardClauseNode) => PolicyBuilder<THandle>} appendClause    - Callback returning the updated `PolicyBuilder`.
 *
 * @returns {PolicyGuardClausePendingBuilder<THandle>} Frozen pending clause builder.
 */
export function createPolicyGuardClausePendingBuilder<THandle>(
  clauseId: string,
  extractedGuards: readonly PolicyGuardASTNode[],
  appendClause: (clause: PolicyGuardClauseNode) => PolicyBuilder<THandle>,
): PolicyGuardClausePendingBuilder<THandle> {
  return Object.freeze<PolicyGuardClausePendingBuilder<THandle>>({
    onViolation<TPayload = unknown>(
      mode: 'deny-with-error' | 'raise-interrupt',
      secondArg?: ((violation: PolicyViolation) => string) | MaybeBuilder<InterruptNode<TPayload>>,
      thirdArg?: (violation: PolicyViolation) => TPayload,
    ): PolicyBuilder<THandle> {
      if (mode === 'deny-with-error') {
        const messageMapper = isMessageMapper(secondArg) ? secondArg : undefined;
        return appendClause(deepFreeze<DenyWithErrorPolicyGuardClauseNode>({
          type: 'harness:policy-guard-clause',
          id: clauseId,
          guards: Object.freeze(extractedGuards),
          mode: 'deny-with-error',
          messageMapper,
        }));
      }
      if (isMessageMapper(secondArg) || thirdArg === undefined) {
        throw new Error(
          `Policy guard clause '${clauseId}' with mode 'raise-interrupt' requires an InterruptNode and mapViolation callback.`,
        );
      }
      return appendClause(deepFreeze<RaiseInterruptPolicyGuardClauseNode<TPayload>>({
        type: 'harness:policy-guard-clause',
        id: clauseId,
        guards: Object.freeze(extractedGuards),
        mode: 'raise-interrupt',
        interrupt: extractAST(secondArg),
        mapViolation: thirdArg,
      }));
    },
  });
}
