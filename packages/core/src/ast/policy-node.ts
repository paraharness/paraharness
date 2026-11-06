import type { AbortHookASTNode, QuotaTripwireASTNode } from './domain-ast.types.js';
import type { InterruptNode } from './interrupt-node.js';
import type { PolicyGuardClauseNode } from './policy-guard-clause-node.js';

/**
 * Epistemic flush and abort hook configuration executed when a quantitative policy limit or tripwire is breached.
 *
 * Forces a final tool-disabled (`toolChoice: 'none'`) structured-output turn against `flushInterrupt.schema`
 * before executing `abortHook` and raising `flushInterrupt` upward.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 */
export interface PolicyLimitExceededConfig<THandle = unknown> {
  /** Interrupt flushed via a final `toolChoice: 'none'` structured-output turn before aborting. */
  readonly flushInterrupt: InterruptNode<unknown>;
  /** Optional abort hook executed after the epistemic flush turn completes. */
  readonly abortHook?: AbortHookASTNode<THandle, Record<string, unknown>>;
}

/**
 * Passive AST node representing a capability and sandbox policy (`H.policy(id)`).
 *
 * Governs pre-flight and post-flight tool guard evaluation, quantitative turn/cost/duration/tripwire
 * ceilings, and deterministic scope cleanup hooks.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 */
export interface PolicyNode<THandle = unknown> {
  /** Discriminant identifying a policy AST node. */
  readonly type: 'harness:policy';
  /** Unique identifier of the policy. */
  readonly id: string;
  /** Ordered list of two-phase guard clauses (`'deny-with-error'` evaluated before `'raise-interrupt'`). */
  readonly clauses: readonly PolicyGuardClauseNode[];
  /** Domain quota tripwires evaluated post-flight after each allowed tool execution. */
  readonly tripwires: readonly QuotaTripwireASTNode[];
  /** Optional maximum LLM generation turns allowed before tripping `onLimitExceeded`. */
  readonly maxTurns?: number;
  /** Optional maximum cumulative USD cost allowed before tripping `onLimitExceeded`. */
  readonly maxCostUsd?: number;
  /** Optional maximum cumulative wall-clock duration in seconds allowed before tripping `onLimitExceeded`. */
  readonly maxDurationSeconds?: number;
  /** Optional default abort hook executed when the governed step is aborted or replaced. */
  readonly abortHook?: AbortHookASTNode<THandle, Record<string, unknown>>;
  /** Optional epistemic flush and abort sequence triggered when any quantitative limit or tripwire trips. */
  readonly onLimitExceeded?: PolicyLimitExceededConfig<THandle>;
}
