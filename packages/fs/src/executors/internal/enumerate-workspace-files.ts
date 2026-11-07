import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import type { ToolEffect } from '@harness-dsl/core';
import type { FsToolEffect } from '../fs-tool-effect.js';
import {
  compileGlobOrExactMatcher,
  extractWorktreeRootAndBaseRef,
} from './jail-and-glob-helpers.js';

/**
 * Enumerates all jailed workspace-relative POSIX file paths matching `globPattern` in lexicographical order.
 *
 * Skips `.git` and `node_modules` directories and ignores any symlink whose resolved `realpathSync`
 * target escapes `realRoot`.
 *
 * @param {string} rootPath    - Worktree or repository root directory path.
 * @param {string} globPattern - POSIX glob pattern to match against relative paths.
 *
 * @returns {readonly string[]} Sorted frozen array of matching relative POSIX file paths.
 */
export function enumerateWorkspaceFilesSync(rootPath: string, globPattern: string): readonly string[] {
  const realRoot = realpathSync(path.resolve(rootPath));
  const isMatch = compileGlobOrExactMatcher([globPattern]);
  const matched: string[] = [];
  const visitedDirs = new Set<string>([realRoot]);
  const stack: string[] = [realRoot];
  while (stack.length > 0) {
    const currentDir = stack.pop();
    if (currentDir === undefined) continue;
    const realCurrentDir = realpathSync(currentDir);
    for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const fullPath = path.join(currentDir, entry.name);
      let realEntryPath: string;
      try {
        realEntryPath = realpathSync(fullPath);
      } catch {
        continue;
      }
      const realRel = path.relative(realRoot, realEntryPath);
      if (realRel === '..' || realRel.startsWith('../') || realRel.startsWith(`..${path.sep}`) || path.isAbsolute(realRel)) continue;
      const entryStat = statSync(realEntryPath);
      const isCycle = visitedDirs.has(realEntryPath) || realCurrentDir === realEntryPath || realCurrentDir.startsWith(`${realEntryPath}${path.sep}`);
      if (entryStat.isDirectory() && entry.isSymbolicLink() && isCycle) continue;
      if (entryStat.isDirectory() && entry.isSymbolicLink()) visitedDirs.add(realEntryPath);
      if (entryStat.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entryStat.isFile()) continue;
      const posixRel = path.relative(realRoot, fullPath).split(path.sep).join('/');
      if (isMatch(posixRel)) matched.push(posixRel);
    }
  }
  matched.sort((a, b) => a.localeCompare(b));
  return Object.freeze(matched);
}

/**
 * Constructs a frozen read-mode `FsToolEffect` record (`mutatesScope: false`).
 *
 * Preserves monomorphic property order across all `FsToolEffect` instances (`Rule 4.3`).
 *
 * @param {readonly string[]} paths - Canonicalized worktree-relative POSIX file paths read.
 *
 * @returns {FsToolEffect} Deeply frozen read `FsToolEffect`.
 */
export function createFsReadEffect(paths: readonly string[]): FsToolEffect {
  return Object.freeze<FsToolEffect>({
    kind: 'fs:effect',
    mutatesScope: false,
    attributes: Object.freeze({
      mode: 'read',
      paths: Object.freeze([...paths]),
      existingPathsAtBaseRef: undefined,
      proposedContent: undefined,
    }),
  });
}

/**
 * Constructs a frozen write-mode `FsToolEffect` record (`mutatesScope: true`).
 *
 * Populates `existingPathsAtBaseRef` and `proposedContent` for downstream policy guards (`SPEC.md` §4.3).
 *
 * @param {readonly string[]}                paths                  - Canonicalized worktree-relative POSIX paths mutated.
 * @param {readonly string[]}                existingPathsAtBaseRef - Subset of `paths` existing at `baseRef`.
 * @param {Readonly<Record<string, string>>} proposedContent        - Proposed post-edit UTF-8 content per path.
 *
 * @returns {FsToolEffect} Deeply frozen write `FsToolEffect`.
 */
export function createFsWriteEffect(
  paths: readonly string[],
  existingPathsAtBaseRef: readonly string[],
  proposedContent: Readonly<Record<string, string>>,
): FsToolEffect {
  return Object.freeze<FsToolEffect>({
    kind: 'fs:effect',
    mutatesScope: true,
    attributes: Object.freeze({
      mode: 'write',
      paths: Object.freeze([...paths]),
      existingPathsAtBaseRef: Object.freeze([...existingPathsAtBaseRef]),
      proposedContent: Object.freeze({ ...proposedContent }),
    }),
  });
}

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
  for (const eff of observedEffects) {
    if (eff.kind !== 'fs:effect') continue;
    const mode = eff.attributes?.['mode'];
    if (eff.mutatesScope !== true && mode !== 'write') continue;
    const paths = eff.attributes?.['paths'];
    if (!Array.isArray(paths)) continue;
    for (const relPath of paths) {
      if (typeof relPath === 'string') mutated.add(relPath.replace(/\\/g, '/').replace(/^\.\//, ''));
    }
  }
  const { rootPath, baseRef } = extractWorktreeRootAndBaseRef(scopeHandle);
  let gitOutput = '';
  if (baseRef !== undefined && existsSync(path.join(rootPath, '.git'))) {
    try {
      const gitEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_CEILING_DIRECTORIES: path.dirname(rootPath) };
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
