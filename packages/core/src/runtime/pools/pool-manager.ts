import type { AccountSeatASTNode, ModelASTNode } from '../../ast/domain-ast.types.js';
import type { PoolNode } from '../../ast/pool-node.js';
import type { PoolSelectionContext } from '../../ast/pool-selection-context.js';
import {
  buildPoolCandidateStates,
  extractPoolCandidateId,
  getOrCreateCandidateMetrics,
  recordPoolCandidateUsage,
} from './internal/evaluate-pool-strategy.js';
import {
  findAvailableStickyCandidate,
  resolveFallbackSeatOrThrow,
  selectCandidateByPoolStrategy,
} from './internal/select-pool-candidate.js';
import type { PoolModelSelectionOptions } from './pool-model-selection-options.js';
import type { PoolRuntimeState } from './pool-runtime-state.js';

/**
 * Runtime capacity pool scheduler managing run-sticky account seat affinity, HTTP `429`
 * rate-limit failover, and empirical `'escalate-on-retry'` model selection (`SPEC.md` §3.2).
 *
 * Ensures that all turns and child forks within a `runId` stick to the same account seat
 * until rate-limited (`429`), while escalating model tiers on retries or low empirical completion rates.
 */
export class PoolManager {
  /** Per-pool runtime state indexed by `pool.id`. */
  private readonly pools = new Map<string, PoolRuntimeState>();

  /**
   * Selects an account seat from `pool` for `runId`, preserving run-sticky seat affinity when healthy.
   *
   * Reuses the seat previously bound to `runId` unless that seat is currently rate-limited past `nowMs`,
   * in which case it fails over via `pool.strategy` or `pool.fallbackItem`.
   *
   * @template TSeat Account seat AST node type.
   *
   * @param {PoolNode<TSeat>} pool          - Account seat pool AST node.
   * @param {string}          runId         - Active flow run identifier for seat affinity.
   * @param {number}          [nowMs]       - Optional epoch timestamp in milliseconds (defaults to `Date.now()`).
   *
   * @returns {TSeat} Selected account seat AST node.
   */
  selectSeat<TSeat extends AccountSeatASTNode>(
    pool: PoolNode<TSeat>,
    runId: string,
    nowMs: number = Date.now(),
  ): TSeat {
    const poolState = this.getOrCreatePoolState(pool.id);
    const stickySeatId = poolState.stickySeatByRunId.get(runId);
    const candidates = buildPoolCandidateStates(pool, poolState);
    const activeSticky = findAvailableStickyCandidate(candidates, stickySeatId, nowMs);
    if (activeSticky !== undefined) {
      recordPoolCandidateUsage(poolState, activeSticky.id, nowMs);
      return activeSticky.item;
    }
    if (stickySeatId !== undefined) {
      poolState.stickySeatByRunId.delete(runId);
    }

    const selectionCtx: PoolSelectionContext = Object.freeze<PoolSelectionContext>({
      poolId: pool.id,
      runId,
      retryAttempt: 0,
      nowMs,
      stickyCandidateId: stickySeatId,
    });
    const selected =
      selectCandidateByPoolStrategy(pool, poolState, selectionCtx) ??
      resolveFallbackSeatOrThrow(pool, candidates, runId);
    recordPoolCandidateUsage(poolState, selected.id, nowMs);
    if (this.isPrimarySeat(pool, selected.id)) {
      poolState.stickySeatByRunId.set(runId, selected.id);
    }
    return selected;
  }

  /**
   * Resolves a single `ModelASTNode` or selects a candidate from a model `PoolNode` for `runId`.
   *
   * Evaluates `'escalate-on-retry'`, standard, or custom pool strategies using `retryAttempt`
   * and empirical completion rates tracked per model candidate.
   *
   * @template TModel Model AST node type.
   *
   * @param {TModel | PoolNode<TModel>}          modelOrPool - Direct model node or model pool node.
   * @param {string}                             runId       - Active flow run identifier.
   * @param {number | PoolModelSelectionOptions} [options=0] - Retry attempt number or selection options.
   *
   * @returns {TModel} Selected model AST node.
   */
  selectModel<TModel extends ModelASTNode>(
    modelOrPool: TModel | PoolNode<TModel>,
    runId: string,
    options: number | PoolModelSelectionOptions = 0,
  ): TModel {
    if (!this.isPoolNode(modelOrPool)) {
      return modelOrPool;
    }
    const retryAttempt = typeof options === 'number' ? options : (options.retryAttempt ?? 0);
    const nowMs = typeof options === 'number' ? Date.now() : (options.nowMs ?? Date.now());
    const poolState = this.getOrCreatePoolState(modelOrPool.id);
    const candidates = buildPoolCandidateStates(modelOrPool, poolState);
    const selectionCtx: PoolSelectionContext = Object.freeze<PoolSelectionContext>({
      poolId: modelOrPool.id,
      runId,
      retryAttempt,
      nowMs,
      stickyCandidateId: undefined,
    });
    const selected =
      selectCandidateByPoolStrategy(modelOrPool, poolState, selectionCtx) ??
      resolveFallbackSeatOrThrow(modelOrPool, candidates, runId);
    const candidateId = extractPoolCandidateId(selected, 0);
    recordPoolCandidateUsage(poolState, candidateId, nowMs);
    return selected;
  }

