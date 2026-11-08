import { Graph, alg } from '@dagrejs/graphlib';
import type { MutateLanePlanRequest } from '@metaharness/core';

/**
 * Persisted lane item row shape passed to `buildChainedLaneDependencies`.
 */
export interface ExistingPgLaneItemRowParams {
  /** Work item deduplication key. */
  readonly item_key: string;
  /** JSON-serialized array of prerequisite `item_key` strings. */
  readonly depends_on_json: string;
  /** Most recently chained prerequisite tip key for `item_key`, if any. */
  readonly latest_spawned_tip_key: string | null;
}

/**
 * Validated lane dependency graph state returned by `buildChainedLaneDependencies`.
 */
export interface ChainedPgLaneDependenciesOptions {
  /** Mutable map of `itemKey -> dependsOn[]`. */
  readonly depsByItem: Map<string, string[]>;
  /** Updated prerequisite tip key for `req.parentItemKey`, if any. */
  readonly rollingTip: string | undefined;
  /** Updated direct prerequisite list for `req.parentItemKey`. */
  readonly nextParentDeps: string[];
}

/**
 * Constructs a `@dagrejs/graphlib` directed `Graph` from `depsByItem` and verifies acyclicity via `alg.isAcyclic` and `alg.findCycles`.
 *
 * Throws an actionable error naming the cycle members if any self-loop or multi-node cycle exists.
 *
 * @param {ReadonlyMap<string, readonly string[]>} depsByItem - Adjacency map of `itemKey -> dependsOn[]`.
 * @param {string}                                 laneId     - Enclosing lane identifier for error diagnostics.
 *
 * @returns {Graph} Validated acyclic `@dagrejs/graphlib` directed graph.
 */
export function buildAcyclicLaneGraph(
  depsByItem: ReadonlyMap<string, readonly string[]>,
  laneId: string,
): Graph {
  const graph = new Graph({ directed: true });
  for (const [itemKey, deps] of depsByItem.entries()) {
    graph.setNode(itemKey);
    for (const depKey of deps) {
      graph.setNode(depKey);
      graph.setEdge(itemKey, depKey);
    }
  }
  if (!alg.isAcyclic(graph)) {
    const cycles = alg.findCycles(graph);
    const firstCycle = cycles[0] ?? [];
    throw new Error(
      `Cycle detected in lane prerequisite DAG for lane '${laneId}' involving [${firstCycle.join(', ')}].`,
    );
  }
  return graph;
}

/**
 * Validates that the lane prerequisite graph `depsByItem` is acyclic and within `maxPrerequisiteDepth` using `@dagrejs/graphlib`.
 *
 * Uses `alg.topsort` over the validated DAG to compute longest prerequisite chain depths in $O(V + E)$ time.
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
  const graph = buildAcyclicLaneGraph(depsByItem, laneId);
  const topoOrder = alg.topsort(graph);
  const depthByNode = new Map<string, number>();
  for (let idx = topoOrder.length - 1; idx >= 0; idx -= 1) {
    const nodeKey = topoOrder[idx];
    if (nodeKey !== undefined) {
      const directDeps = graph.successors(nodeKey) ?? [];
      let maxChildDepth = 0;
      for (const depKey of directDeps) {
        const edgeDepth = 1 + (depthByNode.get(depKey) ?? 0);
        if (edgeDepth > maxChildDepth) {
          maxChildDepth = edgeDepth;
        }
      }
      depthByNode.set(nodeKey, maxChildDepth);
      if (maxChildDepth > maxPrerequisiteDepth) {
        throw new Error(
          `Prerequisite chain depth ${String(maxChildDepth)} for item '${nodeKey}' in lane '${laneId}' exceeds maxPrerequisiteDepth (${String(maxPrerequisiteDepth)}).`,
        );
      }
    }
  }
}

/**
 * Builds the chained lane dependency graph for `req` and validates DAG acyclicity and `maxPrerequisiteDepth`.
 *
 * Chains newly spawned prerequisite items linearly onto any previously spawned tip prerequisite of `req.parentItemKey`.
 *
 * @param {readonly ExistingPgLaneItemRowParams[]} existingRows - Current lane rows.
 * @param {MutateLanePlanRequest}                  req          - Plan mutation request.
 *
 * @returns {ChainedPgLaneDependenciesOptions} Validated DAG update state.
 */
export function buildChainedLaneDependencies(
  existingRows: readonly ExistingPgLaneItemRowParams[],
  req: MutateLanePlanRequest,
): ChainedPgLaneDependenciesOptions {
  const depsByItem = new Map<string, string[]>();
  let prevTipKey: string | undefined;
  for (const row of existingRows) {
    depsByItem.set(row.item_key, JSON.parse(row.depends_on_json) as string[]);
    if (row.item_key === req.parentItemKey && row.latest_spawned_tip_key !== null) {
      prevTipKey = row.latest_spawned_tip_key;
    }
  }
  const currentParentDeps = depsByItem.get(req.parentItemKey) ?? [];
  if (prevTipKey === undefined && currentParentDeps.length > 0) {
    prevTipKey = currentParentDeps[currentParentDeps.length - 1];
  }
  const spawned = req.spawnedItems ?? [];
  let rollingTip = prevTipKey;
  for (const spawnedTask of spawned) {
    const taskDepSet = new Set<string>();
    if (rollingTip !== undefined) {
      taskDepSet.add(rollingTip);
    }
    for (const dep of spawnedTask.dependsOn) {
      taskDepSet.add(dep);
    }
    depsByItem.set(spawnedTask.itemKey, Array.from(taskDepSet));
    rollingTip = spawnedTask.itemKey;
  }
  const nextParentDepSet = new Set<string>();
  for (const existingDep of currentParentDeps) {
    if (spawned.length === 0 || existingDep !== prevTipKey) {
      nextParentDepSet.add(existingDep);
    }
  }
  if (spawned.length > 0 && rollingTip !== undefined) {
    nextParentDepSet.add(rollingTip);
  }
  for (const addedDep of req.addedDependencies ?? []) {
    nextParentDepSet.add(addedDep);
    if (!depsByItem.has(addedDep)) {
      depsByItem.set(addedDep, []);
    }
  }
  const nextParentDeps = Array.from(nextParentDepSet);
  depsByItem.set(req.parentItemKey, nextParentDeps);
  assertValidLaneDag(depsByItem, req.maxPrerequisiteDepth, req.laneId);
  return { depsByItem, rollingTip, nextParentDeps };
}
