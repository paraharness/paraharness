import { Graph, alg } from '@dagrejs/graphlib';
import type { LaneQueuedItemState } from '../lane-queued-item-state.js';

/**
 * Candidate work item key and prerequisite list passed to `assertAcyclicLaneDependencies`.
 */
export interface AssertAcyclicLaneDependenciesCandidateParams {
  /** Deduplication key of the work item being enqueued. */
  readonly itemKey: string;

  /** Prerequisite work item keys required before the candidate can run. */
  readonly dependsOn: readonly string[];
}

/**
 * Validates that adding `candidate.dependsOn` for `candidate.itemKey` introduces zero directed cycles in `laneId` (`SPEC.md` §3.10).
 *
 * Builds a directed `Graph` via `@dagrejs/graphlib` and invokes `alg.findCycles` to reject self-loops and multi-item cycles.
 *
 * @template TIn Validated lane work item input type.
 *
 * @param {string}                                         laneId     - Target lane identifier.
 * @param {ReadonlyMap<string, LaneQueuedItemState<TIn>>} itemsByKey - Existing tracked items in the lane.
 * @param {AssertAcyclicLaneDependenciesCandidateParams}   candidate  - Work item key being enqueued and its prerequisite item keys.
 *
 * @throws {Error} If a self-dependency or directed prerequisite cycle is detected.
 */
export function assertAcyclicLaneDependencies<TIn = unknown>(
  laneId: string,
  itemsByKey: ReadonlyMap<string, LaneQueuedItemState<TIn>>,
  candidate: AssertAcyclicLaneDependenciesCandidateParams,
): void {
  const { itemKey: candidateKey, dependsOn: candidateDeps } = candidate;
  const graph = new Graph({ directed: true });
  for (const [key, existing] of itemsByKey.entries()) {
    for (const dep of existing.dependsOn) {
      graph.setEdge(key, dep);
    }
  }
  for (const dep of candidateDeps) {
    if (dep === candidateKey) {
      throw new Error(`Self-dependency cycle on '${candidateKey}' in lane '${laneId}'.`);
    }
    graph.setEdge(candidateKey, dep);
  }
  const firstCycle = alg.findCycles(graph)[0];
  if (firstCycle !== undefined) {
    throw new Error(
      `Prerequisite dependency cycle in lane '${laneId}': ${firstCycle.join(' -> ')}.`,
    );
  }
}
