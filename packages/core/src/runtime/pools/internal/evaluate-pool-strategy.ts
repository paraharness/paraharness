import type { PoolCandidateState } from '../../../ast/pool-candidate-state.js';
import type { PoolNode } from '../../../ast/pool-node.js';
import type {
  PoolCandidateRuntimeMetrics,
  PoolRuntimeState,
} from '../pool-runtime-state.js';

/**
 * Extracts a deterministic string identifier from a pooled account seat or model AST node.
 *
 * Inspects `id`, `modelId`, and `alias` fields before falling back to the candidate's zero-based index.
 *
 * @param {unknown} item  - Pooled candidate AST node or object.
 * @param {number}  index - Zero-based index of the candidate in `pool.items`.
 *
 * @returns {string} Canonical identifier string for the candidate.
 */
export function extractPoolCandidateId(item: unknown, index: number): string {
  if (typeof item === 'object' && item !== null) {
    const rec = item as Readonly<Record<string, unknown>>;
    if (typeof rec['id'] === 'string' && rec['id'].length > 0) {
      return rec['id'];
    }
    if (typeof rec['modelId'] === 'string' && rec['modelId'].length > 0) {
      return rec['modelId'];
    }
    if (typeof rec['alias'] === 'string' && rec['alias'].length > 0) {
      return rec['alias'];
    }
  }
  return `candidate:${String(index)}`;
}

/**
 * Retrieves or initializes the mutable runtime metrics record for `candidateId` in `poolState`.
 *
 * Initializes counters to zero and `empiricalSuccessRate` baseline to `1.0` when unseen.
 *
 * @param {PoolRuntimeState} poolState   - Mutable runtime state of the enclosing pool.
 * @param {string}           candidateId - Identifier of the candidate item.
 *
 * @returns {PoolCandidateRuntimeMetrics} Mutable metrics entry for `candidateId`.
 */
export function getOrCreateCandidateMetrics(
  poolState: PoolRuntimeState,
  candidateId: string,
): PoolCandidateRuntimeMetrics {
  const existing = poolState.metricsById.get(candidateId);
  if (existing !== undefined) {
    return existing;
  }
  const created: PoolCandidateRuntimeMetrics = {
    id: candidateId,
    rateLimitedUntilMs: undefined,
    usageCount: 0,
    lastUsedAtMs: undefined,
    successCount: 0,
    sampleCount: 0,
  };
  poolState.metricsById.set(candidateId, created);
  return created;
}

/**
 * Records a single candidate usage event in `poolState` at `nowMs`.
 *
 * Increments `usageCount` by one and sets `lastUsedAtMs` to `nowMs`.
 *
 * @param {PoolRuntimeState} poolState   - Mutable runtime state of the enclosing pool.
 * @param {string}           candidateId - Identifier of the selected candidate item.
 * @param {number}           nowMs       - Current epoch timestamp in milliseconds.
 */
export function recordPoolCandidateUsage(
  poolState: PoolRuntimeState,
  candidateId: string,
  nowMs: number,
): void {
  const metrics = getOrCreateCandidateMetrics(poolState, candidateId);
  metrics.usageCount += 1;
  metrics.lastUsedAtMs = nowMs;
}

/**
 * Builds the immutable `PoolCandidateState<TItem>[]` snapshot array for `pool.items`.
 *
 * Combines each candidate item with its live usage counters, rate-limit window, and empirical
 * success rate (`successCount / sampleCount`, defaulting to `1` when `sampleCount === 0`).
 *
 * @template TItem Pooled candidate item type.
 *
 * @param {PoolNode<TItem>}  pool      - Passive pool AST node.
 * @param {PoolRuntimeState} poolState - Mutable runtime state for `pool.id`.
 *
 * @returns {readonly PoolCandidateState<TItem>[]} Frozen array of candidate state snapshots.
 */
export function buildPoolCandidateStates<TItem>(
  pool: PoolNode<TItem>,
  poolState: PoolRuntimeState,
): readonly PoolCandidateState<TItem>[] {
  const states: PoolCandidateState<TItem>[] = [];
  for (let i = 0; i < pool.items.length; i += 1) {
    const item = pool.items[i];
    if (item === undefined) {
      continue;
    }
    const id = extractPoolCandidateId(item, i);
    const metrics = getOrCreateCandidateMetrics(poolState, id);
    const empiricalSuccessRate =
      metrics.sampleCount > 0 ? metrics.successCount / metrics.sampleCount : 1;
    states.push(
      Object.freeze<PoolCandidateState<TItem>>({
        item,
        index: i,
        id,
        rateLimitedUntilMs: metrics.rateLimitedUntilMs,
        usageCount: metrics.usageCount,
        lastUsedAtMs: metrics.lastUsedAtMs,
        successCount: metrics.successCount,
        sampleCount: metrics.sampleCount,
        empiricalSuccessRate,
      }),
    );
  }
  return Object.freeze(states);
}
