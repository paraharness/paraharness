import type { TopologyPartitionState } from '@harness-dsl/core';
import type { PostgresQueryClient } from '../../ddl/postgres-query-client.js';
import type { PgOverlayStepMutationEntry } from './pg-overlay-step-mutation-entry.js';
import type { PgTopologyBaseRow } from './pg-topology-base-row.js';
import type { PgTopologyOverlayRow } from './pg-topology-overlay-row.js';
import { threeWayMergeContract } from './three-way-merge-contract.js';
import type { UpdateContractInOverlayParams } from './update-contract-in-overlay-params.js';

/**
 * Loads the partition graph for `runId` (merging any uncommitted CoW overlay over `harness_topology_base`) in PostgreSQL.
 *
 * Pins `base_contract_text_at_acquire` when `runId` first inspects each base partition (`SPEC.md` §3.3).
 *
 * @param {PostgresQueryClient} client  - Active PostgreSQL query client.
 * @param {string}              [runId] - Optional active flow run identifier.
 *
 * @returns {Promise<ReadonlyMap<string, TopologyPartitionState>>} Partition state map keyed by `partitionId`.
 */
export async function getPartitionsWithPgOverlay(
  client: PostgresQueryClient,
  runId?: string,
): Promise<ReadonlyMap<string, TopologyPartitionState>> {
  const baseQueryResult = await client.query<PgTopologyBaseRow>('SELECT * FROM harness_topology_base ORDER BY partition_id ASC');
  const partitions = new Map<string, TopologyPartitionState>();
  for (const baseRow of baseQueryResult.rows) {
    partitions.set(baseRow.partition_id, Object.freeze<TopologyPartitionState>({
      partitionId: baseRow.partition_id, epoch: baseRow.epoch, contractText: baseRow.contract_text,
      updatedAt: baseRow.updated_at, lastMutatedByRunId: baseRow.last_mutated_by_run_id ?? undefined,
    }));
  }
  if (runId === undefined) return partitions;
  const overlayQueryResult = await client.query<PgTopologyOverlayRow>('SELECT * FROM harness_topology_overlays WHERE run_id = $1 ORDER BY partition_id ASC', [runId]);
  const overlayPartitions = new Set<string>();
  for (const ovRow of overlayQueryResult.rows) {
    overlayPartitions.add(ovRow.partition_id);
    if (ovRow.has_uncommitted_changes === 1 || ovRow.mutated_in_run === 1) {
      partitions.set(ovRow.partition_id, Object.freeze<TopologyPartitionState>({
        partitionId: ovRow.partition_id, epoch: ovRow.epoch, contractText: ovRow.contract_text,
        updatedAt: ovRow.updated_at, lastMutatedByRunId: ovRow.last_mutated_by_run_id ?? undefined,
      }));
    }
  }
  for (const baseRow of baseQueryResult.rows) {
    if (!overlayPartitions.has(baseRow.partition_id)) {
      await client.query(
        "INSERT INTO harness_topology_overlays (run_id, partition_id, epoch, contract_text, base_contract_text_at_acquire, initial_base_contract_text, baseline_contract_text, baseline_epoch, baseline_last_mutated_by_run_id, mutated_in_run, has_uncommitted_changes, last_mutated_by_run_id, status, updated_at, absorbed_run_ids_json, step_mutations_json) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0, 0, $10, 'ACTIVE', $11, '[]', '[]') ON CONFLICT (run_id, partition_id) DO NOTHING",
        [runId, baseRow.partition_id, baseRow.epoch, baseRow.contract_text, baseRow.contract_text, baseRow.contract_text, baseRow.contract_text, baseRow.epoch, baseRow.last_mutated_by_run_id, baseRow.last_mutated_by_run_id, baseRow.updated_at],
      );
    }
  }
  return partitions;
}

/**
 * Writes a contract update to `params.runId`'s isolated CoW overlay and increments `epoch` at most once per `(runId, partitionId)` in PostgreSQL.
 *
 * Tags the mutation with `params.stepExecId` so `resetPgOverlayByScope` can roll back individual steps (`SPEC.md` §3.3).
 *
 * @param {PostgresQueryClient}           client - Active PostgreSQL query client.
 * @param {UpdateContractInOverlayParams} params - Contract update parameters.
 *
 * @returns {Promise<{ readonly newEpoch: number }>} Updated overlay epoch for `params.partitionId`.
 */
