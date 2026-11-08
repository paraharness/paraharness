import type { FsTextSourceNode } from '@metaharness/core';

/**
 * Compiles a passive `FsTextSourceNode` (`fs:text-source`) for `fs.text(filePath)`.
 *
 * Resolves `filePath` against the immutable host repository root during control-plane
 * and prefix compilation, or against `ResolutionContext.scopeHandle` when computing
 * in-run grounding diffs.
 *
 * @param {string} filePath - Repository-relative path to the UTF-8 text file.
 *
 * @returns {FsTextSourceNode} Deeply frozen `FsTextSourceNode` AST descriptor.
 */
export function createFsTextSourceBuilder(filePath: string): FsTextSourceNode {
  if (typeof filePath !== 'string' || filePath.trim().length === 0) {
    throw new Error('fs.text requires a non-empty filePath string.');
  }
  const normalizedPath = filePath.trim();
  return Object.freeze<FsTextSourceNode>({
    type: 'fs:text-source',
    id: `fs:text-source:${normalizedPath}`,
    path: normalizedPath,
  });
}
