import type {
  FsGlobToolNode,
  FsGrepToolNode,
  StepExecutionContext,
  ToolExecutionResult,
} from '@paraharness/core';
import { enumerateWorkspaceFiles } from './enumerate-workspace-files.js';
import { extractWorktreeRootAndBaseRef } from './extract-worktree-root-and-base-ref.js';
import {
  type GrepWorkspaceFilesParams,
  grepWorkspaceFiles,
} from './grep-workspace-files.js';

/**
 * Validates `args` against `node.inputSchema` and enumerates matching workspace files for `fs:glob`.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {FsGlobToolNode<THandle>}       node - Passive `fs:glob` tool AST node.
 * @param {unknown}                       args - Raw tool call arguments.
 * @param {StepExecutionContext<THandle>} ctx  - Active step execution context.
 *
 * @returns {Promise<ToolExecutionResult>} Frozen tool execution result containing newline-joined relative paths.
 */
export async function globFsToolFiles<THandle = unknown>(
  node: FsGlobToolNode<THandle>,
  args: unknown,
  ctx: StepExecutionContext<THandle>,
): Promise<ToolExecutionResult> {
  const parsed = node.inputSchema.parse(args) as { readonly pattern: string };
  const { rootPath } = extractWorktreeRootAndBaseRef(ctx.scopeHandle);
  const matched = await enumerateWorkspaceFiles(rootPath, parsed.pattern);
  return Object.freeze<ToolExecutionResult>({ content: matched.join('\n') });
}

/**
 * Validates `args` against `node.inputSchema` and searches workspace files for `fs:grep`.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {FsGrepToolNode<THandle>}       node - Passive `fs:grep` tool AST node.
 * @param {unknown}                       args - Raw tool call arguments.
 * @param {StepExecutionContext<THandle>} ctx  - Active step execution context.
 *
 * @returns {Promise<ToolExecutionResult>} Frozen tool execution result containing newline-joined `path:line:text` matches.
 */
export async function grepFsToolFiles<THandle = unknown>(
  node: FsGrepToolNode<THandle>,
  args: unknown,
  ctx: StepExecutionContext<THandle>,
): Promise<ToolExecutionResult> {
  const parsed = node.inputSchema.parse(args) as GrepWorkspaceFilesParams;
  const content = await grepWorkspaceFiles(ctx.scopeHandle, parsed);
  return Object.freeze<ToolExecutionResult>({ content });
}
