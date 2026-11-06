import type { NodeRunnerNode } from '@harness-dsl/core';
import type { LocalRunnerBuilder } from './local-runner-builder.js';
import type { LocalRunnerOptions } from './local-runner-options.js';

/**
 * Creates a `LocalRunnerBuilder` for `local.runner({ id?, slots, maxDaemons? })`.
 *
 * Validates that `slots` and `maxDaemons` are positive integers, defaults `id` to
 * `'default-runner'` and `maxDaemons` to `slots`, and freezes both the passive
 * `NodeRunnerNode` AST and the returned builder wrapper.
 *
 * @param {LocalRunnerOptions} options - Concurrency slot and daemon pool options.
 *
 * @returns {LocalRunnerBuilder} Frozen local runner pool builder.
 *
 * @throws {Error} If `id` is empty or `slots` / `maxDaemons` is not a positive integer.
 */
export function createLocalRunnerBuilder(options: LocalRunnerOptions): LocalRunnerBuilder {
  const id = options.id ?? 'default-runner';
  if (id.trim().length === 0) {
    throw new Error("local.runner requires a non-empty 'id' when specified.");
  }
  if (!Number.isInteger(options.slots) || options.slots < 1) {
    throw new Error(
      `local.runner('${id}') requires 'slots' to be a positive integer, received ${String(options.slots)}.`,
    );
  }
  const maxDaemons = options.maxDaemons ?? options.slots;
  if (!Number.isInteger(maxDaemons) || maxDaemons < 1) {
    throw new Error(
      `local.runner('${id}') requires 'maxDaemons' to be a positive integer, received ${String(maxDaemons)}.`,
    );
  }
  const astNode = Object.freeze<NodeRunnerNode>({
    type: 'node:runner',
    id,
    slots: options.slots,
    maxDaemons,
  });
  return Object.freeze<LocalRunnerBuilder>({
    type: 'node:runner',
    id,
    slots: options.slots,
    maxDaemons,
    toAST(): NodeRunnerNode {
      return astNode;
    },
  });
}
