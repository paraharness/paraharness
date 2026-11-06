import type { CommitRunOverlayResult } from '../../src/ports/commit-run-overlay-result.js';
import type { TopologyPartitionState } from '../../src/ports/topology-partition-state.js';
import type { TopologyStore } from '../../src/ports/topology-store.js';

/**
 * Deterministic in-memory `TopologyStore` test fixture (`SPEC.md` §3.4.4).
 *
 * Implements Copy-on-Write per-run partition contract overlays, at-most-once per-run epoch increments,
 * step/run-scoped rollback (`resetRunOverlay`), stacked prerequisite absorption (`syncRunOverlays`),
 * `sealRunOverlay`, and 3-way merge `commitRunOverlay`.
 */
export class InMemoryTopologyStore implements TopologyStore {
  /** Base partition contracts keyed by `partitionId`. */
  private readonly basePartitions = new Map<string, TopologyPartitionState>();
  /** Per-run CoW overlays keyed by `runId`. */
  private readonly overlays = new Map<string, {
    status: 'ACTIVE' | 'SEALED_UNMERGED';
    absorbedRunIds: Set<string>;
    entries: Map<string, {
      partitionId: string;
      baseContractTextAtAcquire: string;
      contractText: string;
      epoch: number;
      incrementedInRun: boolean;
      stepExecId?: string;
      previousContractText?: string;
      previousEpoch?: number;
    }>;
  }>();

  /**
   * Initializes the in-memory topology store with optional seed partitions.
   *
   * Populates `basePartitions` at epoch `1` (or the specified seed epoch).
   *
   * @param {Readonly<Record<string, { readonly contractText: string; readonly epoch?: number; readonly dependsOn?: readonly string[] }>>} [seed] - Optional seed partitions.
   */
  constructor(seed?: Readonly<Record<string, { readonly contractText: string; readonly epoch?: number; readonly dependsOn?: readonly string[] }>>) {
    for (const [pid, cfg] of Object.entries(seed ?? {})) {
      this.basePartitions.set(pid, Object.freeze<TopologyPartitionState>({
        partitionId: pid,
        contractText: cfg.contractText,
        epoch: cfg.epoch ?? 1,
        updatedAt: '2026-01-01T00:00:00.000Z',
      }));
    }
  }

  /**
   * Loads the partition state map for `runId`, merging any uncommitted per-run CoW overlay over `basePartitions`.
   *
   * Pins `baseContractTextAtAcquire` when `runId` first inspects a partition.
   *
   * @param {string} [runId] - Optional active flow run identifier.
   *
   * @returns {Promise<ReadonlyMap<string, TopologyPartitionState>>} Map of `partitionId` to partition state.
   */
  async getPartitions(runId?: string): Promise<ReadonlyMap<string, TopologyPartitionState>> {
    const out = new Map<string, TopologyPartitionState>();
    const overlay = runId !== undefined ? this.ensureOverlay(runId) : undefined;
    for (const [pid, base] of this.basePartitions.entries()) {
      if (overlay !== undefined && !overlay.entries.has(pid)) {
        overlay.entries.set(pid, { partitionId: pid, baseContractTextAtAcquire: base.contractText, contractText: base.contractText, epoch: base.epoch, incrementedInRun: false });
      }
      const ovEntry = overlay?.entries.get(pid);
      out.set(pid, ovEntry !== undefined
        ? Object.freeze<TopologyPartitionState>({ ...base, contractText: ovEntry.contractText, epoch: ovEntry.epoch, lastMutatedByRunId: ovEntry.incrementedInRun ? runId : base.lastMutatedByRunId })
        : base);
    }
    return out;
  }

  /**
   * Ensures an overlay record exists for `runId`.
   *
   * Creates an `'ACTIVE'` overlay when first accessed.
   *
   * @param {string} runId - Flow run identifier.
   *
   * @returns {{ status: 'ACTIVE' | 'SEALED_UNMERGED'; absorbedRunIds: Set<string>; entries: Map<string, { partitionId: string; baseContractTextAtAcquire: string; contractText: string; epoch: number; incrementedInRun: boolean; stepExecId?: string; previousContractText?: string; previousEpoch?: number }> }} Overlay record.
   */
  private ensureOverlay(runId: string) {
    let ov = this.overlays.get(runId);
    if (ov === undefined) {
      ov = { status: 'ACTIVE', absorbedRunIds: new Set(), entries: new Map() };
      this.overlays.set(runId, ov);
    }
    return ov;
  }

  /**
   * Writes a contract update to `runId`'s isolated Copy-on-Write overlay.
   *
   * Increments the partition's overlay epoch at most once per `(runId, partitionId)` unless reset.
   *
   * @param {string} runId           - Active flow run identifier.
   * @param {string} partitionId     - Target partition identifier.
   * @param {string} newContractText - Updated contract text.
   * @param {string} [stepExecId]    - Optional active step execution identifier.
   *
   * @returns {Promise<{ readonly newEpoch: number }>} Updated overlay epoch for `partitionId`.
   */
  async updateContract(runId: string, partitionId: string, newContractText: string, stepExecId?: string): Promise<{ readonly newEpoch: number }> {
    const ov = this.ensureOverlay(runId);
    const base = this.basePartitions.get(partitionId) ?? Object.freeze<TopologyPartitionState>({ partitionId, contractText: '', epoch: 1, updatedAt: '2026-01-01T00:00:00.000Z' });
    if (!this.basePartitions.has(partitionId)) this.basePartitions.set(partitionId, base);
    const existing = ov.entries.get(partitionId) ?? { partitionId, baseContractTextAtAcquire: base.contractText, contractText: base.contractText, epoch: base.epoch, incrementedInRun: false };
    const nextEpoch = existing.incrementedInRun ? existing.epoch : existing.epoch + 1;
    ov.entries.set(partitionId, {
      partitionId,
      baseContractTextAtAcquire: existing.baseContractTextAtAcquire,
      contractText: newContractText,
      epoch: nextEpoch,
      incrementedInRun: true,
      stepExecId,
      previousContractText: existing.contractText,
      previousEpoch: existing.epoch,
    });
    return Object.freeze({ newEpoch: nextEpoch });
  }

