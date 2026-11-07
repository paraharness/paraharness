import type { PgTopologyOverlayRow } from './pg-topology-overlay-row.js';
import { threeWayMergeContract } from './three-way-merge-contract.js';

/**
 * Parameters for computing a merged PostgreSQL overlay row when absorbing a prerequisite run's overlay.
 */
export interface ComputeSyncedPgOverlayParams {
  /** Dependent run identifier absorbing the prerequisite overlay. */
  readonly targetRunId: string;
  /** Prerequisite run identifier being absorbed. */
  readonly prereqRunId: string;
  /** Prerequisite run's active or sealed overlay row. */
  readonly prereqRow: PgTopologyOverlayRow;
  /** Target run's existing overlay row for the same partition, if any. */
  readonly targetRow: PgTopologyOverlayRow | undefined;
}

/**
 * Computed column values for upserting an absorbed prerequisite overlay into `targetRunId`'s overlay in PostgreSQL.
 */
export interface SyncedPgOverlayValuesOptions {
  /** Merged overlay epoch (`max(target.epoch, prereq.epoch)`). */
  readonly nextEpoch: number;
  /** 3-way merged contract text. */
  readonly mergedContractText: string;
  /** Updated `base_contract_text_at_acquire` for subsequent 3-way commit merges. */
  readonly nextAcquireBase: string;
  /** Preserved initial base contract text when `targetRunId` first acquired the partition. */
  readonly initialBase: string;
  /** Run identifier credited with the latest contract mutation. */
  readonly nextLastMutatedBy: string | null;
  /** JSON array of absorbed prerequisite run identifiers. */
  readonly absorbedRunIdsJson: string;
  /** Flag (`0` or `1`) indicating whether `targetRunId` itself mutated this partition. */
  readonly mutatedInRun: number;
  /** Overlay lifecycle status (`'ACTIVE'` or `'SEALED_UNMERGED'`). */
  readonly status: string;
  /** JSON-serialized step mutation rollback log. */
  readonly stepMutationsJson: string;
}

/**
 * Resolves the `base_contract_text_at_acquire` value to persist when updating a partition contract in a PostgreSQL overlay.
 *
 * Preserves `ovRow.base_contract_text_at_acquire` when already mutated in the current run,
 * uses `ovRow.baseline_contract_text` on the first mutation after a prerequisite sync,
 * or falls back to `baseText` when creating a fresh overlay row.
 *
 * @param {PgTopologyOverlayRow | undefined} ovRow          - Existing overlay row for `(runId, partitionId)`, if any.
 * @param {boolean}                          alreadyMutated - Whether `ovRow` was already mutated in `runId`.
 * @param {string}                           baseText       - Canonical base contract text.
 *
 * @returns {string} Acquire-base contract text to store on the overlay row.
 */
export function resolveNextPgAcquireBase(
  ovRow: PgTopologyOverlayRow | undefined,
  alreadyMutated: boolean,
  baseText: string,
): string {
  if (ovRow === undefined) {
    return baseText;
  }
  if (alreadyMutated) {
    return ovRow.base_contract_text_at_acquire;
  }
  return ovRow.baseline_contract_text;
}

/**
 * Resolves the `base_contract_text_at_acquire` after folding `prereqRow` into `targetRow` in PostgreSQL.
 *
 * Advances the acquire baseline to `prereqRow.contract_text` when `targetRow` mutated on top of a prerequisite,
 * or preserves the earlier baseline during a stacked child fold.
 *
 * @param {PgTopologyOverlayRow}             prereqRow          - Prerequisite overlay row being absorbed.
 * @param {PgTopologyOverlayRow | undefined} targetRow          - Target overlay row, if any.
 * @param {boolean}                          isStackedChildFold - Whether `prereqRow` already absorbed `targetRunId`.
 *
 * @returns {string} Updated `base_contract_text_at_acquire` value.
 */
function resolveSyncedPgAcquireBase(
  prereqRow: PgTopologyOverlayRow,
  targetRow: PgTopologyOverlayRow | undefined,
  isStackedChildFold: boolean,
): string {
  if (targetRow === undefined || targetRow.mutated_in_run !== 1) {
    return prereqRow.base_contract_text_at_acquire;
  }
  if (isStackedChildFold) {
    return targetRow.base_contract_text_at_acquire;
  }
  return prereqRow.contract_text;
}

