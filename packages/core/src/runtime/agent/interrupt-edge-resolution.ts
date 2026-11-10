import type { InterruptHandlerNode } from '../../ast/interrupt-handler-node.types.js';
import type { LeaseDelta } from '../../ports/lease-delta.js';

/**
 * Outcome returned by `resolveInterruptEdge()` when handling a policy, voluntary, or child interrupt (`SPEC.md` §3.5 & §3.6).
 *
 * Distinguishes in-band resumption (`status: 'resumed'`), step replacement (`status: 'replace'`),
 * and upward propagation (`status: 'unhandled'`).
 *
 * @template THandle Runtime handle type of the active isolation scope.
 */
export interface InterruptEdgeResolution<THandle = unknown> {
  /** Resolution status of the interrupt edge. */
  readonly status: 'resumed' | 'replace' | 'unhandled';
  /** Feedback string returned by `.resumeWith(...)` when `status === 'resumed'`. */
  readonly feedback?: string;
  /** Capability leases granted by `.elevateLeaseWhen(...)` during adjudication. */
  readonly grantedLeases: readonly LeaseDelta[];
  /** Matched `.replaceWith(...)` handler when `status === 'replace'`. */
  readonly replaceHandler?: InterruptHandlerNode<unknown, unknown, THandle>;
  /** Raised interrupt identifier. */
  readonly interruptId: string;
  /** Validated interrupt payload. */
  readonly payload: unknown;
  /** Optional abort metadata produced by `P.policy.onLimitExceeded` cleanup (`SPEC.md` §3.9). */
  readonly abortMeta?: Record<string, unknown>;
  /** True when this resolution originated from a `.onLimitExceeded()` epistemic flush sequence. */
  readonly isLimitExceeded?: boolean;
}