  /**
   * Records an HTTP `429` rate-limit cooldown until `resetAtMs` for `candidateId` in `poolId`.
   *
   * Automatically evicts any run-sticky seat affinity pointing to `candidateId` so subsequent
   * turns fail over to another seat or `fallbackItem`.
   *
   * @param {string} poolId      - Identifier of the capacity pool.
   * @param {string} candidateId - Identifier of the rate-limited seat or model (`seat.id` or `model.modelId`).
   * @param {number} resetAtMs   - Epoch timestamp in milliseconds when the rate limit resets.
   */
  recordRateLimit429(poolId: string, candidateId: string, resetAtMs: number): void {
    const poolState = this.getOrCreatePoolState(poolId);
    const metrics = getOrCreateCandidateMetrics(poolState, candidateId);
    metrics.rateLimitedUntilMs = resetAtMs;
    for (const [runId, stickyId] of poolState.stickySeatByRunId) {
      if (stickyId === candidateId) {
        poolState.stickySeatByRunId.delete(runId);
      }
    }
  }

  /**
   * Records a completed or failed execution outcome for `candidateId` in `poolId`.
   *
   * Updates `sampleCount` and `successCount` used by `'escalate-on-retry'` (`minSuccessRate` / `minSamples`).
   *
   * @param {string}  poolId      - Identifier of the model pool.
   * @param {string}  candidateId - Identifier of the model candidate (`model.modelId` or `model.alias`).
   * @param {boolean} succeeded   - True when the model execution completed and passed evaluation.
   */
  recordModelOutcome(poolId: string, candidateId: string, succeeded: boolean): void {
    const poolState = this.getOrCreatePoolState(poolId);
    const metrics = getOrCreateCandidateMetrics(poolState, candidateId);
    metrics.sampleCount += 1;
    if (succeeded) {
      metrics.successCount += 1;
    }
  }

  /**
   * Releases all sticky seat bindings associated with `runId` across all managed pools.
   *
   * Invoked when a flow run reaches a terminal exit state.
   *
   * @param {string} runId - Completed or terminated flow run identifier.
   */
  releaseRunSeats(runId: string): void {
    for (const poolState of this.pools.values()) {
      poolState.stickySeatByRunId.delete(runId);
    }
  }

  /**
   * Checks whether `seatId` belongs to `pool.items` (as opposed to `pool.fallbackItem`).
   *
   * Only primary pool seats are pinned in `stickySeatByRunId`.
   *
   * @template TSeat Account seat AST node type.
   *
   * @param {PoolNode<TSeat>} pool   - Account seat pool AST node.
   * @param {string}          seatId - Candidate seat identifier.
   *
   * @returns {boolean} True when `seatId` matches a seat in `pool.items`.
   */
  private isPrimarySeat<TSeat extends AccountSeatASTNode>(
    pool: PoolNode<TSeat>,
    seatId: string,
  ): boolean {
    for (const item of pool.items) {
      if (item.id === seatId) {
        return true;
      }
    }
    return false;
  }

  /**
   * Narrows a `TModel | PoolNode<TModel>` union to `PoolNode<TModel>`.
   *
   * Inspects the passive `type === 'harness:pool'` discriminant without duck-typing methods.
   *
   * @template TModel Model AST node type.
   *
   * @param {TModel | PoolNode<TModel>} candidate - Union value to check.
   *
   * @returns {candidate is PoolNode<TModel>} True when `candidate` is a `PoolNode`.
   */
  private isPoolNode<TModel extends ModelASTNode>(
    candidate: TModel | PoolNode<TModel>,
  ): candidate is PoolNode<TModel> {
    return (candidate as { readonly type: string }).type === 'harness:pool';
  }

  /**
   * Retrieves or creates the mutable `PoolRuntimeState` for `poolId`.
   *
   * Initializes empty candidate metric and sticky-seat maps on first access.
   *
   * @param {string} poolId - Pool identifier.
   *
   * @returns {PoolRuntimeState} Mutable pool state record.
   */
  private getOrCreatePoolState(poolId: string): PoolRuntimeState {
    const existing = this.pools.get(poolId);
    if (existing !== undefined) {
      return existing;
    }
    const created: PoolRuntimeState = {
      poolId,
      metricsById: new Map(),
      roundRobinCursor: 0,
      stickySeatByRunId: new Map(),
    };
    this.pools.set(poolId, created);
    return created;
  }
}