/**
 * Resolves `last_mutated_by_run_id` after folding `prereqRow` into `targetRow` in PostgreSQL.
 *
 * Credits the stacked child on a child fold, the target run when `targetRow` mutated independently,
 * or the prerequisite run when `targetRow` had not mutated the partition.
 *
 * @param {PgTopologyOverlayRow}             prereqRow          - Prerequisite overlay row being absorbed.
 * @param {PgTopologyOverlayRow | undefined} targetRow          - Target overlay row, if any.
 * @param {boolean}                          isStackedChildFold - Whether `prereqRow` already absorbed `targetRunId`.
 *
 * @returns {string | null} Run identifier to record as `last_mutated_by_run_id`.
 */
function resolveSyncedPgLastMutatedBy(
  prereqRow: PgTopologyOverlayRow,
  targetRow: PgTopologyOverlayRow | undefined,
  isStackedChildFold: boolean,
): string | null {
  if (targetRow === undefined || targetRow.mutated_in_run !== 1) {
    return prereqRow.last_mutated_by_run_id;
  }
  if (isStackedChildFold) {
    return prereqRow.last_mutated_by_run_id ?? targetRow.last_mutated_by_run_id;
  }
  return targetRow.last_mutated_by_run_id ?? prereqRow.last_mutated_by_run_id;
}

/**
 * Computes the merged overlay state when synchronizing `params.prereqRow` into `params.targetRunId` in PostgreSQL.
 *
 * Performs a 3-way contract merge when `targetRow` also mutated the partition and unions absorbed run IDs.
 *
 * @param {ComputeSyncedPgOverlayParams} params - Target and prerequisite overlay rows.
 *
 * @returns {SyncedPgOverlayValuesOptions} Computed column values for upserting the target overlay row.
 */
export function computeSyncedPgOverlayValues(
  params: ComputeSyncedPgOverlayParams,
): SyncedPgOverlayValuesOptions {
  const { targetRunId, prereqRunId, prereqRow, targetRow } = params;
  const prereqAbsorbed = new Set<string>(JSON.parse(prereqRow.absorbed_run_ids_json) as string[]);
  const absorbed = new Set<string>(
    targetRow !== undefined ? (JSON.parse(targetRow.absorbed_run_ids_json) as string[]) : [],
  );
  for (const id of prereqAbsorbed) {
    absorbed.add(id);
  }
  absorbed.add(prereqRunId);
  const isStackedChildFold =
    targetRow !== undefined &&
    (prereqAbsorbed.has(targetRunId) ||
      prereqRow.base_contract_text_at_acquire === targetRow.contract_text);
  const targetMutated = targetRow !== undefined && targetRow.mutated_in_run === 1;
  const mergeBase = isStackedChildFold
    ? prereqRow.base_contract_text_at_acquire
    : (targetRow?.base_contract_text_at_acquire ?? prereqRow.base_contract_text_at_acquire);
  const mergedContractText = targetMutated
    ? threeWayMergeContract(mergeBase, prereqRow.contract_text, targetRow.contract_text)
    : prereqRow.contract_text;
  const nextAcquireBase = resolveSyncedPgAcquireBase(prereqRow, targetRow, isStackedChildFold);
  const nextLastMutatedBy = resolveSyncedPgLastMutatedBy(prereqRow, targetRow, isStackedChildFold);
  const nextEpoch =
    targetRow !== undefined ? Math.max(targetRow.epoch, prereqRow.epoch) : prereqRow.epoch;
  const initialBase =
    targetRow !== undefined
      ? targetRow.initial_base_contract_text
      : prereqRow.initial_base_contract_text;
  return {
    nextEpoch,
    mergedContractText,
    nextAcquireBase,
    initialBase,
    nextLastMutatedBy,
    absorbedRunIdsJson: JSON.stringify(Array.from(absorbed)),
    mutatedInRun: targetRow !== undefined ? targetRow.mutated_in_run : 0,
    status: targetRow !== undefined ? targetRow.status : 'ACTIVE',
    stepMutationsJson: targetRow !== undefined ? targetRow.step_mutations_json : '[]',
  };
}