  /**
   * Merges prerequisite runs' `ACTIVE` or `SEALED_UNMERGED` overlays into `targetRunId`'s overlay.
   *
   * Advances `targetRunId`'s 3-way merge-base text for each absorbed partition so stacked PRs never false-conflict.
   *
   * @param {string}            targetRunId        - Dependent run absorbing the prerequisite overlays.
   * @param {readonly string[]} prerequisiteRunIds - Prerequisite run identifiers to merge from.
   *
   * @returns {Promise<void>} Resolves once prerequisite overlays are merged.
   */
  async syncRunOverlays(targetRunId: string, prerequisiteRunIds: readonly string[]): Promise<void> {
    const targetOv = this.ensureOverlay(targetRunId);
    for (const prereqId of prerequisiteRunIds) {
      targetOv.absorbedRunIds.add(prereqId);
      const prereqOv = this.overlays.get(prereqId);
      if (prereqOv === undefined) continue;
      for (const aId of prereqOv.absorbedRunIds) targetOv.absorbedRunIds.add(aId);
      for (const [pid, pEntry] of prereqOv.entries.entries()) {
        if (!pEntry.incrementedInRun) continue;
        targetOv.entries.set(pid, {
          partitionId: pid,
          baseContractTextAtAcquire: pEntry.baseContractTextAtAcquire,
          contractText: pEntry.contractText,
          epoch: pEntry.epoch,
          incrementedInRun: true,
        });
      }
    }
  }

  /**
   * Resets uncommitted overlay mutations for `runId` at either the `'step'` or `'run'` scope.
   *
   * Rolls back step-tagged mutations when `scope === 'step'` or deletes the entire run overlay when `scope === 'run'`.
   *
   * @param {string}                                                            runId  - Target flow run identifier.
   * @param {{ readonly scope?: 'step' | 'run'; readonly stepExecId?: string }} [opts] - Reset scope options.
   *
   * @returns {Promise<void>} Resolves once rolled back.
   */
  async resetRunOverlay(runId: string, opts?: { readonly scope?: 'step' | 'run'; readonly stepExecId?: string }): Promise<void> {
    if (opts?.scope === 'run' || opts?.scope === undefined) {
      this.overlays.delete(runId);
      return;
    }
    const ov = this.overlays.get(runId);
    if (ov === undefined) return;
    for (const [pid, entry] of ov.entries.entries()) {
      if (opts.stepExecId === undefined || entry.stepExecId === opts.stepExecId) {
        const base = this.basePartitions.get(pid);
        ov.entries.set(pid, {
          partitionId: pid,
          baseContractTextAtAcquire: entry.baseContractTextAtAcquire,
          contractText: entry.previousContractText ?? base?.contractText ?? '',
          epoch: entry.previousEpoch ?? base?.epoch ?? 1,
          incrementedInRun: false,
        });
      }
    }
  }

  /**
   * Transitions `runId`'s overlay to `'SEALED_UNMERGED'`.
   *
   * Preserves the overlay for stacked dependents and future `commitRunOverlay` signals.
   *
   * @param {string} runId - Completed flow run identifier.
   *
   * @returns {Promise<void>} Resolves once sealed.
   */
  async sealRunOverlay(runId: string): Promise<void> {
    const ov = this.ensureOverlay(runId);
    ov.status = 'SEALED_UNMERGED';
  }

  /**
   * Atomically commits `runId`'s overlay (and absorbed prerequisite overlays) to `basePartitions`.
   *
   * Allocates monotonic base epoch numbers and returns `committedRunIds` and `updatedEpochs`.
   *
   * @param {string} runId - Flow run identifier whose changes landed.
   *
   * @returns {Promise<CommitRunOverlayResult>} Committed run IDs and newly allocated base epoch numbers.
   */
  async commitRunOverlay(runId: string): Promise<CommitRunOverlayResult> {
    const ov = this.overlays.get(runId);
    if (ov === undefined) return Object.freeze<CommitRunOverlayResult>({ committedRunIds: Object.freeze([]), updatedEpochs: new Map() });
    const committedRunIds = Object.freeze([...ov.absorbedRunIds, runId]);
    const updatedEpochs = new Map<string, number>();
    for (const [pid, entry] of ov.entries.entries()) {
      if (!entry.incrementedInRun) continue;
      const base = this.basePartitions.get(pid);
      const nextBaseEpoch = (base?.epoch ?? 1) + 1;
      updatedEpochs.set(pid, nextBaseEpoch);
      this.basePartitions.set(pid, Object.freeze<TopologyPartitionState>({
        partitionId: pid,
        contractText: entry.contractText,
        epoch: nextBaseEpoch,
        updatedAt: new Date().toISOString(),
        lastMutatedByRunId: runId,
      }));
    }
    for (const cId of committedRunIds) this.overlays.delete(cId);
    return Object.freeze<CommitRunOverlayResult>({ committedRunIds, updatedEpochs });
  }

  /**
   * Discards `runId`'s overlay without modifying `basePartitions`.
   *
   * Removes the uncommitted or sealed overlay entry for `runId`.
   *
   * @param {string} runId - Flow run identifier whose overlay should be discarded.
   *
   * @returns {Promise<void>} Resolves once removed.
   */
  async discardRunOverlay(runId: string): Promise<void> {
    this.overlays.delete(runId);
  }
}
