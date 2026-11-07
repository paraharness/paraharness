import { readFile } from 'node:fs/promises';
import type {
  FsGlobToolNode,
  FsGrepToolNode,
  FsReadToolNode,
  StepExecutionContext,
  ToolDriver,
  ToolEffect,
  ToolExecutionResult,
} from '@harness-dsl/core';
import {
  createFsReadEffect,
  enumerateWorkspaceFilesSync,
} from './internal/enumerate-workspace-files.js';
import {
  extractWorktreeRootAndBaseRef,
  resolveJailedWorktreePath,
} from './internal/jail-and-glob-helpers.js';
import { grepWorkspaceFiles } from './internal/tool-driver-io-helpers.js';

/**
 * Creates the workspace-jailed `ToolDriver` for `FsReadToolNode` (`fs:read` / `read_file`).
 *
 * Emits synchronous `FsToolEffect` read records (`mutatesScope: false`) and reads UTF-8
 * file text after verifying `realpathSync` containment inside the active worktree.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @returns {ToolDriver<FsReadToolNode<THandle>, THandle>} Frozen `fs:read` tool driver.
 */
export function createFsReadToolDriver<THandle = unknown>(): ToolDriver<
  FsReadToolNode<THandle>,
  THandle
> {
  return Object.freeze<ToolDriver<FsReadToolNode<THandle>, THandle>>({
    describeEffects(_node: FsReadToolNode<THandle>, args: unknown, scopeHandle: THandle): readonly ToolEffect[] {
      const rawPath = (args as { readonly path?: string } | null | undefined)?.path ?? '';
      const { normalizedRelPath } = resolveJailedWorktreePath(scopeHandle, rawPath, false);
      return Object.freeze([createFsReadEffect([normalizedRelPath])]);
    },
    async execute(node: FsReadToolNode<THandle>, args: unknown, ctx: StepExecutionContext<THandle>): Promise<ToolExecutionResult> {
      const parsed = node.inputSchema.parse(args) as { readonly path: string };
      const { absolutePath } = resolveJailedWorktreePath(ctx.scopeHandle, parsed.path, false);
      const content = await readFile(absolutePath, 'utf8');
      return Object.freeze<ToolExecutionResult>({ content });
    },
  });
}

/**
 * Creates the workspace-jailed `ToolDriver` for `FsGlobToolNode` (`fs:glob` / `glob_files`).
 *
 * Enumerates workspace-relative files matching `args.pattern` in lexicographical order
 * and records accessed file paths in a read-mode `FsToolEffect`.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @returns {ToolDriver<FsGlobToolNode<THandle>, THandle>} Frozen `fs:glob` tool driver.
 */
export function createFsGlobToolDriver<THandle = unknown>(): ToolDriver<
  FsGlobToolNode<THandle>,
  THandle
> {
  return Object.freeze<ToolDriver<FsGlobToolNode<THandle>, THandle>>({
    describeEffects(_node: FsGlobToolNode<THandle>, args: unknown, scopeHandle: THandle): readonly ToolEffect[] {
      const pattern = (args as { readonly pattern?: string } | null | undefined)?.pattern ?? '**/*';
      const { rootPath } = extractWorktreeRootAndBaseRef(scopeHandle);
      return Object.freeze([createFsReadEffect(enumerateWorkspaceFilesSync(rootPath, pattern))]);
    },
    async execute(node: FsGlobToolNode<THandle>, args: unknown, ctx: StepExecutionContext<THandle>): Promise<ToolExecutionResult> {
      const parsed = node.inputSchema.parse(args) as { readonly pattern: string };
      const { rootPath } = extractWorktreeRootAndBaseRef(ctx.scopeHandle);
      const matched = enumerateWorkspaceFilesSync(rootPath, parsed.pattern);
      return Object.freeze<ToolExecutionResult>({ content: matched.join('\n') });
    },
  });
}

/**
 * Creates the workspace-jailed `ToolDriver` for `FsGrepToolNode` (`fs:grep` / `grep_files`).
 *
 * Searches workspace files matching `args.glob` against regular expression `args.pattern`
 * and formats matching lines as `path:lineNumber:lineText`.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @returns {ToolDriver<FsGrepToolNode<THandle>, THandle>} Frozen `fs:grep` tool driver.
 */
export function createFsGrepToolDriver<THandle = unknown>(): ToolDriver<
  FsGrepToolNode<THandle>,
  THandle
> {
  return Object.freeze<ToolDriver<FsGrepToolNode<THandle>, THandle>>({
    describeEffects(_node: FsGrepToolNode<THandle>, args: unknown, scopeHandle: THandle): readonly ToolEffect[] {
      const glob = (args as { readonly glob?: string } | null | undefined)?.glob ?? '**/*';
      const { rootPath } = extractWorktreeRootAndBaseRef(scopeHandle);
      return Object.freeze([createFsReadEffect(enumerateWorkspaceFilesSync(rootPath, glob))]);
    },
    async execute(node: FsGrepToolNode<THandle>, args: unknown, ctx: StepExecutionContext<THandle>): Promise<ToolExecutionResult> {
      const parsed = node.inputSchema.parse(args) as { readonly pattern: string; readonly glob?: string; readonly flags?: string };
      const content = await grepWorkspaceFiles(ctx.scopeHandle, parsed);
      return Object.freeze<ToolExecutionResult>({ content });
    },
  });
}
