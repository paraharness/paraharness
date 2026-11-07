import type { MutateLanePlanRequest } from '@harness-dsl/core';
import type Database from 'better-sqlite3';

/**
 * Parameters for persisting a parent item's updated prerequisite chain and rolling spawned tip in SQLite.
 */
export interface UpsertParentLaneItemSqliteParams {
  /** Active SQLite database handle. */
  readonly db: Database.Database;
  /** Original lane plan mutation request. */
  readonly req: MutateLanePlanRequest;
  /** Updated prerequisite list for `req.parentItemKey`. */
  readonly nextParentDeps: readonly string[];
  /** Newly chained prerequisite tip item key, if any. */
  readonly rollingTip: string | undefined;
  /** ISO-8601 timestamp string for `updated_at`. */
  readonly now: string;
}

/**
 * Persists all newly spawned prerequisite items and their `'QUEUED'` run placeholders in SQLite.
 *
 * Updates `depends_on_json` on both `harness_lane_items` and `harness_runs` for each spawned item.
 *
 * @param {Database.Database}                       db         - Active SQLite database handle.
 * @param {MutateLanePlanRequest}                   req        - Lane plan mutation request.
 * @param {ReadonlyMap<string, readonly string[]>}  depsByItem - Validated dependency adjacency map.
 *
 * @returns {void} Returns nothing once all spawned items are persisted.
 */
export function upsertSpawnedLaneItemsInSqlite(
  db: Database.Database,
  req: MutateLanePlanRequest,
  depsByItem: ReadonlyMap<string, readonly string[]>,
): void {
  const now = new Date().toISOString();
  for (const spawnedTask of req.spawnedItems ?? []) {
    const taskDepsJson = JSON.stringify(depsByItem.get(spawnedTask.itemKey) ?? []);
    db.prepare(
      'INSERT OR REPLACE INTO harness_lane_items (lane_id, item_key, input_json, depends_on_json, priority, latest_spawned_tip_key) VALUES (?, ?, ?, ?, ?, NULL)',
    ).run(
      req.laneId,
      spawnedTask.itemKey,
      spawnedTask.inputJson,
      taskDepsJson,
      spawnedTask.priority,
    );
    db.prepare(
      "INSERT OR IGNORE INTO harness_runs (run_id, lane_id, item_key, status, current_step_id, input_json, depends_on_json, priority, updated_at) VALUES (?, ?, ?, 'QUEUED', NULL, ?, ?, ?, ?)",
    ).run(
      spawnedTask.itemKey,
      req.laneId,
      spawnedTask.itemKey,
      spawnedTask.inputJson,
      taskDepsJson,
      spawnedTask.priority,
      now,
    );
    db.prepare(
      'UPDATE harness_runs SET depends_on_json = ?, updated_at = ? WHERE lane_id = ? AND item_key = ?',
    ).run(taskDepsJson, now, req.laneId, spawnedTask.itemKey);
  }
}

/**
 * Persists the parent work item's updated `depends_on_json` and `latest_spawned_tip_key` in SQLite.
 *
 * Synchronizes both `harness_lane_items` and `harness_runs` for `params.req.parentRunId`.
 *
 * @param {UpsertParentLaneItemSqliteParams} params - Parent lane item update parameters.
 *
 * @returns {void} Returns nothing once the parent item and run dependencies are updated.
 */
export function upsertParentLaneItemInSqlite(params: UpsertParentLaneItemSqliteParams): void {
  const parentDepsJson = JSON.stringify(params.nextParentDeps);
  params.db
    .prepare(
      "INSERT OR REPLACE INTO harness_lane_items (lane_id, item_key, input_json, depends_on_json, priority, latest_spawned_tip_key) VALUES (?, ?, COALESCE((SELECT input_json FROM harness_runs WHERE run_id = ?), '{}'), ?, 'normal', ?)",
    )
    .run(
      params.req.laneId,
      params.req.parentItemKey,
      params.req.parentRunId,
      parentDepsJson,
      params.rollingTip ?? null,
    );
  params.db
    .prepare('UPDATE harness_runs SET depends_on_json = ?, updated_at = ? WHERE run_id = ?')
    .run(parentDepsJson, params.now, params.req.parentRunId);
}
