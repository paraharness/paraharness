import type { MutateLanePlanRequest } from '@metaharness/core';
import type { PostgresQueryClient } from '../../ddl/postgres-query-client.js';

/**
 * Parameters for persisting a parent item's updated prerequisite chain and rolling spawned tip in PostgreSQL.
 */
export interface UpsertParentLaneItemPgParams {
  /** Active PostgreSQL query client. */
  readonly client: PostgresQueryClient;
  /** Original lane plan mutation request. */
  readonly req: MutateLanePlanRequest;
  /** Updated prerequisite list for `req.parentItemKey`. */
  readonly nextParentDeps: readonly string[];
  /** Newly chained prerequisite tip item key, if any. */
  readonly rollingTip: string | undefined;
}

/**
 * Persists all newly spawned prerequisite items and their `'QUEUED'` run placeholders in PostgreSQL.
 *
 * Upserts into `harness_lane_items` and inserts `'QUEUED'` run rows into `harness_runs`.
 *
 * @param {PostgresQueryClient}                    client     - Active PostgreSQL query client.
 * @param {MutateLanePlanRequest}                  req        - Lane plan mutation request.
 * @param {ReadonlyMap<string, readonly string[]>} depsByItem - Validated dependency adjacency map.
 *
 * @returns {Promise<void>} Resolves once all spawned items and added dependency placeholders are persisted.
 */
export async function upsertSpawnedLaneItemsInPg(
  client: PostgresQueryClient,
  req: MutateLanePlanRequest,
  depsByItem: ReadonlyMap<string, readonly string[]>,
): Promise<void> {
  const now = new Date().toISOString();
  for (const spawnedTask of req.spawnedItems ?? []) {
    const taskDeps = depsByItem.get(spawnedTask.itemKey) ?? [];
    await client.query(
      'INSERT INTO harness_lane_items (lane_id, item_key, input_json, priority, depends_on_json, latest_spawned_tip_key) VALUES ($1, $2, $3, $4, $5, NULL) ON CONFLICT (lane_id, item_key) DO UPDATE SET input_json = EXCLUDED.input_json, priority = EXCLUDED.priority, depends_on_json = EXCLUDED.depends_on_json',
      [
        req.laneId,
        spawnedTask.itemKey,
        spawnedTask.inputJson,
        spawnedTask.priority,
        JSON.stringify(taskDeps),
      ],
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
}

/**
 * Persists the parent work item's updated `depends_on_json` and `latest_spawned_tip_key` in PostgreSQL.
 *
 * Preserves any existing `input_json` and `priority` on `harness_lane_items`.
 *
 * @param {UpsertParentLaneItemPgParams} params - Parent lane item update parameters.
 *
 * @returns {Promise<void>} Resolves once the parent lane item is updated.
 */
export async function upsertParentLaneItemInPg(
  params: UpsertParentLaneItemPgParams,
): Promise<void> {
  const parentQueryResult = await params.client.query<{
    readonly input_json: string;
    readonly priority: string;
  }>('SELECT input_json, priority FROM harness_lane_items WHERE lane_id = $1 AND item_key = $2', [
    params.req.laneId,
    params.req.parentItemKey,
  ]);
  const parentExists = parentQueryResult.rows[0];
  await params.client.query(
    'INSERT INTO harness_lane_items (lane_id, item_key, input_json, priority, depends_on_json, latest_spawned_tip_key) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (lane_id, item_key) DO UPDATE SET depends_on_json = EXCLUDED.depends_on_json, latest_spawned_tip_key = EXCLUDED.latest_spawned_tip_key',
    [
      params.req.laneId,
      params.req.parentItemKey,
      parentExists?.input_json ?? '{}',
      parentExists?.priority ?? 'normal',
      JSON.stringify(params.nextParentDeps),
      params.rollingTip ?? null,
    ],
  );
}
