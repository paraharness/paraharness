import type { MutateLanePlanRequest } from '@harness-dsl/core';

/**
 * Computes the prerequisite chain depth from `nodeKey` while detecting directed cycles in `depsByItem`.
 *
 * Uses 3-color DFS (`0` unvisited, `1` visiting, `2` visited) with memoized depth lookup.
 *
 * @param {string}                                                                           nodeKey    - Starting work item key.
 * @param {ReadonlyMap<string, readonly string[]>}                                           depsByItem - Adjacency map of `itemKey -> dependsOn[]`.
 * @param {{ readonly state: Map<string, number>; readonly depthMemo: Map<string, number> }} traversal  - DFS state and memo tables.
 *
 * @returns {number} Maximum prerequisite chain depth starting from `nodeKey`.
 */
export function computeNodePrerequisiteDepth(
  nodeKey: string,
  depsByItem: ReadonlyMap<string, readonly string[]>,
  traversal: { readonly state: Map<string, number>; readonly depthMemo: Map<string, number> },
): number {
  const visitState = traversal.state.get(nodeKey) ?? 0;
  if (visitState === 1) throw new Error(`Cycle detected in lane prerequisite DAG involving item '${nodeKey}'.`);
  if (visitState === 2) return traversal.depthMemo.get(nodeKey) ?? 0;
  traversal.state.set(nodeKey, 1);
  const directDeps = depsByItem.get(nodeKey) ?? [];
  let maxChildDepth = 0;
  for (const depKey of directDeps) {
    const edgeDepth = 1 + computeNodePrerequisiteDepth(depKey, depsByItem, traversal);
    if (edgeDepth > maxChildDepth) maxChildDepth = edgeDepth;
  }
  traversal.state.set(nodeKey, 2);
  traversal.depthMemo.set(nodeKey, maxChildDepth);
  return maxChildDepth;
}

/**
 * Validates that the lane prerequisite graph `depsByItem` is acyclic and within `maxPrerequisiteDepth`.
 *
 * Rejects any self-loop, cycle, or prerequisite chain exceeding `maxPrerequisiteDepth` before commit.
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
  const traversal = { state: new Map<string, number>(), depthMemo: new Map<string, number>() };
  for (const nodeKey of depsByItem.keys()) {
    const depth = computeNodePrerequisiteDepth(nodeKey, depsByItem, traversal);
    if (depth > maxPrerequisiteDepth) {
      throw new Error(`Prerequisite chain depth ${String(depth)} for item '${nodeKey}' in lane '${laneId}' exceeds maxPrerequisiteDepth (${String(maxPrerequisiteDepth)}).`);
    }
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
    const taskDeps: string[] = rollingTip !== undefined && !spawnedTask.dependsOn.includes(rollingTip) ? [rollingTip] : [];
    for (const dep of spawnedTask.dependsOn) if (!taskDeps.includes(dep)) taskDeps.push(dep);
    depsByItem.set(spawnedTask.itemKey, taskDeps);
    rollingTip = spawnedTask.itemKey;
  }
  const nextParentDeps: string[] = [];
  for (const existingDep of currentParentDeps) {
    if ((spawned.length === 0 || existingDep !== prevTipKey) && !nextParentDeps.includes(existingDep)) nextParentDeps.push(existingDep);
  }
  if (spawned.length > 0 && rollingTip !== undefined && !nextParentDeps.includes(rollingTip)) nextParentDeps.push(rollingTip);
  for (const addedDep of req.addedDependencies ?? []) {
    if (!nextParentDeps.includes(addedDep)) nextParentDeps.push(addedDep);
    if (!depsByItem.has(addedDep)) depsByItem.set(addedDep, []);
  }
  depsByItem.set(req.parentItemKey, nextParentDeps);
  assertValidLaneDag(depsByItem, req.maxPrerequisiteDepth, req.laneId);
  return { depsByItem, rollingTip, nextParentDeps };
}
