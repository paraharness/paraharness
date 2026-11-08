import type {
  FsEditToolNode,
  FsWriteToolNode,
  StepExecutionContext,
  ToolDriver,
  ToolEffect,
  ToolExecutionResult,
} from '@metaharness/core';
import { describeFsEditEffects } from './internal/describe-fs-edit-effects.js';
import { describeFsWriteEffects } from './internal/describe-fs-write-effects.js';
import {
  editFsToolFile,
  writeFsToolFile,
} from './internal/fs-coding-tool-drivers.js';

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
    execute(node: FsEditToolNode<THandle>, args: unknown, ctx: StepExecutionContext<THandle>): Promise<ToolExecutionResult> {
      return editFsToolFile(node, args, ctx);
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
      return describeFsWriteEffects(scopeHandle, args);
    },
    execute(node: FsWriteToolNode<THandle>, args: unknown, ctx: StepExecutionContext<THandle>): Promise<ToolExecutionResult> {
      return writeFsToolFile(node, args, ctx);
    },
  });
}