export async function updateContractInPgOverlay(
  client: PostgresQueryClient,
  params: UpdateContractInOverlayParams,
): Promise<{ readonly newEpoch: number }> {
  const baseQueryResult = await client.query<PgTopologyBaseRow>('SELECT * FROM harness_topology_base WHERE partition_id = $1', [params.partitionId]);
  const ovQueryResult = await client.query<PgTopologyOverlayRow>('SELECT * FROM harness_topology_overlays WHERE run_id = $1 AND partition_id = $2', [params.runId, params.partitionId]);
  const baseRow = baseQueryResult.rows[0];
  const ovRow = ovQueryResult.rows[0];
  const now = new Date().toISOString();
  const baseEpoch = baseRow?.epoch ?? 0;
  const baseText = baseRow?.contract_text ?? '';
  const baseLastRun = baseRow?.last_mutated_by_run_id ?? null;
  const currentEpoch = ovRow !== undefined ? ovRow.epoch : baseEpoch;
  const alreadyMutated = ovRow !== undefined && ovRow.mutated_in_run === 1;
  const newEpoch = alreadyMutated ? currentEpoch : currentEpoch + 1;
  const history: PgOverlayStepMutationEntry[] = ovRow !== undefined ? (JSON.parse(ovRow.step_mutations_json) as PgOverlayStepMutationEntry[]) : [];
  history.push({
    stepExecId: params.stepExecId ?? null,
    prevContractText: ovRow !== undefined ? ovRow.contract_text : baseText,
    prevEpoch: currentEpoch,
    prevMutatedInRun: ovRow !== undefined ? ovRow.mutated_in_run : 0,
    prevHasUncommittedChanges: ovRow !== undefined ? ovRow.has_uncommitted_changes : 0,
    prevLastMutatedByRunId: ovRow !== undefined ? ovRow.last_mutated_by_run_id : baseLastRun,
  });
  await client.query(
    "INSERT INTO harness_topology_overlays (run_id, partition_id, epoch, contract_text, base_contract_text_at_acquire, initial_base_contract_text, baseline_contract_text, baseline_epoch, baseline_last_mutated_by_run_id, mutated_in_run, has_uncommitted_changes, last_mutated_by_run_id, status, updated_at, absorbed_run_ids_json, step_mutations_json) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1, 1, $10, 'ACTIVE', $11, $12, $13) ON CONFLICT (run_id, partition_id) DO UPDATE SET epoch = EXCLUDED.epoch, contract_text = EXCLUDED.contract_text, base_contract_text_at_acquire = EXCLUDED.base_contract_text_at_acquire, initial_base_contract_text = EXCLUDED.initial_base_contract_text, baseline_contract_text = EXCLUDED.baseline_contract_text, baseline_epoch = EXCLUDED.baseline_epoch, baseline_last_mutated_by_run_id = EXCLUDED.baseline_last_mutated_by_run_id, mutated_in_run = 1, has_uncommitted_changes = 1, last_mutated_by_run_id = EXCLUDED.last_mutated_by_run_id, status = 'ACTIVE', updated_at = EXCLUDED.updated_at, absorbed_run_ids_json = EXCLUDED.absorbed_run_ids_json, step_mutations_json = EXCLUDED.step_mutations_json",
    [
      params.runId, params.partitionId, newEpoch, params.newContractText,
      ovRow !== undefined ? (alreadyMutated ? ovRow.base_contract_text_at_acquire : ovRow.baseline_contract_text) : baseText,
      ovRow !== undefined ? ovRow.initial_base_contract_text : baseText,
      ovRow !== undefined ? ovRow.baseline_contract_text : baseText,
      ovRow !== undefined ? ovRow.baseline_epoch : baseEpoch,
      ovRow !== undefined ? ovRow.baseline_last_mutated_by_run_id : baseLastRun,
      params.runId, now, ovRow !== undefined ? ovRow.absorbed_run_ids_json : '[]', JSON.stringify(history),
    ],
  );
  return Object.freeze({ newEpoch });
}

