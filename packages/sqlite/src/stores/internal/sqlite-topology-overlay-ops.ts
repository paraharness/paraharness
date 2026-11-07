import type { TopologyPartitionState } from '@harness-dsl/core';
import type Database from 'better-sqlite3';
import type { SqliteOverlayStepMutationEntry } from './sqlite-overlay-step-mutation-entry.js';
import type { SqliteTopologyBaseRow } from './sqlite-topology-base-row.js';
import type { SqliteTopologyOverlayRow } from './sqlite-topology-overlay-row.js';
import {
  computeSyncedSqliteOverlayValues,
  resolveNextSqliteAcquireBase,
} from './sqlite-topology-overlay-sync.js';
import type { UpdateContractInOverlayParams } from './update-contract-in-overlay-params.js';

/**
 * Options for resetting uncommitted overlay mutations in `resetRunOverlay`.
 */
export interface ResetRunOverlayOptions {
  /** Rollback granularity (`'step'` for a single step execution or `'run'` for the entire run overlay). */
  readonly scope?: 'step' | 'run';
  /** Target `stepExecId` when `scope === 'step'`. */
  readonly stepExecId?: string;
}

/**
 * Loads the partition graph for `runId` (merging any uncommitted CoW overlay over `harness_topology_base`).
 *
 * Pins `base_contract_text_at_acquire` when `runId` first inspects each base partition (`SPEC.md` §3.3).
 *
 * @param {Database.Database} db      - Active SQLite database handle.
 * @param {string}            [runId] - Optional active flow run identifier.
 *
 * @returns {ReadonlyMap<string, TopologyPartitionState>} Partition state map keyed by `partitionId`.
 */
export function getPartitionsWithOverlay(
  db: Database.Database,
  runId?: string,
): ReadonlyMap<string, TopologyPartitionState> {
  const baseRows = db
    .prepare('SELECT * FROM harness_topology_base ORDER BY partition_id ASC')
    .all() as SqliteTopologyBaseRow[];
  const partitions = new Map<string, TopologyPartitionState>();
  for (const baseRow of baseRows) {
    partitions.set(
      baseRow.partition_id,
      Object.freeze<TopologyPartitionState>({
        partitionId: baseRow.partition_id,
        epoch: baseRow.epoch,
        contractText: baseRow.contract_text,
        updatedAt: baseRow.updated_at,
        lastMutatedByRunId: baseRow.last_mutated_by_run_id ?? undefined,
      }),
    );
  }
  if (runId === undefined) {
    return partitions;
  }
  const overlayRows = db
    .prepare('SELECT * FROM harness_topology_overlays WHERE run_id = ? ORDER BY partition_id ASC')
    .all(runId) as SqliteTopologyOverlayRow[];
  const overlayPartitions = new Set<string>();
  for (const ovRow of overlayRows) {
    overlayPartitions.add(ovRow.partition_id);
    if (ovRow.has_uncommitted_changes === 1 || ovRow.mutated_in_run === 1) {
      partitions.set(
        ovRow.partition_id,
        Object.freeze<TopologyPartitionState>({
          partitionId: ovRow.partition_id,
          epoch: ovRow.epoch,
          contractText: ovRow.contract_text,
          updatedAt: ovRow.updated_at,
          lastMutatedByRunId: ovRow.last_mutated_by_run_id ?? undefined,
        }),
      );
    }
  }
  const pinStmt = db.prepare(
    "INSERT OR IGNORE INTO harness_topology_overlays (run_id, partition_id, epoch, contract_text, base_contract_text_at_acquire, initial_base_contract_text, baseline_contract_text, baseline_epoch, baseline_last_mutated_by_run_id, mutated_in_run, has_uncommitted_changes, last_mutated_by_run_id, status, updated_at, absorbed_run_ids_json, step_mutations_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, 'ACTIVE', ?, '[]', '[]')",
  );
  for (const baseRow of baseRows) {
    if (!overlayPartitions.has(baseRow.partition_id)) {
      pinStmt.run(
        runId,
        baseRow.partition_id,
        baseRow.epoch,
        baseRow.contract_text,
        baseRow.contract_text,
        baseRow.contract_text,
        baseRow.contract_text,
        baseRow.epoch,
        baseRow.last_mutated_by_run_id,
        baseRow.last_mutated_by_run_id,
        baseRow.updated_at,
      );
    }
  }
  return partitions;
}

