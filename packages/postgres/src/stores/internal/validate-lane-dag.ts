import { Graph, alg } from '@dagrejs/graphlib';
import type { MutateLanePlanRequest } from '@harness-dsl/core';

/**
 * Builds a `@dagrejs/graphlib` directed `Graph` from `depsByItem` where each edge points `itemKey -> depKey`.
 *
 * Registers every item and prerequisite node and rejects direct self-loops (`itemKey === depKey`) immediately.
 *
 * @param {ReadonlyMap<string, readonly string[]>} depsByItem - Adjacency map of `itemKey -> dependsOn[]`.
 *
 * @returns {Graph} Populated `@dagrejs/graphlib` directed graph.
 */
function buildPrerequisiteGraph(depsByItem: ReadonlyMap<string, readonly string[]>): Graph {
  const graph = new Graph({ directed: true });
  for (const [nodeKey, directDeps] of depsByItem.entries()) {
    graph.setNode(nodeKey);
    for (const depKey of directDeps) {
      if (nodeKey === depKey) {
        throw new Error(`Cycle detected in lane prerequisite DAG involving item '${nodeKey}'.`);
      }
      graph.setNode(depKey);
      graph.setEdge(nodeKey, depKey);
    }
  }
  return graph;
}

/**
 * Validates that the lane prerequisite graph `depsByItem` is acyclic and within `maxPrerequisiteDepth`.
 *
 * Uses `@dagrejs/graphlib` (`alg.isAcyclic`, `alg.findCycles`, and `alg.topsort`) to reject cycles
 * and enforce `maxPrerequisiteDepth` across all prerequisite chains before committing.
 *
 * @param {ReadonlyMap<string, readonly string[]>} depsByItem           - Adjacency map of `itemKey -> dependsOn[]`.
 * @param {number}                                 maxPrerequisiteDepth - Maximum allowed prerequisite chain depth.
 * @param {string}                                 laneId               - Enclosing lane identifier for error diagnostics.
 *
 * @returns {void} Returns nothing when the graph is acyclic and within `maxPrerequisiteDepth`.
 */
export function assertValidLaneDag(
  depsByItem: ReadonlyMap<string, readonly string[]>,
  maxPrerequisiteDepth: number,
  laneId: string,
): void {
  const graph = buildPrerequisiteGraph(depsByItem);
  if (!alg.isAcyclic(graph)) {
    const cycles = alg.findCycles(graph);
    const firstCycleNode = cycles[0]?.[0] ?? 'unknown';
    throw new Error(`Cycle detected in lane prerequisite DAG involving item '${firstCycleNode}'.`);
  }
  const topoOrder = alg.topsort(graph);
  const depthMemo = new Map<string, number>();
  for (let idx = topoOrder.length - 1; idx >= 0; idx -= 1) {
    const nodeKey = topoOrder[idx];
    if (nodeKey === undefined) continue;
    const directDeps = graph.successors(nodeKey) ?? [];
    let maxChildDepth = 0;
    for (const depKey of directDeps) {
      const edgeDepth = 1 + (depthMemo.get(depKey) ?? 0);
      if (edgeDepth > maxChildDepth) maxChildDepth = edgeDepth;
    }
    if (maxChildDepth > maxPrerequisiteDepth) {
      throw new Error(
        `Prerequisite chain depth ${String(maxChildDepth)} for item '${nodeKey}' in lane '${laneId}' exceeds maxPrerequisiteDepth (${String(maxPrerequisiteDepth)}).`,
      );
    }
    depthMemo.set(nodeKey, maxChildDepth);
  }
}

/**
 * Builds the chained lane dependency graph for `req` and validates DAG acyclicity and `maxPrerequisiteDepth`.
 *
 * Chains newly spawned prerequisite items linearly onto any previously spawned tip prerequisite of `req.parentItemKey`.
 *
 * @param {ReadonlyArray<{ readonly item_key: string; readonly depends_on_json: string; readonly latest_spawned_tip_key: string | null }>} existingRows - Current lane rows.
 * @param {MutateLanePlanRequest}                                                                                                          req          - Plan mutation request.
 *
 * @returns {{ readonly depsByItem: Map<string, string[]>; readonly rollingTip: string | undefined; readonly nextParentDeps: string[] }} Validated DAG update state.
 */
export function buildChainedLaneDependencies(
  existingRows: ReadonlyArray<{ readonly item_key: string; readonly depends_on_json: string; readonly latest_spawned_tip_key: string | null }>,
  req: MutateLanePlanRequest,
): { readonly depsByItem: Map<string, string[]>; readonly rollingTip: string | undefined; readonly nextParentDeps: string[] } {
  const depsByItem = new Map<string, string[]>();
  let prevTipKey: string | undefined;
  for (const row of existingRows) {
    depsByItem.set(row.item_key, JSON.parse(row.depends_on_json) as string[]);
    if (row.item_key === req.parentItemKey && row.latest_spawned_tip_key !== null) prevTipKey = row.latest_spawned_tip_key;
  }
  const currentParentDeps = depsByItem.get(req.parentItemKey) ?? [];
  if (prevTipKey === undefined && currentParentDeps.length > 0) prevTipKey = currentParentDeps[currentParentDeps.length - 1];
  const spawned = req.spawnedItems ?? [];
  let rollingTip = prevTipKey;
  for (const spawnedTask of spawned) {
    const taskDepSet = new Set<string>();
    if (rollingTip !== undefined) taskDepSet.add(rollingTip);
    for (const dep of spawnedTask.dependsOn) taskDepSet.add(dep);
    depsByItem.set(spawnedTask.itemKey, Array.from(taskDepSet));
    rollingTip = spawnedTask.itemKey;
  }
  const nextParentDepSet = new Set<string>();
  for (const existingDep of currentParentDeps) {
    if (spawned.length === 0 || existingDep !== prevTipKey) nextParentDepSet.add(existingDep);
  }
  if (spawned.length > 0 && rollingTip !== undefined) nextParentDepSet.add(rollingTip);
  for (const addedDep of req.addedDependencies ?? []) {
    nextParentDepSet.add(addedDep);
    if (!depsByItem.has(addedDep)) depsByItem.set(addedDep, []);
  }
  const nextParentDeps = Array.from(nextParentDepSet);
  depsByItem.set(req.parentItemKey, nextParentDeps);
  assertValidLaneDag(depsByItem, req.maxPrerequisiteDepth, req.laneId);
  return { depsByItem, rollingTip, nextParentDeps };
}