/**
 * Merges `ACTIVE` or `SEALED_UNMERGED` prerequisite overlays into `targetRunId`'s overlay in PostgreSQL (`SPEC.md` §3.3).
 *
 * Preserves `lastMutatedByRunId` and advances `targetRunId`'s `base_contract_text_at_acquire` to the prerequisite's `contract_text`.
 *
 * @param {PostgresQueryClient} client             - Active PostgreSQL query client.
 * @param {string}              targetRunId        - Dependent run absorbing the prerequisite overlays.
 * @param {readonly string[]}   prerequisiteRunIds - Prerequisite run IDs to merge from.
 *
 * @returns {Promise<void>} Resolves once prerequisite overlays are absorbed.
 */
export async function syncPrerequisitePgOverlays(
  client: PostgresQueryClient,
  targetRunId: string,
  prerequisiteRunIds: readonly string[],
): Promise<void> {
  const now = new Date().toISOString();
  const upsertSql =
    'INSERT INTO harness_topology_overlays (run_id, partition_id, epoch, contract_text, base_contract_text_at_acquire, initial_base_contract_text, baseline_contract_text, baseline_epoch, baseline_last_mutated_by_run_id, mutated_in_run, has_uncommitted_changes, last_mutated_by_run_id, status, updated_at, absorbed_run_ids_json, step_mutations_json) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 1, $11, $12, $13, $14, $15) ON CONFLICT (run_id, partition_id) DO UPDATE SET epoch = EXCLUDED.epoch, contract_text = EXCLUDED.contract_text, base_contract_text_at_acquire = EXCLUDED.base_contract_text_at_acquire, initial_base_contract_text = EXCLUDED.initial_base_contract_text, baseline_contract_text = EXCLUDED.baseline_contract_text, baseline_epoch = EXCLUDED.baseline_epoch, baseline_last_mutated_by_run_id = EXCLUDED.baseline_last_mutated_by_run_id, mutated_in_run = EXCLUDED.mutated_in_run, has_uncommitted_changes = 1, last_mutated_by_run_id = EXCLUDED.last_mutated_by_run_id, status = EXCLUDED.status, updated_at = EXCLUDED.updated_at, absorbed_run_ids_json = EXCLUDED.absorbed_run_ids_json, step_mutations_json = EXCLUDED.step_mutations_json';
  for (const prereqRunId of prerequisiteRunIds) {
    const prereqQueryResult = await client.query<PgTopologyOverlayRow>(
      "SELECT * FROM harness_topology_overlays WHERE run_id = $1 AND status IN ('ACTIVE', 'SEALED_UNMERGED') AND (mutated_in_run = 1 OR has_uncommitted_changes = 1)",
      [prereqRunId],
    );
    for (const prereqRow of prereqQueryResult.rows) {
      const targetQueryResult = await client.query<PgTopologyOverlayRow>('SELECT * FROM harness_topology_overlays WHERE run_id = $1 AND partition_id = $2', [targetRunId, prereqRow.partition_id]);
      const targetRow = targetQueryResult.rows[0];
      const prereqAbsorbed = new Set<string>(JSON.parse(prereqRow.absorbed_run_ids_json) as string[]);
      const absorbed = new Set<string>(targetRow !== undefined ? (JSON.parse(targetRow.absorbed_run_ids_json) as string[]) : []);
      for (const id of prereqAbsorbed) absorbed.add(id);
      absorbed.add(prereqRunId);
      const isStackedChildFold = targetRow !== undefined && (prereqAbsorbed.has(targetRunId) || prereqRow.base_contract_text_at_acquire === targetRow.contract_text);
      const targetMutated = targetRow !== undefined && targetRow.mutated_in_run === 1;
      const mergeBase = isStackedChildFold ? prereqRow.base_contract_text_at_acquire : (targetRow?.base_contract_text_at_acquire ?? prereqRow.base_contract_text_at_acquire);
      const mergedContractText = targetMutated ? threeWayMergeContract(mergeBase, prereqRow.contract_text, targetRow.contract_text) : prereqRow.contract_text;
      const nextAcquireBase = !targetMutated ? prereqRow.base_contract_text_at_acquire : (isStackedChildFold ? targetRow.base_contract_text_at_acquire : prereqRow.contract_text);
      const nextLastMutatedBy = targetMutated ? (isStackedChildFold ? (prereqRow.last_mutated_by_run_id ?? targetRow.last_mutated_by_run_id) : (targetRow.last_mutated_by_run_id ?? prereqRow.last_mutated_by_run_id)) : prereqRow.last_mutated_by_run_id;
      const nextEpoch = targetRow !== undefined ? Math.max(targetRow.epoch, prereqRow.epoch) : prereqRow.epoch;
      const initialBase = targetRow !== undefined ? targetRow.initial_base_contract_text : prereqRow.initial_base_contract_text;
      await client.query(upsertSql, [targetRunId, prereqRow.partition_id, nextEpoch, mergedContractText, nextAcquireBase, initialBase, prereqRow.contract_text, nextEpoch, prereqRow.last_mutated_by_run_id, targetRow !== undefined ? targetRow.mutated_in_run : 0, nextLastMutatedBy, targetRow !== undefined ? targetRow.status : 'ACTIVE', now, JSON.stringify(Array.from(absorbed)), targetRow !== undefined ? targetRow.step_mutations_json : '[]']);
    }
  }
}