/**
 * Writes a contract update to `params.runId`'s isolated CoW overlay and increments `epoch` at most once per `(runId, partitionId)`.
 *
 * Tags the mutation with `params.stepExecId` so `resetOverlayByScope` can roll back individual steps (`SPEC.md` §3.3).
 *
 * @param {Database.Database}             db     - Active SQLite database handle.
 * @param {UpdateContractInOverlayParams} params - Contract update parameters.
 *
 * @returns {{ readonly newEpoch: number }} Updated overlay epoch for `params.partitionId`.
 */
export function updateContractInOverlay(
  db: Database.Database,
  params: UpdateContractInOverlayParams,
): { readonly newEpoch: number } {
  const baseRow = db
    .prepare('SELECT * FROM harness_topology_base WHERE partition_id = ?')
    .get(params.partitionId) as SqliteTopologyBaseRow | undefined;
  const ovRow = db
    .prepare('SELECT * FROM harness_topology_overlays WHERE run_id = ? AND partition_id = ?')
    .get(params.runId, params.partitionId) as SqliteTopologyOverlayRow | undefined;
  const now = new Date().toISOString();
  const baseEpoch = baseRow?.epoch ?? 0;
  const baseText = baseRow?.contract_text ?? '';
  const baseLastRun = baseRow?.last_mutated_by_run_id ?? null;
  const currentEpoch = ovRow !== undefined ? ovRow.epoch : baseEpoch;
  const alreadyMutated = ovRow !== undefined && ovRow.mutated_in_run === 1;
  const newEpoch = alreadyMutated ? currentEpoch : currentEpoch + 1;
  const history: SqliteOverlayStepMutationEntry[] =
    ovRow !== undefined
      ? (JSON.parse(ovRow.step_mutations_json) as SqliteOverlayStepMutationEntry[])
      : [];
  history.push({
    stepExecId: params.stepExecId ?? null,
    prevContractText: ovRow !== undefined ? ovRow.contract_text : baseText,
    prevEpoch: currentEpoch,
    prevMutatedInRun: ovRow !== undefined ? ovRow.mutated_in_run : 0,
    prevHasUncommittedChanges: ovRow !== undefined ? ovRow.has_uncommitted_changes : 0,
    prevLastMutatedByRunId: ovRow !== undefined ? ovRow.last_mutated_by_run_id : baseLastRun,
  });
  const acquireBase = resolveNextSqliteAcquireBase(ovRow, alreadyMutated, baseText);
  db.prepare(
    "INSERT OR REPLACE INTO harness_topology_overlays (run_id, partition_id, epoch, contract_text, base_contract_text_at_acquire, initial_base_contract_text, baseline_contract_text, baseline_epoch, baseline_last_mutated_by_run_id, mutated_in_run, has_uncommitted_changes, last_mutated_by_run_id, status, updated_at, absorbed_run_ids_json, step_mutations_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, 'ACTIVE', ?, ?, ?)",
  ).run(
    params.runId,
    params.partitionId,
    newEpoch,
    params.newContractText,
    acquireBase,
    ovRow !== undefined ? ovRow.initial_base_contract_text : baseText,
    ovRow !== undefined ? ovRow.baseline_contract_text : baseText,
    ovRow !== undefined ? ovRow.baseline_epoch : baseEpoch,
    ovRow !== undefined ? ovRow.baseline_last_mutated_by_run_id : baseLastRun,
    params.runId,
    now,
    ovRow !== undefined ? ovRow.absorbed_run_ids_json : '[]',
    JSON.stringify(history),
  );
  return Object.freeze({ newEpoch });
}

/**
 * Merges `ACTIVE` or `SEALED_UNMERGED` prerequisite overlays into `targetRunId`'s overlay (`SPEC.md` §3.3).
 *
 * Preserves `lastMutatedByRunId` and advances `targetRunId`'s `base_contract_text_at_acquire` to the prerequisite's `contract_text`.
 *
 * @param {Database.Database} db                 - Active SQLite database handle.
 * @param {string}            targetRunId        - Dependent run absorbing the prerequisite overlays.
 * @param {readonly string[]} prerequisiteRunIds - Prerequisite run IDs to merge from.
 *
 * @returns {void} Returns nothing once prerequisite overlays are absorbed.
 */
