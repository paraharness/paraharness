import type { ToolEffect } from '@paraharness/core';
import { checkPathsExistAtBaseRef } from './check-paths-exist-at-base-ref.js';
import { createFsWriteEffect } from './create-fs-write-effect.js';
import { resolveJailedWorktreePath } from './resolve-jailed-worktree-path.js';

/**
 * Computes the synchronous pre-flight `FsToolEffect` write descriptor for `write_file`.
 *
 * Populates `existingPathsAtBaseRef` and `proposedContent` for policy guard inspection.
 *
 * @param {unknown} scopeHandle - Active isolation scope handle.
 * @param {unknown} args        - Raw tool call arguments.
 *
 * @returns {readonly ToolEffect[]} Frozen single-element array containing the write `FsToolEffect`.
 */
export function describeFsWriteEffects(
  scopeHandle: unknown,
  args: unknown,
): readonly ToolEffect[] {
  const rec = (args as { readonly path?: string; readonly content?: string } | null | undefined) ?? {};
  const { normalizedRelPath } = resolveJailedWorktreePath(scopeHandle, rec.path ?? '', 'write');
  const existingAtBase = checkPathsExistAtBaseRef(scopeHandle, [normalizedRelPath]);
  return Object.freeze([
    createFsWriteEffect([normalizedRelPath], existingAtBase, {
      [normalizedRelPath]: rec.content ?? '',
    }),
  ]);
}
