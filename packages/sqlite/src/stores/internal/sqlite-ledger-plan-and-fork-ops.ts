import type { MutateLanePlanRequest, SuspendedForkRecord } from '@metaharness/core';
import type Database from 'better-sqlite3';
import {
  matchesSuspendedForkFilter,
  parseSuspendedForkCoordinates,
} from './sqlite-ledger-fork-operations.js';
import {
  upsertParentLaneItemInSqlite,
  upsertSpawnedLaneItemsInSqlite,
} from './sqlite-ledger-plan-operations.js';
import type { SqliteSuspendedForkRow } from './sqlite-suspended-fork-row.js';
import { buildChainedLaneDependencies } from './validate-lane-dag.js';

/**
 * Optional filter criteria for querying unresolved suspended forks in `getSuspendedForks`.
 */
export interface GetSuspendedForksOptions {
  /** Optional list of logical `forkId` or monotonic `suspendedForkId` values to match. */
  readonly forkIds?: readonly string[];
  /** Optional parent `stepExecId` that spawned the suspended fork. */
  readonly parentStepExecId?: string;
}

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
    .prepare(
      'SELECT item_key, depends_on_json, latest_spawned_tip_key FROM harness_lane_items WHERE lane_id = ?',
    )
    .all(req.laneId) as ReadonlyArray<{
    readonly item_key: string;
    readonly depends_on_json: string;
    readonly latest_spawned_tip_key: string | null;
  }>;
  const { depsByItem, rollingTip, nextParentDeps } = buildChainedLaneDependencies(
    existingRows,
    req,
  );
  upsertSpawnedLaneItemsInSqlite(db, req, depsByItem);
  upsertParentLaneItemInSqlite({
    db,
    req,
    nextParentDeps,
    rollingTip,
    now: new Date().toISOString(),
  });
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
  ).run(
    record.suspendedForkId,
    record.forkId,
    record.suspensionEpoch,
    record.runId,
    record.parentStepExecId,
    JSON.stringify(record),
  );
}

/**
 * Queries unresolved (`resolution_status IS NULL`) suspended forks for `runId`.
 *
 * Supports optional filtering by `forkIds` (matching `forkId` or `suspendedForkId`) and `parentStepExecId`.
 *
 * @param {Database.Database}        db     - Active SQLite database handle.
 * @param {string}                   runId  - Enclosing flow run identifier.
 * @param {GetSuspendedForksOptions} [opts] - Optional filter criteria.
 *
 * @returns {readonly SuspendedForkRecord[]} Matching unresolved suspended fork records.
 */
export function getSuspendedForksFromSqlite(
  db: Database.Database,
  runId: string,
  opts?: GetSuspendedForksOptions,
): readonly SuspendedForkRecord[] {
  const rows = db
    .prepare(
      'SELECT * FROM harness_suspended_forks WHERE run_id = ? AND resolution_status IS NULL ORDER BY suspension_epoch ASC, suspended_fork_id ASC',
    )
    .all(runId) as SqliteSuspendedForkRow[];
  const forkIdSet = opts?.forkIds !== undefined ? new Set<string>(opts.forkIds) : undefined;
  const records: SuspendedForkRecord[] = [];
  for (const row of rows) {
    if (matchesSuspendedForkFilter(row, forkIdSet, opts?.parentStepExecId)) {
      records.push(Object.freeze(JSON.parse(row.record_json) as SuspendedForkRecord));
    }
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
  const target = db
    .prepare(
      'SELECT run_id, fork_id, suspension_epoch FROM harness_suspended_forks WHERE suspended_fork_id = ?',
    )
    .get(suspendedForkId) as
    | {
        readonly run_id: string;
        readonly fork_id: string;
        readonly suspension_epoch: number;
      }
    | undefined;
  if (target !== undefined) {
    db.prepare(
      'UPDATE harness_suspended_forks SET resolution_status = ? WHERE run_id = ? AND fork_id = ? AND suspension_epoch <= ? AND resolution_status IS NULL',
    ).run(status, target.run_id, target.fork_id, target.suspension_epoch);
    return;
  }
  const parsed = parseSuspendedForkCoordinates(suspendedForkId);
  if (parsed !== undefined) {
    db.prepare(
      'UPDATE harness_suspended_forks SET resolution_status = ? WHERE fork_id = ? AND suspension_epoch <= ? AND resolution_status IS NULL',
    ).run(status, parsed.forkId, parsed.epoch);
  }
}
