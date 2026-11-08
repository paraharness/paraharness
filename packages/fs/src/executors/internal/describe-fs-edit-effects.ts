import { existsSync, readFileSync } from 'node:fs';
import type { ToolEffect } from '@metaharness/core';
import { checkPathsExistAtBaseRef } from './check-paths-exist-at-base-ref.js';
import { createFsWriteEffect } from './create-fs-write-effect.js';
import { resolveJailedWorktreePath } from './resolve-jailed-worktree-path.js';

/**
 * Computes the synchronous pre-flight `FsToolEffect` write descriptor for `edit_file`.
 *
 * Populates `existingPathsAtBaseRef` and `proposedContent` after applying `oldString -> newString`.
 *
 * @param {unknown} scopeHandle - Active isolation scope handle.
 * @param {unknown} args        - Raw tool call arguments.
 *
 * @returns {readonly ToolEffect[]} Frozen single-element array containing the write `FsToolEffect`.
 */
export function describeFsEditEffects(
  scopeHandle: unknown,
  args: unknown,
): readonly ToolEffect[] {
  const rec =
    (args as { readonly path?: string; readonly oldString?: string; readonly newString?: string } | null | undefined) ?? {};
  const { normalizedRelPath, absolutePath } = resolveJailedWorktreePath(
    scopeHandle,
    rec.path ?? '',
    'write',
  );
  const currentContent = existsSync(absolutePath) ? readFileSync(absolutePath, 'utf8') : '';
  const oldStr = rec.oldString ?? '';
  const newStr = rec.newString ?? '';
  const nextContent =
    oldStr.length > 0 && currentContent.includes(oldStr)
      ? currentContent.replace(oldStr, () => newStr)
      : `${currentContent}${newStr}`;
  const existingAtBase = checkPathsExistAtBaseRef(scopeHandle, [normalizedRelPath]);
  return Object.freeze([
    createFsWriteEffect([normalizedRelPath], existingAtBase, {
      [normalizedRelPath]: nextContent,
    }),
  ]);
}
