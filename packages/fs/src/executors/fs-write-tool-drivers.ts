import type {
  FsEditToolNode,
  FsWriteToolNode,
  StepExecutionContext,
  ToolDriver,
  ToolEffect,
  ToolExecutionResult,
} from '@harness-dsl/core';
import { createFsWriteEffect } from './internal/enumerate-workspace-files.js';
import {
  checkPathsExistAtBaseRef,
  resolveJailedWorktreePath,
} from './internal/jail-and-glob-helpers.js';
import {
  describeFsEditEffects,
  executeFsEditOperation,
  executeFsWriteOperation,
} from './internal/tool-driver-io-helpers.js';

/**
 * Creates the workspace-jailed `ToolDriver` for `FsEditToolNode` (`fs:edit` / `edit_file`).
 *
 * Emits synchronous `FsToolEffect` write descriptors (`mutatesScope: true`) populated with
 * `existingPathsAtBaseRef` and `proposedContent`, and replaces `oldString` with `newString`.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @returns {ToolDriver<FsEditToolNode<THandle>, THandle>} Frozen `fs:edit` tool driver.
 */
export function createFsEditToolDriver<THandle = unknown>(): ToolDriver<
  FsEditToolNode<THandle>,
  THandle
> {
  return Object.freeze<ToolDriver<FsEditToolNode<THandle>, THandle>>({
    describeEffects(_node: FsEditToolNode<THandle>, args: unknown, scopeHandle: THandle): readonly ToolEffect[] {
      return describeFsEditEffects(scopeHandle, args);
    },
    async execute(node: FsEditToolNode<THandle>, args: unknown, ctx: StepExecutionContext<THandle>): Promise<ToolExecutionResult> {
      const parsed = node.inputSchema.parse(args) as { readonly path: string; readonly oldString: string; readonly newString: string };
      return executeFsEditOperation(ctx.scopeHandle, parsed);
    },
  });
}

/**
 * Creates the workspace-jailed `ToolDriver` for `FsWriteToolNode` (`fs:write` / `write_file`).
 *
 * Emits synchronous `FsToolEffect` write descriptors (`mutatesScope: true`) populated with
 * `existingPathsAtBaseRef` and `proposedContent`, and writes UTF-8 text to disk.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @returns {ToolDriver<FsWriteToolNode<THandle>, THandle>} Frozen `fs:write` tool driver.
 */
export function createFsWriteToolDriver<THandle = unknown>(): ToolDriver<
  FsWriteToolNode<THandle>,
  THandle
> {
  return Object.freeze<ToolDriver<FsWriteToolNode<THandle>, THandle>>({
    describeEffects(_node: FsWriteToolNode<THandle>, args: unknown, scopeHandle: THandle): readonly ToolEffect[] {
      const rec = (args as { readonly path?: string; readonly content?: string } | null | undefined) ?? {};
      const { normalizedRelPath } = resolveJailedWorktreePath(scopeHandle, rec.path ?? '', true);
      const existingAtBase = checkPathsExistAtBaseRef(scopeHandle, [normalizedRelPath]);
      return Object.freeze([
        createFsWriteEffect([normalizedRelPath], existingAtBase, {
          [normalizedRelPath]: rec.content ?? '',
        }),
      ]);
    },
    async execute(node: FsWriteToolNode<THandle>, args: unknown, ctx: StepExecutionContext<THandle>): Promise<ToolExecutionResult> {
      const parsed = node.inputSchema.parse(args) as { readonly path: string; readonly content: string };
      return executeFsWriteOperation(ctx.scopeHandle, parsed);
    },
  });
}
