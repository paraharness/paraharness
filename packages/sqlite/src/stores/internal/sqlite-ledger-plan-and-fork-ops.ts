import type { MutateLanePlanRequest, SuspendedForkRecord } from '@harness-dsl/core';
import type Database from 'better-sqlite3';
import type { SqliteSuspendedForkRow } from './sqlite-suspended-fork-row.js';
import { buildChainedLaneDependencies } from './validate-lane-dag.js';

/**
 * Atomically chains spawned prerequisite items and validates DAG acyclicity and `maxPrerequisiteDepth`.
 *
 * Enforces linear prerequisite stacking ($T_{\text{prevTip}} \leftarrow T_1 \leftarrow \dots \leftarrow T_k \leftarrow T_{\text{parent}}$)
 * and rejects cycles or depth violations before mutating `harness_lane_items` and `harness_runs`.
 *
 * @param {Database.Database}     db  - Active SQLite database handle.
 * @param {MutateLanePlanRequest} req - Lane plan mutation request.
 *
 * @returns {void} Returns nothing once the DAG mutation is committed.
 */
export function mutateLanePlanInSqlite(db: Database.Database, req: MutateLanePlanRequest): void {
  const existingRows = db
    .prepare('SELECT item_key, depends_on_json, latest_spawned_tip_key FROM harness_lane_items WHERE lane_id = ?')
    .all(req.laneId) as ReadonlyArray<{ readonly item_key: string; readonly depends_on_json: string; readonly latest_spawned_tip_key: string | null }>;
  const { depsByItem, rollingTip, nextParentDeps } = buildChainedLaneDependencies(existingRows, req);
  const now = new Date().toISOString();
  for (const spawnedTask of req.spawnedItems ?? []) {
    const taskDepsJson = JSON.stringify(depsByItem.get(spawnedTask.itemKey) ?? []);
    db.prepare('INSERT OR REPLACE INTO harness_lane_items (lane_id, item_key, input_json, depends_on_json, priority, latest_spawned_tip_key) VALUES (?, ?, ?, ?, ?, NULL)')
      .run(req.laneId, spawnedTask.itemKey, spawnedTask.inputJson, taskDepsJson, spawnedTask.priority);
    db.prepare("INSERT OR IGNORE INTO harness_runs (run_id, lane_id, item_key, status, current_step_id, input_json, depends_on_json, priority, updated_at) VALUES (?, ?, ?, 'QUEUED', NULL, ?, ?, ?, ?)")
      .run(spawnedTask.itemKey, req.laneId, spawnedTask.itemKey, spawnedTask.inputJson, taskDepsJson, spawnedTask.priority, now);
    db.prepare('UPDATE harness_runs SET depends_on_json = ?, updated_at = ? WHERE lane_id = ? AND item_key = ?')
      .run(taskDepsJson, now, req.laneId, spawnedTask.itemKey);
  }
  const parentDepsJson = JSON.stringify(nextParentDeps);
  db.prepare("INSERT OR REPLACE INTO harness_lane_items (lane_id, item_key, input_json, depends_on_json, priority, latest_spawned_tip_key) VALUES (?, ?, COALESCE((SELECT input_json FROM harness_runs WHERE run_id = ?), '{}'), ?, 'normal', ?)")
    .run(req.laneId, req.parentItemKey, req.parentRunId, parentDepsJson, rollingTip ?? null);
  db.prepare('UPDATE harness_runs SET depends_on_json = ?, updated_at = ? WHERE run_id = ?')
    .run(parentDepsJson, now, req.parentRunId);
}

/**
 * Persists a `SuspendedForkRecord` in `harness_suspended_forks`.
 *
 * Stores the monotonic `${forkId}#${suspensionEpoch}` identifier and full continuation stack.
 *
 * @param {Database.Database}   db     - Active SQLite database handle.
 * @param {SuspendedForkRecord} record - Suspended fork snapshot to persist.
 *
 * @returns {void} Returns nothing once the suspension record is saved.
 */
