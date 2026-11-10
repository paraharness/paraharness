import type { RunnerPoolASTNode } from '../../../ast/domain-ast.types.js';
import type { RunnerDriver } from '../../../ports/runner-driver.js';
import type { RuntimeExecutorRegistry } from '../../../ports/runtime-executor-registry.js';
import { MEMOIZED_RUNNERS_BY_REGISTRY } from './memoized-runner-cache.constants.js';

/**
 * Validates that `candidateNode` matches the `type`, `slots`, and `maxDaemons` configuration of `existingNode` for the same runner `id` (`Rule 5.4`).
 *
 * @param {RunnerPoolASTNode} existingNode  - Previously registered runner pool AST node.
 * @param {RunnerPoolASTNode} candidateNode - Newly requested runner pool AST node with the same `id`.
 * @param {string}            contextLabel  - Enclosing harness, lane, flow, or step diagnostic label.
 *
 * @throws {Error} If `type`, `slots`, or `maxDaemons` differ between `existingNode` and `candidateNode`.
 */
function assertCompatibleRunnerPoolNode(
  existingNode: RunnerPoolASTNode,
  candidateNode: RunnerPoolASTNode,
  contextLabel: string,
): void {
  const existingSlots = (existingNode as { readonly slots?: number }).slots;
  const existingMaxDaemons = (existingNode as { readonly maxDaemons?: number }).maxDaemons;
  const candidateSlots = (candidateNode as { readonly slots?: number }).slots;
  const candidateMaxDaemons = (candidateNode as { readonly maxDaemons?: number }).maxDaemons;
  if (
    existingNode.type !== candidateNode.type ||
    existingSlots !== candidateSlots ||
    existingMaxDaemons !== candidateMaxDaemons
  ) {
    throw new Error(
      `RunnerPoolASTNode '${candidateNode.id}' was already registered with (type='${existingNode.type}', slots=${String(existingSlots)}, maxDaemons=${String(existingMaxDaemons)}) but was requested again with conflicting configuration (type='${candidateNode.type}', slots=${String(candidateSlots)}, maxDaemons=${String(candidateMaxDaemons)}) in ${contextLabel}.`,
    );
  }
}

/**
 * Creates a memoized `getRunner(node)` resolver scoped to `registry` that instantiates each `RunnerDriver` at most once per `node.id` and rejects conflicting `slots` or `maxDaemons` declarations (`SPEC.md` §3.5.3 & `Rule 5.4`).
 *
 * @param {RuntimeExecutorRegistry}          registry     - Composite executor registry owning the runner factories.
 * @param {string}                           contextLabel - Diagnostic context label (`"harness '...'"`, `"lane '...'"`, `"flow '...'"`, or `"runId '...'"`).
 * @param {readonly RunnerPoolASTNode[]}     [seedNodes]  - Optional pre-declared runner pool AST nodes (such as `harness.pools`) to pre-register and validate.
 *
 * @returns {(rNode: RunnerPoolASTNode) => RunnerDriver} Memoized `RunnerDriver` resolver function.
 *
 * @throws {Error} If `seedNodes` or subsequent `getRunner` calls contain conflicting `RunnerPoolASTNode` configurations for the same `id` or lack a registered factory in `registry.runners`.
 */
export function createMemoizedRunnerResolver(
  registry: RuntimeExecutorRegistry,
  contextLabel: string,
  seedNodes?: readonly RunnerPoolASTNode[],
): (rNode: RunnerPoolASTNode) => RunnerDriver {
  let entriesById = MEMOIZED_RUNNERS_BY_REGISTRY.get(registry);
  if (entriesById === undefined) {
    entriesById = new Map<
      string,
      { readonly node: RunnerPoolASTNode; driver: RunnerDriver | undefined }
    >();
    MEMOIZED_RUNNERS_BY_REGISTRY.set(registry, entriesById);
  }
  if (seedNodes !== undefined) {
    for (const seedNode of seedNodes) {
      const existing = entriesById.get(seedNode.id);
      if (existing !== undefined) {
        assertCompatibleRunnerPoolNode(existing.node, seedNode, contextLabel);
      } else {
        entriesById.set(seedNode.id, { node: seedNode, driver: undefined });
      }
    }
  }
  return (rNode: RunnerPoolASTNode): RunnerDriver => {
    const existing = entriesById.get(rNode.id);
    if (existing !== undefined) {
      assertCompatibleRunnerPoolNode(existing.node, rNode, contextLabel);
      if (existing.driver !== undefined) {
        return existing.driver;
      }
    }
    const factory = registry.runners[rNode.type];
    if (factory === undefined) {
      throw new Error(
        `No RunnerDriver registered for '${rNode.type}' (runner id '${rNode.id}', ${contextLabel}).`,
      );
    }
    const driver = factory(rNode as never);
    entriesById.set(rNode.id, {
      node: existing !== undefined ? existing.node : rNode,
      driver,
    });
    return driver;
  };
}