export function syncPrerequisiteOverlays(
  db: Database.Database,
  targetRunId: string,
  prerequisiteRunIds: readonly string[],
): void {
  const now = new Date().toISOString();
  const selectPrereqStmt = db.prepare(
    "SELECT * FROM harness_topology_overlays WHERE run_id = ? AND status IN ('ACTIVE', 'SEALED_UNMERGED') AND (mutated_in_run = 1 OR has_uncommitted_changes = 1)",
  );
  const selectTargetStmt = db.prepare(
    'SELECT * FROM harness_topology_overlays WHERE run_id = ? AND partition_id = ?',
  );
  const upsertStmt = db.prepare(
    'INSERT OR REPLACE INTO harness_topology_overlays (run_id, partition_id, epoch, contract_text, base_contract_text_at_acquire, initial_base_contract_text, baseline_contract_text, baseline_epoch, baseline_last_mutated_by_run_id, mutated_in_run, has_uncommitted_changes, last_mutated_by_run_id, status, updated_at, absorbed_run_ids_json, step_mutations_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)',
  );
  for (const prereqRunId of prerequisiteRunIds) {
    const prereqRows = selectPrereqStmt.all(prereqRunId) as SqliteTopologyOverlayRow[];
    for (const prereqRow of prereqRows) {
      const targetRow = selectTargetStmt.get(targetRunId, prereqRow.partition_id) as
        | SqliteTopologyOverlayRow
        | undefined;
      const synced = computeSyncedSqliteOverlayValues({
        targetRunId,
        prereqRunId,
        prereqRow,
        targetRow,
      });
      upsertStmt.run(
        targetRunId,
        prereqRow.partition_id,
        synced.nextEpoch,
        synced.mergedContractText,
        synced.nextAcquireBase,
        synced.initialBase,
        prereqRow.contract_text,
        synced.nextEpoch,
        prereqRow.last_mutated_by_run_id,
        synced.mutatedInRun,
        synced.nextLastMutatedBy,
        synced.status,
        now,
        synced.absorbedRunIdsJson,
        synced.stepMutationsJson,
      );
    }
  }
}

/**
 * Resets uncommitted overlay mutations for `runId` at either the `'step'` or `'run'` scope (`SPEC.md` §3.3).
 *
 * Reverts only `opts.stepExecId` mutations when `scope === 'step'`, or reverts the entire run overlay to its baseline when `scope === 'run'`.
 *
 * @param {Database.Database}      db     - Active SQLite database handle.
 * @param {string}                 runId  - Target flow run identifier.
 * @param {ResetRunOverlayOptions} [opts] - Reset scope options.
 *
 * @returns {void} Returns nothing once the overlay reset is committed.
 */
export function resetOverlayByScope(
  db: Database.Database,
  runId: string,
  opts?: ResetRunOverlayOptions,
): void {
  const rows = db
    .prepare('SELECT * FROM harness_topology_overlays WHERE run_id = ?')
    .all(runId) as SqliteTopologyOverlayRow[];
  const now = new Date().toISOString();
  if (opts?.scope === 'step' && opts.stepExecId !== undefined) {
    for (const row of rows) {
      const history = JSON.parse(row.step_mutations_json) as SqliteOverlayStepMutationEntry[];
      const firstMatchIdx = history.findIndex((entry) => entry.stepExecId === opts.stepExecId);
      const restoreTarget = firstMatchIdx >= 0 ? history[firstMatchIdx] : undefined;
      if (restoreTarget !== undefined) {
        const remaining = history.slice(0, firstMatchIdx);
        db.prepare(
          'UPDATE harness_topology_overlays SET contract_text = ?, epoch = ?, mutated_in_run = ?, has_uncommitted_changes = ?, last_mutated_by_run_id = ?, step_mutations_json = ?, updated_at = ? WHERE run_id = ? AND partition_id = ?',
        ).run(
          restoreTarget.prevContractText,
          restoreTarget.prevEpoch,
          restoreTarget.prevMutatedInRun,
          restoreTarget.prevHasUncommittedChanges,
          restoreTarget.prevLastMutatedByRunId,
          JSON.stringify(remaining),
          now,
          runId,
          row.partition_id,
        );
      }
    }
    return;
  }
  for (const row of rows) {
    const hasSyncedBaseline =
      row.baseline_contract_text !== row.initial_base_contract_text ||
      row.absorbed_run_ids_json !== '[]';
    db.prepare(
      "UPDATE harness_topology_overlays SET contract_text = ?, epoch = ?, mutated_in_run = 0, has_uncommitted_changes = ?, last_mutated_by_run_id = ?, step_mutations_json = '[]', updated_at = ? WHERE run_id = ? AND partition_id = ?",
    ).run(
      row.baseline_contract_text,
      row.baseline_epoch,
      hasSyncedBaseline ? 1 : 0,
      row.baseline_last_mutated_by_run_id,
      now,
      runId,
      row.partition_id,
    );
  }
}
