import type { PoolCandidateState } from '../../../ast/pool-candidate-state.js';
import type { PoolNode } from '../../../ast/pool-node.js';
import type { PoolSelectionContext } from '../../../ast/pool-selection-context.js';
import type { PoolRuntimeState } from '../pool-runtime-state.js';
import { buildPoolCandidateStates } from './evaluate-pool-strategy.js';

/**
 * Finds the active sticky candidate in `candidates` if its rate-limit window has expired at `nowMs`.
 *
 * Returns `undefined` when no sticky candidate ID is set or the sticky candidate is currently rate-limited.
 *
 * @template TItem Pooled candidate item type.
 *
 * @param {readonly PoolCandidateState<TItem>[]} candidates - Candidate state snapshots for the pool.
 * @param {string | undefined}                   stickyId   - Sticky candidate ID bound to the run.
 * @param {number}                               nowMs      - Current epoch timestamp in milliseconds.
 *
 * @returns {PoolCandidateState<TItem> | undefined} Healthy sticky candidate snapshot, or `undefined`.
 */
export function findAvailableStickyCandidate<TItem>(
  candidates: readonly PoolCandidateState<TItem>[],
  stickyId: string | undefined,
  nowMs: number,
): PoolCandidateState<TItem> | undefined {
  if (stickyId === undefined) {
    return undefined;
  }
  for (const candidate of candidates) {
    if (candidate.id !== stickyId) {
      continue;
    }
    const isAvailable =
      candidate.rateLimitedUntilMs === undefined || candidate.rateLimitedUntilMs <= nowMs;
    return isAvailable ? candidate : undefined;
  }
  return undefined;
}

/**
 * Filters `candidates` down to those not currently rate-limited past `nowMs`.
 *
 * Preserves declaration order from `pool.items`.
 *
 * @template TItem Pooled candidate item type.
 *
 * @param {readonly PoolCandidateState<TItem>[]} candidates - All candidate state snapshots in the pool.
 * @param {number}                               nowMs      - Current epoch timestamp in milliseconds.
 *
 * @returns {readonly PoolCandidateState<TItem>[]} Non-rate-limited candidate snapshots.
 */
function filterAvailablePoolCandidates<TItem>(
  candidates: readonly PoolCandidateState<TItem>[],
  nowMs: number,
): readonly PoolCandidateState<TItem>[] {
  const available: PoolCandidateState<TItem>[] = [];
  for (const candidate of candidates) {
    if (candidate.rateLimitedUntilMs === undefined || candidate.rateLimitedUntilMs <= nowMs) {
      available.push(candidate);
    }
  }
  return available;
}

/**
 * Selects a candidate under `'escalate-on-retry'` strategy rules (`SPEC.md` §3.2).
 *
 * Advances past `selectionCtx.retryAttempt` and skips candidates whose empirical success rate
 * falls below `minSuccessRate` once `minSamples` have been collected.
 *
 * @template TItem Pooled candidate item type.
 *
 * @param {PoolNode<TItem>}                      pool         - Passive pool AST node.
 * @param {readonly PoolCandidateState<TItem>[]} available    - Available non-rate-limited candidates.
 * @param {PoolSelectionContext}                 selectionCtx - Selection context with `retryAttempt`.
 *
 * @returns {TItem | undefined} Selected candidate item or `fallbackItem`.
 */
function selectEscalateOnRetryItem<TItem>(
  pool: PoolNode<TItem>,
  available: readonly PoolCandidateState<TItem>[],
  selectionCtx: PoolSelectionContext,
): TItem | undefined {
  if (pool.strategy.strategyKind !== 'escalate-on-retry') {
    return undefined;
  }
  const minRate = pool.strategy.minSuccessRate ?? 0;
  const minSamples = pool.strategy.minSamples ?? 1;
  const startIndex = Math.min(selectionCtx.retryAttempt, available.length - 1);
  for (let i = startIndex; i < available.length; i += 1) {
    const candidate = available[i];
    if (
      candidate !== undefined &&
      (candidate.sampleCount < minSamples || candidate.empiricalSuccessRate >= minRate)
    ) {
      return candidate.item;
    }
  }
  const lastCandidate = available[available.length - 1];
  if (
    pool.fallbackItem !== undefined &&
    lastCandidate !== undefined &&
    lastCandidate.sampleCount >= minSamples &&
    lastCandidate.empiricalSuccessRate < minRate
  ) {
    return pool.fallbackItem;
  }
  return lastCandidate?.item;
}