export function recordForkSuspensionInSqlite(
  db: Database.Database,
  record: SuspendedForkRecord,
): void {
  db.prepare(
    'INSERT OR REPLACE INTO harness_suspended_forks (suspended_fork_id, fork_id, suspension_epoch, run_id, parent_step_exec_id, record_json, resolution_status) VALUES (?, ?, ?, ?, ?, ?, NULL)',
  ).run(record.suspendedForkId, record.forkId, record.suspensionEpoch, record.runId, record.parentStepExecId, JSON.stringify(record));
}

/**
 * Queries unresolved (`resolution_status IS NULL`) suspended forks for `runId`.
 *
 * Supports optional filtering by `forkIds` (matching `forkId` or `suspendedForkId`) and `parentStepExecId`.
 *
 * @param {Database.Database}                                                            db     - Active SQLite database handle.
 * @param {string}                                                                       runId  - Enclosing flow run identifier.
 * @param {{ readonly forkIds?: readonly string[]; readonly parentStepExecId?: string }} [opts] - Optional filter criteria.
 *
 * @returns {readonly SuspendedForkRecord[]} Matching unresolved suspended fork records.
 */
export function getSuspendedForksFromSqlite(
  db: Database.Database,
  runId: string,
  opts?: { readonly forkIds?: readonly string[]; readonly parentStepExecId?: string },
): readonly SuspendedForkRecord[] {
  const rows = db.prepare('SELECT * FROM harness_suspended_forks WHERE run_id = ? AND resolution_status IS NULL ORDER BY suspension_epoch ASC, suspended_fork_id ASC').all(runId) as SqliteSuspendedForkRow[];
  const forkIdSet = opts?.forkIds !== undefined ? new Set<string>(opts.forkIds) : undefined;
  const records: SuspendedForkRecord[] = [];
  for (const row of rows) {
    if (opts?.parentStepExecId !== undefined && row.parent_step_exec_id !== opts.parentStepExecId) continue;
    if (forkIdSet !== undefined && !forkIdSet.has(row.fork_id) && !forkIdSet.has(row.suspended_fork_id)) continue;
    records.push(Object.freeze(JSON.parse(row.record_json) as SuspendedForkRecord));
  }
  return Object.freeze(records);
}

/**
 * Marks `suspendedForkId` and any earlier unresolved epochs `${forkId}#1 .. ${forkId}#${epoch}` as resolved.
 *
 * Guarantees recursive epoch resolution safety (`SPEC.md` §3.7.2) so prior epochs never remain open.
 *
 * @param {Database.Database}     db              - Active SQLite database handle.
 * @param {string}                suspendedForkId - Monotonic `${forkId}#${suspensionEpoch}` identifier.
 * @param {'RESUMED' | 'ABORTED'} status          - Target resolution status.
 *
 * @returns {void} Returns nothing once the epoch resolution is committed.
 */
export function resolveSuspendedForkInSqlite(
  db: Database.Database,
  suspendedForkId: string,
  status: 'RESUMED' | 'ABORTED',
): void {
  const target = db.prepare('SELECT run_id, fork_id, suspension_epoch FROM harness_suspended_forks WHERE suspended_fork_id = ?').get(suspendedForkId) as { readonly run_id: string; readonly fork_id: string; readonly suspension_epoch: number } | undefined;
  if (target !== undefined) {
    db.prepare('UPDATE harness_suspended_forks SET resolution_status = ? WHERE run_id = ? AND fork_id = ? AND suspension_epoch <= ? AND resolution_status IS NULL')
      .run(status, target.run_id, target.fork_id, target.suspension_epoch);
    return;
  }
  const hashIdx = suspendedForkId.lastIndexOf('#');
  if (hashIdx > 0) {
    const forkId = suspendedForkId.slice(0, hashIdx);
    const epoch = Number.parseInt(suspendedForkId.slice(hashIdx + 1), 10);
    if (Number.isInteger(epoch)) {
      db.prepare('UPDATE harness_suspended_forks SET resolution_status = ? WHERE fork_id = ? AND suspension_epoch <= ? AND resolution_status IS NULL')
        .run(status, forkId, epoch);
    }
  }
}
