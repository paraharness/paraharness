import type Database from 'better-sqlite3';

/**
 * Prunes `raw_wire_frame` BLOBs for a terminal `runId` while preserving canonical audit headers.
 *
 * Verifies that `runId` is not in an active non-terminal state (`'QUEUED' | 'RUNNING' | 'WAITING' | 'SUSPENDED'`)
 * and scopes the update strictly to `runId` so active runs sharing the same `itemKey` are never pruned.
 *
 * @param {Database.Database} db    - Active SQLite database handle.
 * @param {string}            runId - Terminal flow run identifier to compact.
 *
 * @returns {void} Returns nothing once raw wire frames for `runId` are pruned.
 */
export function compactRunFramesInSqlite(db: Database.Database, runId: string): void {
  const runRow = db
    .prepare('SELECT status, terminal_state FROM harness_runs WHERE run_id = ?')
    .get(runId) as { readonly status: string; readonly terminal_state: string | null } | undefined;
  const isNonTerminal =
    runRow !== undefined &&
    runRow.terminal_state === null &&
    (runRow.status === 'QUEUED' ||
      runRow.status === 'RUNNING' ||
      runRow.status === 'WAITING' ||
      runRow.status === 'SUSPENDED');
  if (isNonTerminal) {
    return;
  }
  const emptyBlob = Buffer.alloc(0);
  db.prepare(
    'UPDATE harness_wire_frames SET raw_wire_frame = ?, is_compacted = 1 WHERE run_id = ?',
  ).run(emptyBlob, runId);
  db.prepare('UPDATE harness_runs SET compacted = 1, updated_at = ? WHERE run_id = ?').run(
    new Date().toISOString(),
    runId,
  );
}
