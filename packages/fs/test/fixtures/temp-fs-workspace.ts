import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { initGitRepositoryWithBaseCommit } from './internal/init-git-repository-with-base-commit.js';
import type { TempFsWorkspaceHandle } from './temp-fs-workspace-handle.js';

/**
 * Options for initializing a temporary filesystem workspace in tests.
 *
 * Configures initial relative file contents, optional symlinks, and optional git repository initialization.
 */
export interface TempFsWorkspaceOptions {
  /** Map of relative POSIX file paths to initial UTF-8 string contents. */
  readonly files?: Readonly<Record<string, string>>;

  /** Map of relative symlink paths to their target paths. */
  readonly symlinks?: Readonly<Record<string, string>>;

  /** Whether to initialize a git repository and create an initial baseline commit (`false` default). */
  readonly initGit?: boolean;
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
  const baseRef =
    options?.initGit === true ? await initGitRepositoryWithBaseCommit(rootDir) : 'HEAD';
  return Object.freeze<TempFsWorkspaceHandle>({
    rootDir,
    worktreePath: rootDir,
    baseRef,
    async cleanup(): Promise<void> {
      await rm(rootDir, { recursive: true, force: true });
    },
  });
}
