import type {
  FsEditToolNode,
  FsGlobToolNode,
  FsGrepToolNode,
  FsReadToolNode,
  FsWriteToolNode,
  NodeRunnerNode,
} from '@harness-dsl/core';
import {
  FsEditToolInputSchema,
  FsGlobToolInputSchema,
  FsGrepToolInputSchema,
  FsReadToolInputSchema,
  FsWriteToolInputSchema,
} from './fs-tool-input.schema.js';

/**
 * Constructs a frozen `FsReadToolNode` (`fs:read` / `read_file`) bound to `runnerNode`.
 *
 * Uses the pre-compiled `FsReadToolInputSchema` with `effectTracking: 'declared'`.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {NodeRunnerNode} runnerNode - Passive runner pool AST node.
 *
 * @returns {FsReadToolNode<THandle>} Deeply frozen `FsReadToolNode` AST descriptor.
 */
export function buildFsReadToolNode<THandle = unknown>(
  runnerNode: NodeRunnerNode,
): FsReadToolNode<THandle> {
  return Object.freeze<FsReadToolNode<THandle>>({
    type: 'fs:read',
    name: 'read_file',
    description: 'Read UTF-8 text from a workspace-relative file path.',
    inputSchema: FsReadToolInputSchema,
    effectTracking: 'declared',
    runner: runnerNode,
  });
}

/**
 * Constructs a frozen `FsEditToolNode` (`fs:edit` / `edit_file`) bound to `runnerNode`.
 *
 * Uses the pre-compiled `FsEditToolInputSchema` with `effectTracking: 'declared'`.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {NodeRunnerNode} runnerNode - Passive runner pool AST node.
 *
 * @returns {FsEditToolNode<THandle>} Deeply frozen `FsEditToolNode` AST descriptor.
 */
export function buildFsEditToolNode<THandle = unknown>(
  runnerNode: NodeRunnerNode,
): FsEditToolNode<THandle> {
  return Object.freeze<FsEditToolNode<THandle>>({
    type: 'fs:edit',
    name: 'edit_file',
    description: 'Replace an exact target string in an existing workspace-relative file.',
    inputSchema: FsEditToolInputSchema,
    effectTracking: 'declared',
    runner: runnerNode,
  });
}

/**
 * Constructs a frozen `FsWriteToolNode` (`fs:write` / `write_file`) bound to `runnerNode`.
 *
 * Uses the pre-compiled `FsWriteToolInputSchema` with `effectTracking: 'declared'`.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {NodeRunnerNode} runnerNode - Passive runner pool AST node.
 *
 * @returns {FsWriteToolNode<THandle>} Deeply frozen `FsWriteToolNode` AST descriptor.
 */
export function buildFsWriteToolNode<THandle = unknown>(
  runnerNode: NodeRunnerNode,
): FsWriteToolNode<THandle> {
  return Object.freeze<FsWriteToolNode<THandle>>({
    type: 'fs:write',
    name: 'write_file',
    description: 'Create or overwrite a workspace-relative UTF-8 file.',
    inputSchema: FsWriteToolInputSchema,
    effectTracking: 'declared',
    runner: runnerNode,
  });
}

/**
 * Constructs a frozen `FsGlobToolNode` (`fs:glob` / `glob_files`) bound to `runnerNode`.
 *
 * Uses the pre-compiled `FsGlobToolInputSchema` with `effectTracking: 'declared'`.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {NodeRunnerNode} runnerNode - Passive runner pool AST node.
 *
 * @returns {FsGlobToolNode<THandle>} Deeply frozen `FsGlobToolNode` AST descriptor.
 */
export function buildFsGlobToolNode<THandle = unknown>(
  runnerNode: NodeRunnerNode,
): FsGlobToolNode<THandle> {
  return Object.freeze<FsGlobToolNode<THandle>>({
    type: 'fs:glob',
    name: 'glob_files',
    description: 'List workspace-relative files matching a POSIX glob pattern.',
    inputSchema: FsGlobToolInputSchema,
    effectTracking: 'declared',
    runner: runnerNode,
  });
}

/**
 * Constructs a frozen `FsGrepToolNode` (`fs:grep` / `grep_files`) bound to `runnerNode`.
 *
 * Uses the pre-compiled `FsGrepToolInputSchema` with `effectTracking: 'declared'`.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {NodeRunnerNode} runnerNode - Passive runner pool AST node.
 *
 * @returns {FsGrepToolNode<THandle>} Deeply frozen `FsGrepToolNode` AST descriptor.
 */
export function buildFsGrepToolNode<THandle = unknown>(
  runnerNode: NodeRunnerNode,
): FsGrepToolNode<THandle> {
  return Object.freeze<FsGrepToolNode<THandle>>({
    type: 'fs:grep',
    name: 'grep_files',
    description: 'Search workspace files for lines matching a regular expression pattern.',
    inputSchema: FsGrepToolInputSchema,
    effectTracking: 'declared',
    runner: runnerNode,
  });
}
