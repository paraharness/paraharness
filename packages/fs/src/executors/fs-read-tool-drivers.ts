import type {
  FsGlobToolNode,
  FsGrepToolNode,
  FsReadToolNode,
  StepExecutionContext,
  ToolDriver,
  ToolEffect,
  ToolExecutionResult,
} from '@paraharness/core';
import { createFsReadEffect } from './internal/create-fs-read-effect.js';
import { enumerateWorkspaceFilesSync } from './internal/enumerate-workspace-files-sync.js';
import { extractWorktreeRootAndBaseRef } from './internal/extract-worktree-root-and-base-ref.js';
import { readFsToolFile } from './internal/fs-coding-tool-drivers.js';
import {
  globFsToolFiles,
  grepFsToolFiles,
} from './internal/fs-search-tool-drivers.js';
import { resolveJailedWorktreePath } from './internal/resolve-jailed-worktree-path.js';

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
      const { normalizedRelPath } = resolveJailedWorktreePath(scopeHandle, rawPath, 'read');
      return Object.freeze([createFsReadEffect([normalizedRelPath])]);
    },
    execute(node: FsReadToolNode<THandle>, args: unknown, ctx: StepExecutionContext<THandle>): Promise<ToolExecutionResult> {
      return readFsToolFile(node, args, ctx);
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
    execute(node: FsGlobToolNode<THandle>, args: unknown, ctx: StepExecutionContext<THandle>): Promise<ToolExecutionResult> {
      return globFsToolFiles(node, args, ctx);
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
    execute(node: FsGrepToolNode<THandle>, args: unknown, ctx: StepExecutionContext<THandle>): Promise<ToolExecutionResult> {
      return grepFsToolFiles(node, args, ctx);
    },
  });
}
