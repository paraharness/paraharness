import type { InterruptNode } from '../../ast/interrupt-node.js';
import type {
  PendingPreFlightCall,
  RemainingToolCallRecord,
} from '../../ports/pending-tool-batch.js';
import type { ToolEffect } from '../../ports/tool-effect.js';

/**
 * Result of evaluating pre-flight or post-flight policy guard clauses (`SPEC.md` §3.5).
 *
 * Distinguishes clean passage (`'allowed'`), in-band denial (`'denied-with-error'`), and
 * batched or single-call interrupt escalation (`'raise-interrupt'`).
 */
export interface PolicyEvaluationResult {
  /** Outcome status of the policy guard evaluation. */
  readonly status: 'allowed' | 'denied-with-error' | 'raise-interrupt';
  /** Predicted or synthesized `ToolEffect` descriptors for the primary evaluated tool call. */
  readonly primaryEffects: readonly ToolEffect[];
  /** Identifier of the violated guard clause when `status !== 'allowed'`. */
  readonly violatedClauseId?: string;
  /** Formatted in-band error message when `status === 'denied-with-error'`. */
  readonly deniedErrorMessage?: string;
  /** Raised `InterruptNode` when `status === 'raise-interrupt'`. */
  readonly raisedInterrupt?: InterruptNode<unknown>;
  /** Validated interrupt payload produced by `clause.mapViolation` when `status === 'raise-interrupt'`. */
  readonly interruptPayload?: unknown;
  /** Batched blocked calls failing the exact same `'raise-interrupt'` clause $C$. */
  readonly blockedCalls?: readonly PendingPreFlightCall[];
  /** Updated `remainingCalls` `(i..k)` with `blockedPreFlight: true` and `adjudicatedClauseIds` tagged on batched calls. */
  readonly updatedRemainingCalls?: readonly RemainingToolCallRecord[];
}
