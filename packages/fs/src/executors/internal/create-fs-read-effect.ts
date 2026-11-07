import type { FsToolEffect } from '../fs-tool-effect.js';

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
