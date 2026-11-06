import type { PendingPreFlightCall } from '../ports/pending-tool-batch.js';
import type { ToolEffect } from '../ports/tool-effect.js';

/**
 * Aggregated policy violation descriptor passed to `.onViolation(...)` mappers when a guard clause rejects a tool call or batch.
 *
 * Groups all blocked tool calls and their unleased violating effects for a single guard clause
 * so the violation mapper can format an in-band error message or construct an interrupt payload.
 */
export interface PolicyViolation {
  /** Blocked tool call descriptors sharing the violated guard clause. */
  readonly blockedCalls: readonly PendingPreFlightCall[];
  /** Flattened list of `ToolEffect` items that violated the guard and lacked an active lease. */
  readonly violatedEffects: readonly ToolEffect[];
  /** Human- and model-readable summary of the policy violation. */
  readonly violationSummary: string;
}