/**
 * Selects the best available candidate by `'least-used'` or `'soonest-reset'` ordering.
 *
 * Compares `usageCount` for `'least-used'` and `rateLimitedUntilMs` for `'soonest-reset'`.
 *
 * @template TItem Pooled candidate item type.
 *
 * @param {PoolNode<TItem>}                      pool      - Passive pool AST node.
 * @param {readonly PoolCandidateState<TItem>[]} available - Available non-rate-limited candidates.
 *
 * @returns {TItem | undefined} Selected candidate item.
 */
function selectLeastUsedOrSoonestCandidate<TItem>(
  pool: PoolNode<TItem>,
  available: readonly PoolCandidateState<TItem>[],
): TItem | undefined {
  let best = available[0];
  for (const candidate of available) {
    if (best === undefined) {
      best = candidate;
      continue;
    }
    const isLeastUsed = pool.strategy.strategyKind === 'least-used';
    const isBetter = isLeastUsed
      ? candidate.usageCount < best.usageCount
      : (candidate.rateLimitedUntilMs ?? 0) < (best.rateLimitedUntilMs ?? 0);
    if (isBetter) {
      best = candidate;
    }
  }
  return best?.item;
}

/**
 * Resolves `pool.fallbackItem` or the soonest-resetting candidate when all primary candidates are rate-limited (`SPEC.md` §3.2).
 *
 * Throws an actionable error if the pool has zero candidates and no `fallbackItem`.
 *
 * @template TItem Pooled candidate item type.
 *
 * @param {PoolNode<TItem>}                      pool       - Passive pool AST node.
 * @param {readonly PoolCandidateState<TItem>[]} candidates - All candidate state snapshots in the pool.
 * @param {string}                               runId      - Active flow run identifier.
 *
 * @returns {TItem} Fallback item or soonest-resetting candidate item.
 *
 * @throws {Error} If `pool` has zero candidates and no `fallbackItem`.
 */
export function resolveFallbackSeatOrThrow<TItem>(
  pool: PoolNode<TItem>,
  candidates: readonly PoolCandidateState<TItem>[],
  runId: string,
): TItem {
  if (pool.fallbackItem !== undefined) {
    return pool.fallbackItem;
  }
  let soonest = candidates[0];
  for (const candidate of candidates) {
    if (
      soonest === undefined ||
      (candidate.rateLimitedUntilMs ?? 0) < (soonest.rateLimitedUntilMs ?? 0)
    ) {
      soonest = candidate;
    }
  }
  if (soonest === undefined) {
    throw new Error(
      `Pool '${pool.id}' has zero candidates and no fallbackItem for run '${runId}'.`,
    );
  }
  return soonest.item;
}

/**
 * Selects a candidate item from `pool` according to `pool.strategy` and `selectionCtx` (`SPEC.md` §3.2).
 *
 * Evaluates `'custom'`, `'escalate-on-retry'`, `'round-robin'`, `'least-used'`, and `'soonest-reset'`
 * strategies over `pool.items`, returning `undefined` when all primary candidates are rate-limited.
 *
 * @template TItem Pooled candidate item type.
 *
 * @param {PoolNode<TItem>}      pool         - Passive pool AST node.
 * @param {PoolRuntimeState}     poolState    - Mutable runtime state for `pool.id`.
 * @param {PoolSelectionContext} selectionCtx - Selection context carrying `runId`, `retryAttempt`, and `nowMs`.
 *
 * @returns {TItem | undefined} Selected primary or custom candidate item, or `undefined` when all primary candidates are rate-limited.
 */
export function selectCandidateByPoolStrategy<TItem>(
  pool: PoolNode<TItem>,
  poolState: PoolRuntimeState,
  selectionCtx: PoolSelectionContext,
): TItem | undefined {
  const candidates = buildPoolCandidateStates(pool, poolState);
  if (pool.strategy.strategyKind === 'custom') {
    const picked = pool.strategy.selectFn(candidates, selectionCtx);
    if (picked !== undefined) {
      return picked;
    }
  }
  const available = filterAvailablePoolCandidates(candidates, selectionCtx.nowMs);
  if (available.length === 0) {
    return undefined;
  }
  if (pool.strategy.strategyKind === 'escalate-on-retry') {
    return selectEscalateOnRetryItem(pool, available, selectionCtx);
  }
  if (pool.strategy.strategyKind === 'round-robin') {
    const picked = available[poolState.roundRobinCursor % available.length] ?? available[0];
    poolState.roundRobinCursor += 1;
    return picked?.item;
  }
  return selectLeastUsedOrSoonestCandidate(pool, available);
}
