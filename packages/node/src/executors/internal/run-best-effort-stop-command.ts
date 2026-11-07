import {
  spawnDetachedSubprocess,
  terminateProcessGroupWithGrace,
  type ResolvedSubprocessEnvironment,
} from './process-group-lifecycle.js';

/**
 * Executes a daemon `.stopCommand` best-effort to reap crash-orphaned containers or processes.
 *
 * Swallows non-zero exit codes and spawn errors so pre-start or post-stop cleanup never masks
 * primary daemon lifecycle transitions.
 *
 * @param {readonly string[] | undefined} argv        - Optional stop command argument vector.
 * @param {ResolvedSubprocessEnvironment} resolvedEnv - Resolved working directory and environment variables.
 *
 * @returns {Promise<void>} Resolves once the best-effort stop command finishes or is skipped.
 */
export async function runBestEffortStopCommand(
  argv: readonly string[] | undefined,
  resolvedEnv: ResolvedSubprocessEnvironment,
): Promise<void> {
  if (argv === undefined || argv.length === 0) {
    return;
  }
  try {
    const child = spawnDetachedSubprocess({ argv, resolvedEnv });
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        void terminateProcessGroupWithGrace(child).then(resolve);
      }, 3_000);
      child.once('error', () => {
        clearTimeout(timer);
        resolve();
      });
      child.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  } catch {
    return;
  }
}
