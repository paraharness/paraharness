import type { CommitRunOverlayResult } from '@harness-dsl/core';
import type Database from 'better-sqlite3';
import {
  collectCommittedSqliteRunIds,
  mergeAndCommitSqliteOverlayRow,
} from './sqlite-topology-overlay-commit.js';
import type { SqliteTopologyOverlayRow } from './sqlite-topology-overlay-row.js';

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
  db.prepare(
    "UPDATE harness_topology_overlays SET status = 'SEALED_UNMERGED', updated_at = ? WHERE run_id = ?",
  ).run(new Date().toISOString(), runId);
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
  const overlayRows = db
    .prepare(
      'SELECT * FROM harness_topology_overlays WHERE run_id = ? AND (mutated_in_run = 1 OR has_uncommitted_changes = 1) ORDER BY partition_id ASC',
    )
    .all(runId) as SqliteTopologyOverlayRow[];
  const committedRunIds = collectCommittedSqliteRunIds(db, runId, overlayRows);
  const updatedEpochs = new Map<string, number>();
  for (const ovRow of overlayRows) {
    const newBaseEpoch = mergeAndCommitSqliteOverlayRow(db, ovRow, runId);
    updatedEpochs.set(ovRow.partition_id, newBaseEpoch);
  }
  const deleteStmt = db.prepare('DELETE FROM harness_topology_overlays WHERE run_id = ?');
  for (const committedId of committedRunIds) {
    deleteStmt.run(committedId);
  }
  return Object.freeze<CommitRunOverlayResult>({
    committedRunIds,
    updatedEpochs,
  });
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
