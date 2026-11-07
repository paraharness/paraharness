import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * Initializes a git repository and commits all current files inside `rootDir`.
 *
 * Configures a local test author identity and disables GPG signing so commits succeed in any environment.
 *
 * @param {string} rootDir - Canonical workspace directory path.
 *
 * @returns {Promise<string>} Resolved `HEAD` commit SHA.
 */
export async function initGitRepositoryWithBaseCommit(rootDir: string): Promise<string> {
  const execFileAsync = promisify(execFile);
  await execFileAsync('git', ['init', '-q'], { cwd: rootDir });
  await execFileAsync('git', ['add', '-A'], { cwd: rootDir });
  await execFileAsync(
    'git',
    [
      '-c',
      'user.name=HarnessTest',
      '-c',
      'user.email=test@harness.local',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      'base',
      '--allow-empty',
    ],
    { cwd: rootDir },
  );
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: rootDir });
  return stdout.trim();
}
