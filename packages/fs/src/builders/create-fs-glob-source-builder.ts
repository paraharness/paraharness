import type { FsGlobSourceNode } from '@paraharness/core';

/**
 * Compiles a passive `FsGlobSourceNode` (`fs:glob-source`) for `fs.glob(globPattern)`.
 *
 * Resolves all files matching `globPattern` in deterministic lexicographical path order
 * and pairs their relative paths and UTF-8 contents with a combined SHA-256 digest.
 *
 * @param {string} globPattern - POSIX glob pattern matched against the repository root.
 *
 * @returns {FsGlobSourceNode} Deeply frozen `FsGlobSourceNode` AST descriptor.
 */
export function createFsGlobSourceBuilder(globPattern: string): FsGlobSourceNode {
  if (typeof globPattern !== 'string' || globPattern.trim().length === 0) {
    throw new Error('fs.glob requires a non-empty globPattern string.');
  }
  const normalizedPattern = globPattern.trim();
  return Object.freeze<FsGlobSourceNode>({
    type: 'fs:glob-source',
    id: `fs:glob-source:${normalizedPattern}`,
    pattern: normalizedPattern,
  });
}
