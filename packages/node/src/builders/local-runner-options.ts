/**
 * Configuration options for creating a local OS subprocess and daemon runner pool (`local.runner`).
 *
 * Defines the concurrency limits separating one-shot subprocess slots (`slots`) from long-lived
 * background daemon sessions (`maxDaemons`).
 */
export interface LocalRunnerOptions {
  /** Optional unique identifier for the runner pool (defaults to `'default-runner'`). */
  readonly id?: string;
  /** Maximum number of concurrent one-shot command or stream-check subprocesses. */
  readonly slots: number;
  /** Optional maximum number of concurrent background daemon sessions (defaults to `slots`). */
  readonly maxDaemons?: number;
}
