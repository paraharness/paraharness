import type { SpeculateArbiterDecision } from '../../ast/speculate-arbiter-decision.types.js';

/**
 * Result returned by `runTournamentArbiterWithGate()` containing both the raw verdict and normalized decision.
 *
 * Guarantees that `decision` passed built-in `beforeStop` candidate index validation against `branches`.
 */
export interface ValidatedArbiterTurnResult {
  /** Raw structured verdict emitted by `arbiter.actor`. */
  readonly verdict: unknown;
  /** Normalized `SpeculateArbiterDecision` validated against surviving/parked branch indices. */
  readonly decision: SpeculateArbiterDecision;
}
