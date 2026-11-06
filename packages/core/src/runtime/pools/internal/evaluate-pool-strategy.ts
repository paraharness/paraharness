import type { PoolCandidateState } from '../../../ast/pool-candidate-state.js';
import type { PoolNode } from '../../../ast/pool-node.js';
import type { PoolSelectionContext } from '../../../ast/pool-selection-context.js';
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
    if (typeof rec['id'] === 'string' && rec['id'].length > 0) return rec['id'];
    if (typeof rec['modelId'] === 'string' && rec['modelId'].length > 0) return rec['modelId'];
    if (typeof rec['alias'] === 'string' && rec['alias'].length > 0) return rec['alias'];
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
  if (existing !== undefined) return existing;
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
    if (item === undefined) continue;
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

/**
 * Selects a candidate item from `pool` according to `pool.strategy` and `selectionCtx`.
 *
 * Filters out candidates rate-limited past `selectionCtx.nowMs`, applies `'soonest-reset'`,
 * `'round-robin'`, `'least-used'`, `'escalate-on-retry'`, or `'custom'` selection, and cascades
 * to `pool.fallbackItem` when all primary candidates are rate-limited.
 *
 * @template TItem Pooled candidate item type.
 *
 * @param {PoolNode<TItem>}      pool         - Passive pool AST node.
 * @param {PoolRuntimeState}     poolState    - Mutable runtime state for `pool.id`.
 * @param {PoolSelectionContext} selectionCtx - Selection context carrying `runId`, `retryAttempt`, and `nowMs`.
 *
 * @returns {TItem} Selected primary or fallback candidate item.
 */
export function selectCandidateByStrategy<TItem>(
  pool: PoolNode<TItem>, poolState: PoolRuntimeState, selectionCtx: PoolSelectionContext,
): TItem {
  const candidates = buildPoolCandidateStates(pool, poolState);
  const available: PoolCandidateState<TItem>[] = [];
  for (const c of candidates) if (c.rateLimitedUntilMs === undefined || c.rateLimitedUntilMs <= selectionCtx.nowMs) available.push(c);
  if (pool.strategy.strategyKind === 'custom') {
    const picked = pool.strategy.selectFn(candidates, selectionCtx);
    if (picked !== undefined) return picked;
  }
  if (available.length === 0) {
    if (pool.fallbackItem !== undefined) return pool.fallbackItem;
    let soonest = candidates[0];
    for (const c of candidates) if (soonest === undefined || (c.rateLimitedUntilMs ?? 0) < (soonest.rateLimitedUntilMs ?? 0)) soonest = c;
    if (soonest === undefined) throw new Error(`Pool '${pool.id}' has zero candidates and no fallbackItem.`);
    return soonest.item;
  }
  if (pool.strategy.strategyKind === 'escalate-on-retry') {
    const minRate = pool.strategy.minSuccessRate ?? 0, minSamples = pool.strategy.minSamples ?? 1;
    for (let i = Math.min(selectionCtx.retryAttempt, available.length - 1); i < available.length; i += 1) {
      const c = available[i];
      if (c !== undefined && (c.sampleCount < minSamples || c.empiricalSuccessRate >= minRate)) return c.item;
    }
    const last = available[available.length - 1];
    if (pool.fallbackItem !== undefined && last !== undefined && last.sampleCount >= minSamples && last.empiricalSuccessRate < minRate) return pool.fallbackItem;
    if (last !== undefined) return last.item;
  }
  if (pool.strategy.strategyKind === 'round-robin') {
    const picked = available[poolState.roundRobinCursor % available.length] ?? available[0];
    poolState.roundRobinCursor += 1;
    if (picked !== undefined) return picked.item;
  }
  let best = available[0];
  for (const c of available) {
    if (best === undefined) best = c;
    else if (pool.strategy.strategyKind === 'least-used' ? c.usageCount < best.usageCount : (c.rateLimitedUntilMs ?? 0) < (best.rateLimitedUntilMs ?? 0)) best = c;
  }
  if (best === undefined) throw new Error(`Pool '${pool.id}' failed to select a candidate.`);
  return best.item;
}
