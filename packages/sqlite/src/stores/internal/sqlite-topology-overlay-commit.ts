import type Database from 'better-sqlite3';
import type { SqliteTopologyBaseRow } from './sqlite-topology-base-row.js';
import type { SqliteTopologyOverlayRow } from './sqlite-topology-overlay-row.js';
import { threeWayMergeContract } from './three-way-merge-contract.js';

/**
 * Collects all run IDs (`runId` plus any absorbed `SEALED_UNMERGED` prerequisite run IDs)
 * whose overlays are being committed together in a single `commitRunOverlay` transaction.
 *
 * @param {Database.Database}                 db          - Active SQLite database handle.
 * @param {string}                            runId       - Primary committing flow run identifier.
 * @param {readonly SqliteTopologyOverlayRow[]} overlayRows - Modified overlay rows for `runId`.
 *
 * @returns {readonly string[]} Frozen list of committed run identifiers.
 */
export function collectCommittedSqliteRunIds(
  db: Database.Database,
  runId: string,
  overlayRows: readonly SqliteTopologyOverlayRow[],
): readonly string[] {
  const committedSet = new Set<string>();
  const selectSealedStmt = db.prepare(
    "SELECT 1 AS found FROM harness_topology_overlays WHERE run_id = ? AND status = 'SEALED_UNMERGED' LIMIT 1",
  );
  for (const ovRow of overlayRows) {
    const absorbedIds = JSON.parse(ovRow.absorbed_run_ids_json) as string[];
    for (const absorbedId of absorbedIds) {
      if (selectSealedStmt.get(absorbedId) !== undefined) {
        committedSet.add(absorbedId);
      }
    }
  }
  committedSet.add(runId);
  return Object.freeze(Array.from(committedSet));
}

/**
 * Merges a single `SqliteTopologyOverlayRow` into `harness_topology_base` via 3-way merge
 * and allocates a monotonically increasing base epoch (`currentBase.epoch + 1`).
 *
 * @param {Database.Database}        db    - Active SQLite database handle.
 * @param {SqliteTopologyOverlayRow} ovRow - Overlay partition row to merge and commit.
 * @param {string}                   runId - Committing flow run identifier.
 *
 * @returns {number} Newly allocated canonical base epoch for `ovRow.partition_id`.
 */
export function mergeAndCommitSqliteOverlayRow(
  db: Database.Database,
  ovRow: SqliteTopologyOverlayRow,
  runId: string,
): number {
  const baseRow = db
    .prepare('SELECT * FROM harness_topology_base WHERE partition_id = ?')
    .get(ovRow.partition_id) as SqliteTopologyBaseRow | undefined;
  const currentBaseEpoch = baseRow?.epoch ?? 0;
  const currentBaseText = baseRow?.contract_text ?? '';
  const acquireBase =
    currentBaseText === ovRow.initial_base_contract_text
      ? ovRow.initial_base_contract_text
      : ovRow.base_contract_text_at_acquire;
  const mergedText = threeWayMergeContract(acquireBase, currentBaseText, ovRow.contract_text);
  const newBaseEpoch = currentBaseEpoch + 1;
  const now = new Date().toISOString();
  db.prepare(
    'INSERT OR REPLACE INTO harness_topology_base (partition_id, epoch, contract_text, updated_at, last_mutated_by_run_id) VALUES (?, ?, ?, ?, ?)',
  ).run(ovRow.partition_id, newBaseEpoch, mergedText, now, ovRow.last_mutated_by_run_id ?? runId);
  return newBaseEpoch;
}
