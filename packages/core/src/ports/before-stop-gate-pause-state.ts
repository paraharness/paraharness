/**
 * Pause state on `agent-frame` when an actor has emitted its structured output and is inside `beforeStop` gates.
 *
 * Indicates that tool calls are complete and deterministic `beforeStop` checks are being evaluated.
 */
export interface BeforeStopGatePauseState {
  /** Discriminant identifying the `beforeStop` verification gate phase. */
  readonly kind: 'before-stop-gate';
}
