/**
 * Sends a POSIX signal to `pid` (or process group `-pid`) while ignoring `ESRCH` if already exited.
 *
 * Encapsulates best-effort signal delivery during process-group teardown.
 *
 * @param {number}         pid    - Process ID or negative process-group ID.
 * @param {NodeJS.Signals} signal - POSIX signal name (`'SIGTERM'` or `'SIGKILL'`).
 */
export function sendProcessSignalBestEffort(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') {
      return;
    }
  }
}

/**
 * Checks whether an OS process with `pid` is currently alive via `process.kill(pid, 0)`.
 *
 * Returns `false` when the kernel reports `ESRCH` and `true` when the process exists.
 *
 * @param {number} pid - Positive OS process ID to probe.
 *
 * @returns {boolean} True if the process still exists in the OS process table.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Checks whether any process ID in `pids` is still alive in the OS process table.
 *
 * Short-circuits on the first live process ID found.
 *
 * @param {Iterable<number>} pids - Candidate process IDs to probe.
 *
 * @returns {boolean} True when at least one PID in `pids` is still alive.
 */
export function isAnyTrackedPidAlive(pids: Iterable<number>): boolean {
  for (const candidatePid of pids) {
    if (isProcessAlive(candidatePid)) {
      return true;
    }
  }
  return false;
}

/**
 * Polls `trackedPids` until all processes exit or `graceMs` elapses.
 *
 * Used between `SIGTERM` and `SIGKILL` escalation in `terminatePidTreeWithGrace`.
 *
 * @param {ReadonlySet<number>} trackedPids - Descendant and leader PIDs being terminated.
 * @param {number}              graceMs     - Maximum wait duration in milliseconds.
 *
 * @returns {Promise<void>} Resolves once all tracked PIDs exit or the grace deadline expires.
 */
export async function waitForPidTreeExit(
  trackedPids: ReadonlySet<number>,
  graceMs: number,
): Promise<void> {
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!isAnyTrackedPidAlive(trackedPids)) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 15));
  }
}
