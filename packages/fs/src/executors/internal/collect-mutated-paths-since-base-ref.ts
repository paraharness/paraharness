import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { ToolEffect } from '@paraharness/core';
import { addMutatedPathsFromEffects } from './add-mutated-paths-from-effects.js';
import { extractWorktreeRootAndBaseRef } from './extract-worktree-root-and-base-ref.js';

/**
 * Collects distinct mutated file paths from `observedEffects` and git working-tree changes since `baseRef`.
 *
 * Ensures `fs.regexCheck` inspects only files mutated during the session or since `scopeHandle.baseRef` (`SPEC.md` §4.3).
 *
 * @param {readonly ToolEffect[]} observedEffects - Tool effects recorded in `StepExecutionContext`.
 * @param {unknown}               scopeHandle     - Active isolation scope handle.
 *
 * @returns {readonly string[]} Sorted frozen array of distinct mutated worktree-relative POSIX paths.
 */
export function collectMutatedPathsSinceBaseRef(
  observedEffects: readonly ToolEffect[],
  scopeHandle: unknown,
): readonly string[] {
  const mutated = new Set<string>();
  addMutatedPathsFromEffects(observedEffects, mutated);
  const { rootPath, baseRef } = extractWorktreeRootAndBaseRef(scopeHandle);
  let gitOutput = '';
  if (baseRef !== undefined && existsSync(path.join(rootPath, '.git'))) {
    try {
      const gitEnv = {
        ...process.env,
        GIT_OPTIONAL_LOCKS: '0',
        GIT_CEILING_DIRECTORIES: path.dirname(rootPath),
      };
      const gitOpts = { cwd: rootPath, encoding: 'utf8' as const, stdio: 'pipe' as const, env: gitEnv };
      gitOutput = `${execFileSync('git', ['diff', '--name-only', baseRef], gitOpts)}\n${execFileSync('git', ['ls-files', '--others', '--exclude-standard'], gitOpts)}`;
    } catch {
      gitOutput = '';
    }
  }
  for (const line of gitOutput.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length > 0) mutated.add(trimmed.replace(/\\/g, '/').replace(/^\.\//, ''));
  }
  return Object.freeze([...mutated].sort((a, b) => a.localeCompare(b)));
}
