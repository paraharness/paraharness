/**
 * Active-turn pause state on `agent-frame` when no tool batch or adjudication is suspended.
 *
 * Optionally tracks `inFlightPreToolCheckpoint` while a post-flight-diffed subprocess tool is executing.
 */
export interface ActiveTurnPauseState {
  /** Discriminant identifying an active LLM turn or idle post-turn boundary. */
  readonly kind: 'active-turn';
  /** Optional pre-tool checkpoint token persisted while a post-flight-diffed subprocess tool is executing. */
  readonly inFlightPreToolCheckpoint?: string;
}
