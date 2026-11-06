import type { ResolvedSubprocessEnvironment } from './spawn-detached-subprocess-params.js';

/**
 * Parameters for executing a buffered one-shot subprocess via `runBufferedSubprocess`.
 *
 * Supplies the command identifier, argument vector, resolved environment, optional stdin payload,
 * timeout duration, and abort signal.
 */
export interface RunBufferedSubprocessParams {
  /** Logical identifier of the command for diagnostic error messages. */
  readonly commandId: string;
  /** Command argument vector where index `0` is the executable. */
  readonly argv: readonly string[];
  /** Resolved working directory and environment variables. */
  readonly resolvedEnv: ResolvedSubprocessEnvironment;
  /** Optional standard input payload written before closing stdin. */
  readonly stdinPayload?: string | Uint8Array;
  /** Optional execution timeout in minutes. */
  readonly timeoutMinutes?: number;
  /** Optional abort signal cancelling subprocess execution. */
  readonly signal?: AbortSignal;
}
