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
