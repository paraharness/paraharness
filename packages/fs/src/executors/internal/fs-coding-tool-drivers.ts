import { readFile } from 'node:fs/promises';
import type {
  FsEditToolNode,
  FsReadToolNode,
  FsWriteToolNode,
  StepExecutionContext,
  ToolExecutionResult,
} from '@metaharness/core';
import {
  type ExecuteFsEditOperationParams,
  executeFsEditOperation,
} from './execute-fs-edit-operation.js';
import {
  type ExecuteFsWriteOperationParams,
  executeFsWriteOperation,
} from './execute-fs-write-operation.js';
import { resolveJailedWorktreePath } from './resolve-jailed-worktree-path.js';

/**
 * Validates `args` against `node.inputSchema` and reads the jailed UTF-8 file for `fs:read`.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {FsReadToolNode<THandle>}       node - Passive `fs:read` tool AST node.
 * @param {unknown}                       args - Raw tool call arguments.
 * @param {StepExecutionContext<THandle>} ctx  - Active step execution context.
 *
 * @returns {Promise<ToolExecutionResult>} Frozen tool execution result containing the UTF-8 file text.
 */
export async function readFsToolFile<THandle = unknown>(
  node: FsReadToolNode<THandle>,
  args: unknown,
  ctx: StepExecutionContext<THandle>,
): Promise<ToolExecutionResult> {
  const parsed = node.inputSchema.parse(args) as { readonly path: string };
  const { absolutePath } = resolveJailedWorktreePath(ctx.scopeHandle, parsed.path, 'read');
  const content = await readFile(absolutePath, 'utf8');
  return Object.freeze<ToolExecutionResult>({ content });
}

/**
 * Validates `args` against `node.inputSchema` and executes a jailed `fs:edit` replacement.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {FsEditToolNode<THandle>}       node - Passive `fs:edit` tool AST node.
 * @param {unknown}                       args - Raw tool call arguments.
 * @param {StepExecutionContext<THandle>} ctx  - Active step execution context.
 *
 * @returns {Promise<ToolExecutionResult>} Frozen tool execution result.
 */
export function editFsToolFile<THandle = unknown>(
  node: FsEditToolNode<THandle>,
  args: unknown,
  ctx: StepExecutionContext<THandle>,
): Promise<ToolExecutionResult> {
  const parsed = node.inputSchema.parse(args) as ExecuteFsEditOperationParams;
  return executeFsEditOperation(ctx.scopeHandle, parsed);
}

/**
 * Validates `args` against `node.inputSchema` and executes a jailed `fs:write` operation.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {FsWriteToolNode<THandle>}      node - Passive `fs:write` tool AST node.
 * @param {unknown}                       args - Raw tool call arguments.
 * @param {StepExecutionContext<THandle>} ctx  - Active step execution context.
 *
 * @returns {Promise<ToolExecutionResult>} Frozen tool execution result.
 */
export function writeFsToolFile<THandle = unknown>(
  node: FsWriteToolNode<THandle>,
  args: unknown,
  ctx: StepExecutionContext<THandle>,
): Promise<ToolExecutionResult> {
  const parsed = node.inputSchema.parse(args) as ExecuteFsWriteOperationParams;
  return executeFsWriteOperation(ctx.scopeHandle, parsed);
}
