import type { SpeculateContinuationFrame } from '../../ports/speculate-continuation-frame.js';

/**
 * Outcome returned by `executeSpeculateTournament()` for the parent assistant turn batch.
 *
 * Carries the serialized `tool_result` string, error status, and final `SpeculateContinuationFrame`.
 */
export interface SpeculateTournamentResult {
  /** Serialized `tool_result` JSON string returned to the parent agent. */
  readonly toolResultText: string;
  /** True when all branches failed or the arbiter rejected all candidates. */
  readonly isError: boolean;
  /** Final settled `SpeculateContinuationFrame`. */
  readonly tournamentFrame: SpeculateContinuationFrame;
}
