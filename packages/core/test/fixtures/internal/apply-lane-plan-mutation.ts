import { Graph, alg } from '@dagrejs/graphlib';
import type { MutateLanePlanRequest } from '../../../src/ports/mutate-lane-plan-request.js';
import type { InMemoryLedgerStore } from '../in-memory-ledger-store.js';

/**
 * Computes the longest directed prerequisite path length in `graph` starting from `nodeKey`.
 *
 * Uses memoization over the validated DAG to return the maximum edge depth reachable from `nodeKey`.
 *
 * @param {Graph}               graph   - Validated acyclic directed graph.
 * @param {string}              nodeKey - Starting item key.
 * @param {Map<string, number>} memo    - Memoized depth map by item key.
 *
 * @returns {number} Maximum prerequisite chain depth in edges from `nodeKey`.
 */
function computeMaxPrerequisiteDepth(graph: Graph, nodeKey: string, memo: Map<string, number>): number {
  const cached = memo.get(nodeKey);
  if (cached !== undefined) return cached;
  const successors = graph.successors(nodeKey) ?? [];
  let maxDepth = 0;
  for (const dep of successors) {
    const childDepth = 1 + computeMaxPrerequisiteDepth(graph, dep, memo);
    if (childDepth > maxDepth) maxDepth = childDepth;
  }
  memo.set(nodeKey, maxDepth);
  return maxDepth;
}

/**
 * Validates and applies a `MutateLanePlanRequest` (`spawnedItems` and `addedDependencies`) against `store`.
 *
 * Enforces DAG acyclicity via `@dagrejs/graphlib` (`Graph`, `alg.findCycles`) and `req.maxPrerequisiteDepth`
 * before recording the mutation and updating the parent run's `dependsOn` list (`SPEC.md` §2.7 & §3.7.2).
 *
 * @param {InMemoryLedgerStore}   store - Target in-memory ledger store.
 * @param {MutateLanePlanRequest} req   - Lane plan mutation request.
 *
 * @throws {Error} If the mutation introduces a prerequisite cycle or exceeds `req.maxPrerequisiteDepth`.
 */
export function applyMutateLanePlan(store: InMemoryLedgerStore, req: MutateLanePlanRequest): void {
  const graph = new Graph({ directed: true });
  for (const run of store.runs.values()) {
    if (run.laneId === req.laneId) {
      for (const dep of run.dependsOn) graph.setEdge(run.itemKey, dep);
    }
  }
  for (const prev of store.planMutations) {
    if (prev.laneId !== req.laneId) continue;
    for (const sp of prev.spawnedItems ?? []) {
      for (const dep of sp.dependsOn) graph.setEdge(sp.itemKey, dep);
    }
    for (const dep of prev.addedDependencies ?? []) graph.setEdge(prev.parentItemKey, dep);
  }
  for (const sp of req.spawnedItems ?? []) {
    for (const dep of sp.dependsOn) {
      if (dep === sp.itemKey) throw new Error(`Self-dependency cycle on '${sp.itemKey}' in lane '${req.laneId}'.`);
      graph.setEdge(sp.itemKey, dep);
    }
  }
  for (const dep of req.addedDependencies ?? []) {
    if (dep === req.parentItemKey) throw new Error(`Self-dependency cycle on '${req.parentItemKey}' in lane '${req.laneId}'.`);
    graph.setEdge(req.parentItemKey, dep);
  }
  const firstCycle = alg.findCycles(graph)[0];
  if (firstCycle !== undefined) throw new Error(`Prerequisite dependency cycle in lane '${req.laneId}': ${firstCycle.join(' -> ')}.`);
  const depth = computeMaxPrerequisiteDepth(graph, req.parentItemKey, new Map());
  if (depth > req.maxPrerequisiteDepth) {
    throw new Error(`Prerequisite depth (${String(depth)}) exceeds maxPrerequisiteDepth (${String(req.maxPrerequisiteDepth)}) in lane '${req.laneId}'.`);
  }
  const parentRun = store.runs.get(req.parentRunId);
  if (parentRun !== undefined) {
    for (const dep of req.addedDependencies ?? []) {
      if (!parentRun.dependsOn.includes(dep)) parentRun.dependsOn.push(dep);
    }
  }
  store.planMutations.push(req);
}
