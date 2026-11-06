import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { TempFsWorkspaceHandle } from './temp-fs-workspace-handle.js';
import type { TempFsWorkspaceOptions } from './temp-fs-workspace-options.js';

/**
 * Initializes a git repository and commits all current files inside `rootDir`.
 *
 * Configures a local test author identity and disables GPG signing so commits succeed in any environment.
 *
 * @param {string} rootDir - Canonical workspace directory path.
 *
 * @returns {Promise<string>} Resolved `HEAD` commit SHA.
 */
async function initGitRepositoryWithBaseCommit(rootDir: string): Promise<string> {
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

/**
 * Creates a real temporary workspace directory populated with initial files, symlinks, and optional git commit.
 *
 * Resolves `rootDir` via `realpath` so macOS `/var` -> `/private/var` symlinks match canonical path checks.
 *
 * @param {TempFsWorkspaceOptions} [options] - Optional initial files, symlinks, and git initialization toggle.
 *
 * @returns {Promise<TempFsWorkspaceHandle>} Frozen handle to the temporary workspace.
 */
export async function createTempFsWorkspace(
  options?: TempFsWorkspaceOptions,
): Promise<TempFsWorkspaceHandle> {
  const rawTmp = await mkdtemp(join(tmpdir(), 'harness-fs-test-'));
  const rootDir = await realpath(rawTmp);
  const files = options?.files ?? {};
  for (const [relPath, content] of Object.entries(files)) {
    const absPath = join(rootDir, relPath);
    await mkdir(dirname(absPath), { recursive: true });
    await writeFile(absPath, content, 'utf8');
  }
  const symlinks = options?.symlinks ?? {};
  for (const [linkRelPath, targetPath] of Object.entries(symlinks)) {
    const absLink = join(rootDir, linkRelPath);
    await mkdir(dirname(absLink), { recursive: true });
    await symlink(targetPath, absLink);
  }
  const baseRef = options?.initGit === true ? await initGitRepositoryWithBaseCommit(rootDir) : 'HEAD';
  return Object.freeze<TempFsWorkspaceHandle>({
    rootDir,
    baseRef,
    async cleanup(): Promise<void> {
      await rm(rootDir, { recursive: true, force: true });
    },
  });
}
