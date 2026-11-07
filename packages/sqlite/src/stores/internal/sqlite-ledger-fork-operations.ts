import type { SqliteSuspendedForkRow } from './sqlite-suspended-fork-row.js';

/**
 * Parsed `(forkId, epoch)` coordinates extracted from a monotonic `${forkId}#${suspensionEpoch}` identifier.
 */
export interface ParsedSuspendedForkIdOptions {
  /** Logical fork step identifier. */
  readonly forkId: string;
  /** Positive integer suspension epoch. */
  readonly epoch: number;
}

/**
 * Checks whether a persisted `SqliteSuspendedForkRow` matches the optional `forkIds` and `parentStepExecId` filter.
 *
 * Matches `forkIdSet` against both `row.fork_id` and `row.suspended_fork_id`.
 *
 * @param {SqliteSuspendedForkRow}          row              - Candidate suspended fork database row.
 * @param {ReadonlySet<string> | undefined} forkIdSet        - Optional set of target fork or suspended-fork IDs.
 * @param {string | undefined}              parentStepExecId - Optional parent step execution ID filter.
 *
 * @returns {boolean} `true` when the row satisfies all provided filter criteria.
 */
export function matchesSuspendedForkFilter(
  row: SqliteSuspendedForkRow,
  forkIdSet: ReadonlySet<string> | undefined,
  parentStepExecId: string | undefined,
): boolean {
  if (parentStepExecId !== undefined && row.parent_step_exec_id !== parentStepExecId) {
    return false;
  }
  if (
    forkIdSet !== undefined &&
    !forkIdSet.has(row.fork_id) &&
    !forkIdSet.has(row.suspended_fork_id)
  ) {
    return false;
  }
  return true;
}

/**
 * Parses a monotonic `${forkId}#${suspensionEpoch}` string into its `forkId` and integer `epoch`.
 *
 * Returns `undefined` if `suspendedForkId` does not contain a `#` separator followed by a valid integer epoch.
 *
 * @param {string} suspendedForkId - Monotonic `${forkId}#${suspensionEpoch}` identifier.
 *
 * @returns {ParsedSuspendedForkIdOptions | undefined} Parsed coordinates, or `undefined` if malformed.
 */
export function parseSuspendedForkCoordinates(
  suspendedForkId: string,
): ParsedSuspendedForkIdOptions | undefined {
  const hashIdx = suspendedForkId.lastIndexOf('#');
  if (hashIdx <= 0) {
    return undefined;
  }
  const forkId = suspendedForkId.slice(0, hashIdx);
  const epoch = Number.parseInt(suspendedForkId.slice(hashIdx + 1), 10);
  if (!Number.isInteger(epoch)) {
    return undefined;
  }
  return { forkId, epoch };
}
