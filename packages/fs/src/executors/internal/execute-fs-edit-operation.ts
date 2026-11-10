import { readFile, writeFile } from 'node:fs/promises';
import type { ToolExecutionResult } from '@paraharness/core';
import { resolveJailedWorktreePath } from './resolve-jailed-worktree-path.js';

/**
 * Validated edit arguments for {@link executeFsEditOperation}.
 */
export interface ExecuteFsEditOperationParams {
  /** Workspace-relative path of the file to edit. */
  readonly path: string;

  /** Exact substring to replace. */
  readonly oldString: string;

  /** Replacement string. */
  readonly newString: string;
}

/**
 * Executes a jailed `edit_file` string replacement inside `scopeHandle`.
 *
 * Verifies that `params.oldString` exists in the target file before writing the updated UTF-8 text.
 * Returns an `isError: true` result when reading the file fails or `params.oldString` is absent.
 *
 * @param {unknown}                      scopeHandle - Active isolation scope handle.
 * @param {ExecuteFsEditOperationParams} params      - Validated edit arguments (`path`, `oldString`, `newString`).
 *
 * @returns {Promise<ToolExecutionResult>} Frozen tool execution result.
 */
export async function executeFsEditOperation(
  scopeHandle: unknown,
  params: ExecuteFsEditOperationParams,
): Promise<ToolExecutionResult> {
  const { normalizedRelPath, absolutePath } = resolveJailedWorktreePath(
    scopeHandle,
    params.path,
    'write',
  );
  let currentContent: string;
  try {
    currentContent = await readFile(absolutePath, 'utf8');
  } catch (err) {
    return Object.freeze<ToolExecutionResult>({
      content: err instanceof Error ? err.message : String(err),
      isError: true,
    });
  }
  if (!currentContent.includes(params.oldString)) {
    return Object.freeze<ToolExecutionResult>({
      content: `fs:edit failed on '${normalizedRelPath}': target oldString was not found in file.`,
      isError: true,
    });
  }
  const updatedContent = currentContent.replace(params.oldString, () => params.newString);
  await writeFile(absolutePath, updatedContent, 'utf8');
  return Object.freeze<ToolExecutionResult>({
    content: `Edited ${normalizedRelPath}`,
    isError: false,
  });
}
