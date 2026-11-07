import type { SpeculateRequest, WorkItem } from '../engineering-schemas.schema.js';

/**
 * Constructs the 2 competing candidate `WorkItem` inputs for `coordinator`'s `explore-candidates` speculative tournament (`CODING_SAMPLE.md` §6.8).
 *
 * Initializes both branch work items with monomorphic property shapes (`routingTier: 'leaf-only'`), scoping each
 * branch to `[req.partition]` and pairing `req.problemStatement` with `req.strategyA` and `req.strategyB`.
 *
 * @param {WorkItem}         parentItem - Parent coordinator `WorkItem`.
 * @param {SpeculateRequest} req        - Validated speculative tournament request arguments.
 *
 * @returns {readonly [WorkItem, WorkItem]} Two-branch candidate `WorkItem` array.
 */
export function buildSpeculativeCandidateBranches(
  parentItem: WorkItem,
  req: SpeculateRequest,
): readonly [WorkItem, WorkItem] {
  const branchA: WorkItem = {
    ref: parentItem.ref,
    title: parentItem.title,
    description: `${req.problemStatement}\n\nImplement Strategy A:\n${req.strategyA}`,
    routingTier: 'leaf-only',
    targetPartitions: [req.partition],
    dependsOn: parentItem.dependsOn,
  };
  const branchB: WorkItem = {
    ref: parentItem.ref,
    title: parentItem.title,
    description: `${req.problemStatement}\n\nImplement Strategy B:\n${req.strategyB}`,
    routingTier: 'leaf-only',
    targetPartitions: [req.partition],
    dependsOn: parentItem.dependsOn,
  };
  return [branchA, branchB];
}
