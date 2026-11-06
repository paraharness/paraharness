import type { CommitRunOverlayResult } from '@harness-dsl/core';
import type Database from 'better-sqlite3';
import type { SqliteTopologyBaseRow } from './sqlite-topology-base-row.js';
import type { SqliteTopologyOverlayRow } from './sqlite-topology-overlay-row.js';
import { threeWayMergeContract } from './three-way-merge-contract.js';

/**
 * Transitions `runId`'s overlay rows to `status = 'SEALED_UNMERGED'` (`SPEC.md` §3.3).
 *
 * Allows dependent stacked runs to absorb the sealed overlay via `syncRunOverlays` without polluting the base store.
 *
 * @param {Database.Database} db    - Active SQLite database handle.
 * @param {string}            runId - Completed flow run identifier.
 *
 * @returns {void} Returns nothing once the overlay is sealed.
 */
export function sealOverlayForRun(db: Database.Database, runId: string): void {
  db.prepare("UPDATE harness_topology_overlays SET status = 'SEALED_UNMERGED', updated_at = ? WHERE run_id = ?")
    .run(new Date().toISOString(), runId);
}

/**
 * Atomically commits `runId`'s overlay (and any absorbed `SEALED_UNMERGED` prerequisite overlays)
 * into `harness_topology_base` using a 3-way contract text merge (`SPEC.md` §3.3).
 *
 * Allocates `base.epoch = currentBase.epoch + 1` monotonically and returns `{ committedRunIds, updatedEpochs }`.
 *
 * @param {Database.Database} db    - Active SQLite database handle.
 * @param {string}            runId - Flow run identifier whose overlay is committing.
 *
 * @returns {CommitRunOverlayResult} Committed run identifiers and newly allocated base epochs.
 */
export function commitOverlayThreeWayMerge(
  db: Database.Database,
  runId: string,
): CommitRunOverlayResult {
  const overlayRows = db.prepare('SELECT * FROM harness_topology_overlays WHERE run_id = ? AND (mutated_in_run = 1 OR has_uncommitted_changes = 1) ORDER BY partition_id ASC').all(runId) as SqliteTopologyOverlayRow[];
  const committedSet = new Set<string>();
  const selectSealedStmt = db.prepare("SELECT 1 AS found FROM harness_topology_overlays WHERE run_id = ? AND status = 'SEALED_UNMERGED' LIMIT 1");
  for (const ovRow of overlayRows) {
    for (const absorbedId of JSON.parse(ovRow.absorbed_run_ids_json) as string[]) {
      if (selectSealedStmt.get(absorbedId) !== undefined) committedSet.add(absorbedId);
    }
  }
  committedSet.add(runId);
  const committedRunIds = Array.from(committedSet);
  const updatedEpochs = new Map<string, number>();
  const now = new Date().toISOString();
  for (const ovRow of overlayRows) {
    const baseRow = db.prepare('SELECT * FROM harness_topology_base WHERE partition_id = ?').get(ovRow.partition_id) as SqliteTopologyBaseRow | undefined;
    const currentBaseEpoch = baseRow?.epoch ?? 0;
    const currentBaseText = baseRow?.contract_text ?? '';
    const acquireBase = currentBaseText === ovRow.initial_base_contract_text ? ovRow.initial_base_contract_text : ovRow.base_contract_text_at_acquire;
    const mergedText = threeWayMergeContract(acquireBase, currentBaseText, ovRow.contract_text);
    const newBaseEpoch = currentBaseEpoch + 1;
    db.prepare('INSERT OR REPLACE INTO harness_topology_base (partition_id, epoch, contract_text, updated_at, last_mutated_by_run_id) VALUES (?, ?, ?, ?, ?)')
      .run(ovRow.partition_id, newBaseEpoch, mergedText, now, ovRow.last_mutated_by_run_id ?? runId);
    updatedEpochs.set(ovRow.partition_id, newBaseEpoch);
  }
  const deleteStmt = db.prepare('DELETE FROM harness_topology_overlays WHERE run_id = ?');
  for (const committedId of committedRunIds) deleteStmt.run(committedId);
  return Object.freeze<CommitRunOverlayResult>({ committedRunIds: Object.freeze(committedRunIds), updatedEpochs });
}

/**
 * Discards all uncommitted or sealed overlay rows for `runId` without modifying `harness_topology_base`.
 *
 * Used when a run fails, triggers `discardOnSignal`, or exceeds `maxSealedAgeHours`.
 *
 * @param {Database.Database} db    - Active SQLite database handle.
 * @param {string}            runId - Flow run identifier whose overlay should be discarded.
 *
 * @returns {void} Returns nothing once the overlay is removed.
 */
export function discardOverlayForRun(db: Database.Database, runId: string): void {
  db.prepare('DELETE FROM harness_topology_overlays WHERE run_id = ?').run(runId);
}
