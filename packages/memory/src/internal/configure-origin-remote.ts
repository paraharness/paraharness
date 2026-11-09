import { MemoryHarnessError } from '../memory-harness-error.js';
import { execGitCommand } from './exec-git-command.js';

/**
 * Configures the `origin` remote URL inside `checkoutDir` (`remote add` or `remote set-url`).
 *
 * @param {string} checkoutDir - Absolute path to the `.memory` Git checkout directory.
 * @param {string} remoteUrl   - Configured `storage.git.remoteUrl`.
 *
 * @returns {Promise<void>} Resolves once `origin` is configured to `remoteUrl`.
 *
 * @throws {MemoryHarnessError} With `'GIT_SYNC_FAILED'` if configuring `origin` fails.
 */
export async function configureOriginRemote(
  checkoutDir: string,
  remoteUrl: string,
): Promise<void> {
  const addRes = await execGitCommand({
    cwd: checkoutDir,
    args: ['remote', 'add', 'origin', remoteUrl],
  });
  if (addRes.exitCode === 0) {
    return;
  }
  const setRes = await execGitCommand({
    cwd: checkoutDir,
    args: ['remote', 'set-url', 'origin', remoteUrl],
  });
  if (setRes.exitCode !== 0) {
    throw new MemoryHarnessError(
      'GIT_SYNC_FAILED',
      `Failed to configure origin remote '${remoteUrl}' in '${checkoutDir}': ${setRes.stderr}`,
      { checkoutDir, remoteUrl, stderr: setRes.stderr },
    );
  }
}
