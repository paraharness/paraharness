import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ToolExecutionResult } from '@paraharness/core';
import { resolveJailedWorktreePath } from './resolve-jailed-worktree-path.js';

/**
 * Validated write arguments for {@link executeFsWriteOperation}.
 */
export interface ExecuteFsWriteOperationParams {
  /** Workspace-relative path of the file to write. */
  readonly path: string;

  /** UTF-8 file content to write. */
  readonly content: string;
}

/**
 * Executes a jailed `write_file` operation inside `scopeHandle`.
 *
 * Creates parent directories if needed, re-verifies symlink jailing, and writes UTF-8 text.
 *
 * @param {unknown}                       scopeHandle - Active isolation scope handle.
 * @param {ExecuteFsWriteOperationParams} params      - Validated write arguments (`path`, `content`).
 *
 * @returns {Promise<ToolExecutionResult>} Frozen tool execution result.
 */
export async function executeFsWriteOperation(
  scopeHandle: unknown,
  params: ExecuteFsWriteOperationParams,
): Promise<ToolExecutionResult> {
  const { normalizedRelPath, absolutePath } = resolveJailedWorktreePath(
    scopeHandle,
    params.path,
    'write',
  );
  await mkdir(path.dirname(absolutePath), { recursive: true });
  resolveJailedWorktreePath(scopeHandle, normalizedRelPath, 'write');
  await writeFile(absolutePath, params.content, 'utf8');
  return Object.freeze<ToolExecutionResult>({ content: `Wrote ${normalizedRelPath}` });
}