/**
 * Resets uncommitted overlay mutations for `runId` at either the `'step'` or `'run'` scope in PostgreSQL (`SPEC.md` §3.3).
 *
 * Reverts only `opts.stepExecId` mutations when `scope === 'step'`, or reverts the entire run overlay to its baseline when `scope === 'run'`.
 *
 * @param {PostgresQueryClient}                                               client - Active PostgreSQL query client.
 * @param {string}                                                            runId  - Target flow run identifier.
 * @param {{ readonly scope?: 'step' | 'run'; readonly stepExecId?: string }} [opts] - Reset scope options.
 *
 * @returns {Promise<void>} Resolves once the overlay reset is committed.
 */
export async function resetPgOverlayByScope(
  client: PostgresQueryClient,
  runId: string,
  opts?: { readonly scope?: 'step' | 'run'; readonly stepExecId?: string },
): Promise<void> {
  const queryResult = await client.query<PgTopologyOverlayRow>('SELECT * FROM harness_topology_overlays WHERE run_id = $1', [runId]);
  const now = new Date().toISOString();
  if (opts?.scope === 'step' && opts.stepExecId !== undefined) {
    for (const row of queryResult.rows) {
      const history = JSON.parse(row.step_mutations_json) as PgOverlayStepMutationEntry[];
      const firstMatchIdx = history.findIndex((entry) => entry.stepExecId === opts.stepExecId);
      if (firstMatchIdx < 0) continue;
      const restoreTarget = history[firstMatchIdx];
      if (restoreTarget === undefined) continue;
      const remaining = history.slice(0, firstMatchIdx);
      await client.query(
        'UPDATE harness_topology_overlays SET contract_text = $1, epoch = $2, mutated_in_run = $3, has_uncommitted_changes = $4, last_mutated_by_run_id = $5, step_mutations_json = $6, updated_at = $7 WHERE run_id = $8 AND partition_id = $9',
        [restoreTarget.prevContractText, restoreTarget.prevEpoch, restoreTarget.prevMutatedInRun, restoreTarget.prevHasUncommittedChanges, restoreTarget.prevLastMutatedByRunId, JSON.stringify(remaining), now, runId, row.partition_id],
      );
    }
    return;
  }
  for (const row of queryResult.rows) {
    const hasSyncedBaseline = row.baseline_contract_text !== row.initial_base_contract_text || row.absorbed_run_ids_json !== '[]';
    await client.query(
      "UPDATE harness_topology_overlays SET contract_text = $1, epoch = $2, mutated_in_run = 0, has_uncommitted_changes = $3, last_mutated_by_run_id = $4, step_mutations_json = '[]', updated_at = $5 WHERE run_id = $6 AND partition_id = $7",
      [row.baseline_contract_text, row.baseline_epoch, hasSyncedBaseline ? 1 : 0, row.baseline_last_mutated_by_run_id, now, runId, row.partition_id],
    );
  }
}
