import type { MutateLanePlanRequest, SuspendedForkRecord } from '@metaharness/core';
import type { PostgresQueryClient } from '../../ddl/postgres-query-client.js';
import type { PgSuspendedForkRow } from './pg-suspended-fork-row.js';
import {
  matchesPgSuspendedForkFilter,
  parsePgSuspendedForkCoordinates,
} from './postgres-ledger-fork-operations.js';
import {
  upsertParentLaneItemInPg,
  upsertSpawnedLaneItemsInPg,
} from './postgres-ledger-plan-operations.js';
import { buildChainedLaneDependencies } from './validate-lane-dag.js';

/**
 * Optional filter criteria for querying unresolved suspended forks in `getSuspendedForks`.
 */
export interface GetPgSuspendedForksOptions {
  /** Optional list of logical `forkId` or monotonic `suspendedForkId` values to match. */
  readonly forkIds?: readonly string[];
  /** Optional parent `stepExecId` that spawned the suspended fork. */
  readonly parentStepExecId?: string;
}

/**
 * Atomically chains spawned prerequisite items and validates DAG acyclicity and `maxPrerequisiteDepth` in PostgreSQL.
 *
 * Enforces linear prerequisite stacking ($T_{\text{prevTip}} \leftarrow T_1 \leftarrow \dots \leftarrow T_k \leftarrow T_{\text{parent}}$)
 * and rejects cycles or chains exceeding `req.maxPrerequisiteDepth` (`SPEC.md` §3.7.2).
 *
 * @param {PostgresQueryClient}   client - Active PostgreSQL query client.
 * @param {MutateLanePlanRequest} req    - Lane plan mutation request.
 *
 * @returns {Promise<void>} Resolves once the lane DAG mutation is committed.
 */
export async function mutateLanePlanInPg(
  client: PostgresQueryClient,
  req: MutateLanePlanRequest,
): Promise<void> {
  const existingQueryResult = await client.query<{
    readonly item_key: string;
    readonly depends_on_json: string;
    readonly latest_spawned_tip_key: string | null;
  }>(
    'SELECT item_key, depends_on_json, latest_spawned_tip_key FROM harness_lane_items WHERE lane_id = $1',
    [req.laneId],
  );
  const { depsByItem, rollingTip, nextParentDeps } = buildChainedLaneDependencies(
    existingQueryResult.rows,
    req,
  );
  await upsertSpawnedLaneItemsInPg(client, req, depsByItem);
  await upsertParentLaneItemInPg({
    client,
    req,
    nextParentDeps,
    rollingTip,
  });
}

/**
 * Persists a `SuspendedForkRecord` keyed by monotonic `suspendedForkId` (`${forkId}#${suspensionEpoch}`) in PostgreSQL.
 *
 * Stores the serialized fork snapshot with initial status `'SUSPENDED'`.
 *
 * @param {PostgresQueryClient} client - Active PostgreSQL query client.
 * @param {SuspendedForkRecord} record - Suspended fork snapshot to persist.
 *
 * @returns {Promise<void>} Resolves once the suspension record is persisted.
 */
export async function recordForkSuspensionInPg(
  client: PostgresQueryClient,
  record: SuspendedForkRecord,
): Promise<void> {
  await client.query(
    "INSERT INTO harness_suspended_forks (suspended_fork_id, fork_id, suspension_epoch, run_id, parent_step_exec_id, status, record_json) VALUES ($1, $2, $3, $4, $5, 'SUSPENDED', $6) ON CONFLICT (suspended_fork_id) DO UPDATE SET status = 'SUSPENDED', record_json = EXCLUDED.record_json",
    [
      record.suspendedForkId,
      record.forkId,
      record.suspensionEpoch,
      record.runId,
      record.parentStepExecId,
      JSON.stringify(record),
    ],
  );
}

/**
 * Queries unresolved (`status = 'SUSPENDED'`) fork records for `runId` from PostgreSQL.
 *
 * Filters optionally by `opts.parentStepExecId` and `opts.forkIds` (matching either `forkId` or `suspendedForkId`).
 *
 * @param {PostgresQueryClient}        client - Active PostgreSQL query client.
 * @param {string}                     runId  - Enclosing flow run identifier.
 * @param {GetPgSuspendedForksOptions} [opts] - Optional filter criteria.
 *
 * @returns {Promise<readonly SuspendedForkRecord[]>} Unresolved suspended fork records ordered by `suspensionEpoch`.
 */
export async function getSuspendedForksFromPg(
  client: PostgresQueryClient,
  runId: string,
  opts?: GetPgSuspendedForksOptions,
): Promise<readonly SuspendedForkRecord[]> {
  const queryResult = await client.query<PgSuspendedForkRow>(
    "SELECT * FROM harness_suspended_forks WHERE run_id = $1 AND status = 'SUSPENDED' ORDER BY suspension_epoch ASC",
    [runId],
  );
  const forkFilter = opts?.forkIds !== undefined ? new Set<string>(opts.forkIds) : undefined;
  const results: SuspendedForkRecord[] = [];
  for (const row of queryResult.rows) {
    if (matchesPgSuspendedForkFilter(row, forkFilter, opts?.parentStepExecId)) {
      results.push(Object.freeze(JSON.parse(row.record_json) as SuspendedForkRecord));
    }
  }
  return Object.freeze(results);
}

/**
 * Marks `suspendedForkId` and any earlier unresolved epochs `${forkId}#1 .. ${forkId}#${epoch}` as resolved in PostgreSQL.
 *
 * Ensures recursive suspension chains settle all preceding epochs for the same `(runId, forkId)` (`SPEC.md` §3.7.2).
 *
 * @param {PostgresQueryClient}   client          - Active PostgreSQL query client.
 * @param {string}                suspendedForkId - Monotonic `${forkId}#${suspensionEpoch}` identifier.
 * @param {'RESUMED' | 'ABORTED'} status          - Target resolution status.
 *
 * @returns {Promise<void>} Resolves once the status transition is committed.
 */
export async function resolveSuspendedForkInPg(
  client: PostgresQueryClient,
  suspendedForkId: string,
  status: 'RESUMED' | 'ABORTED',
): Promise<void> {
  const queryResult = await client.query<
    Pick<PgSuspendedForkRow, 'run_id' | 'fork_id' | 'suspension_epoch'>
  >('SELECT run_id, fork_id, suspension_epoch FROM harness_suspended_forks WHERE suspended_fork_id = $1', [
    suspendedForkId,
  ]);
  const target = queryResult.rows[0];
  if (target !== undefined) {
    await client.query(
      "UPDATE harness_suspended_forks SET status = $1 WHERE run_id = $2 AND fork_id = $3 AND suspension_epoch <= $4 AND status = 'SUSPENDED'",
      [status, target.run_id, target.fork_id, target.suspension_epoch],
    );
    return;
  }
  const parsed = parsePgSuspendedForkCoordinates(suspendedForkId);
  if (parsed !== undefined) {
    await client.query(
      "UPDATE harness_suspended_forks SET status = $1 WHERE fork_id = $2 AND suspension_epoch <= $3 AND status = 'SUSPENDED'",
      [status, parsed.forkId, parsed.epoch],
    );
  }
}
