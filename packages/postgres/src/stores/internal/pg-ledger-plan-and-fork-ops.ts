import type { MutateLanePlanRequest, SuspendedForkRecord } from '@harness-dsl/core';
import type { PostgresQueryClient } from '../../ddl/postgres-query-client.js';
import type { PgSuspendedForkRow } from './pg-suspended-fork-row.js';
import { buildChainedLaneDependencies } from './validate-lane-dag.js';

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
  const existingQueryResult = await client.query<{ readonly item_key: string; readonly depends_on_json: string; readonly latest_spawned_tip_key: string | null }>(
    'SELECT item_key, depends_on_json, latest_spawned_tip_key FROM harness_lane_items WHERE lane_id = $1',
    [req.laneId],
  );
  const { depsByItem, rollingTip, nextParentDeps } = buildChainedLaneDependencies(existingQueryResult.rows, req);
  const now = new Date().toISOString();
  for (const spawnedTask of req.spawnedItems ?? []) {
    const taskDeps = depsByItem.get(spawnedTask.itemKey) ?? [];
    await client.query(
      'INSERT INTO harness_lane_items (lane_id, item_key, input_json, priority, depends_on_json, latest_spawned_tip_key) VALUES ($1, $2, $3, $4, $5, NULL) ON CONFLICT (lane_id, item_key) DO UPDATE SET input_json = EXCLUDED.input_json, priority = EXCLUDED.priority, depends_on_json = EXCLUDED.depends_on_json',
      [req.laneId, spawnedTask.itemKey, spawnedTask.inputJson, spawnedTask.priority, JSON.stringify(taskDeps)],
    );
    const queuedRunId = `queued:${req.laneId}:${spawnedTask.itemKey}`;
    await client.query(
      "INSERT INTO harness_runs (run_id, lane_id, item_key, status, current_step_id, input_json, cost_usd, created_at, updated_at) VALUES ($1, $2, $3, 'QUEUED', NULL, $4, 0, $5, $5) ON CONFLICT (run_id) DO NOTHING",
      [queuedRunId, req.laneId, spawnedTask.itemKey, spawnedTask.inputJson, now],
    );
  }
  for (const addedDep of req.addedDependencies ?? []) {
    await client.query(
      "INSERT INTO harness_lane_items (lane_id, item_key, input_json, priority, depends_on_json, latest_spawned_tip_key) VALUES ($1, $2, '{}', 'normal', '[]', NULL) ON CONFLICT (lane_id, item_key) DO NOTHING",
      [req.laneId, addedDep],
    );
  }
  const parentQueryResult = await client.query<{ readonly input_json: string; readonly priority: string }>(
    'SELECT input_json, priority FROM harness_lane_items WHERE lane_id = $1 AND item_key = $2',
    [req.laneId, req.parentItemKey],
  );
  const parentExists = parentQueryResult.rows[0];
  await client.query(
    'INSERT INTO harness_lane_items (lane_id, item_key, input_json, priority, depends_on_json, latest_spawned_tip_key) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (lane_id, item_key) DO UPDATE SET depends_on_json = EXCLUDED.depends_on_json, latest_spawned_tip_key = EXCLUDED.latest_spawned_tip_key',
    [req.laneId, req.parentItemKey, parentExists?.input_json ?? '{}', parentExists?.priority ?? 'normal', JSON.stringify(nextParentDeps), rollingTip ?? null],
  );
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
    [record.suspendedForkId, record.forkId, record.suspensionEpoch, record.runId, record.parentStepExecId, JSON.stringify(record)],
  );
}

/**
 * Queries unresolved (`status = 'SUSPENDED'`) fork records for `runId` from PostgreSQL.
 *
 * Filters optionally by `opts.parentStepExecId` and `opts.forkIds` (matching either `forkId` or `suspendedForkId`).
 *
 * @param {PostgresQueryClient}                                                          client - Active PostgreSQL query client.
 * @param {string}                                                                       runId  - Enclosing flow run identifier.
 * @param {{ readonly forkIds?: readonly string[]; readonly parentStepExecId?: string }} [opts] - Optional filter criteria.
 *
 * @returns {Promise<readonly SuspendedForkRecord[]>} Unresolved suspended fork records ordered by `suspensionEpoch`.
 */
export async function getSuspendedForksFromPg(
  client: PostgresQueryClient,
  runId: string,
  opts?: { readonly forkIds?: readonly string[]; readonly parentStepExecId?: string },
): Promise<readonly SuspendedForkRecord[]> {
  const queryResult = await client.query<PgSuspendedForkRow>(
    "SELECT * FROM harness_suspended_forks WHERE run_id = $1 AND status = 'SUSPENDED' ORDER BY suspension_epoch ASC",
    [runId],
  );
  const forkFilter = opts?.forkIds !== undefined ? new Set<string>(opts.forkIds) : undefined;
  const results: SuspendedForkRecord[] = [];
  for (const row of queryResult.rows) {
    if (opts?.parentStepExecId !== undefined && row.parent_step_exec_id !== opts.parentStepExecId) continue;
    if (forkFilter !== undefined && !forkFilter.has(row.fork_id) && !forkFilter.has(row.suspended_fork_id)) continue;
    results.push(Object.freeze(JSON.parse(row.record_json) as SuspendedForkRecord));
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
  const queryResult = await client.query<Pick<PgSuspendedForkRow, 'run_id' | 'fork_id' | 'suspension_epoch'>>(
    'SELECT run_id, fork_id, suspension_epoch FROM harness_suspended_forks WHERE suspended_fork_id = $1',
    [suspendedForkId],
  );
  const target = queryResult.rows[0];
  if (target !== undefined) {
    await client.query(
      "UPDATE harness_suspended_forks SET status = $1 WHERE run_id = $2 AND fork_id = $3 AND suspension_epoch <= $4 AND status = 'SUSPENDED'",
      [status, target.run_id, target.fork_id, target.suspension_epoch],
    );
    return;
  }
  const hashIdx = suspendedForkId.lastIndexOf('#');
  if (hashIdx > 0) {
    const forkId = suspendedForkId.slice(0, hashIdx);
    const epoch = Number.parseInt(suspendedForkId.slice(hashIdx + 1), 10);
    if (Number.isInteger(epoch)) {
      await client.query(
        "UPDATE harness_suspended_forks SET status = $1 WHERE fork_id = $2 AND suspension_epoch <= $3 AND status = 'SUSPENDED'",
        [status, forkId, epoch],
      );
    }
  }
}
