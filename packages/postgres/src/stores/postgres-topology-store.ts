import type {
  CommitRunOverlayResult,
  TopologyPartitionState,
  TopologyStore,
} from '@harness-dsl/core';
import {
  ensurePostgresSchemaInitialized,
  runInPostgresTransaction,
} from '../ddl/internal/resolve-postgres-client.js';
import type { PostgresQueryClient } from '../ddl/postgres-query-client.js';
import {
  commitPgOverlayThreeWayMerge,
  discardPgOverlayForRun,
  sealPgOverlayForRun,
} from './internal/pg-topology-commit-ops.js';
import {
  getPartitionsWithPgOverlay,
  resetPgOverlayByScope,
  syncPrerequisitePgOverlays,
  updateContractInPgOverlay,
} from './internal/pg-topology-overlay-ops.js';

/**
 * PostgreSQL implementation of the `@harness-dsl/core` `TopologyStore` runtime port.
 *
 * Provides run-isolated Copy-on-Write partition contract overlays, at-most-once per-run epoch
 * increments, stacked-PR `syncRunOverlays` baseline advancement, step/run-scoped rollbacks,
 * and atomic 3-way merge commits into `harness_topology_base`.
 */
export class PostgresTopologyStore implements TopologyStore {
  /** Underlying PostgreSQL query client. */
  private readonly client: PostgresQueryClient;
  /** Lazily memoized schema initialization promise. */
  private initPromise: Promise<PostgresQueryClient> | undefined;

  /**
   * Initializes a `PostgresTopologyStore` backed by `client`.
   *
   * Defers DDL execution until the first store operation so constructing the store performs zero I/O.
   *
   * @param {PostgresQueryClient} client - PostgreSQL query client instance.
   */
  constructor(client: PostgresQueryClient) {
    this.client = client;
  }

  /**
   * Ensures the PostgreSQL schema DDL has been applied on `this.client`.
   *
   * Memoizes the initialization promise so DDL runs at most once per store instance.
   *
   * @returns {Promise<PostgresQueryClient>} Initialized query client.
   */
  private ensureReady(): Promise<PostgresQueryClient> {
    if (this.initPromise === undefined) {
      this.initPromise = ensurePostgresSchemaInitialized(this.client);
    }
    return this.initPromise;
  }

  /**
   * Loads the partition state map for `runId`, merging any uncommitted CoW overlay over `harness_topology_base`.
   *
   * Pins `baseContractTextAtAcquire` when `runId` first inspects each base partition.
   *
   * @param {string} [runId] - Optional active flow run identifier.
   *
   * @returns {Promise<ReadonlyMap<string, TopologyPartitionState>>} Map of `partitionId` to partition state.
   */
  async getPartitions(runId?: string): Promise<ReadonlyMap<string, TopologyPartitionState>> {
    const client = await this.ensureReady();
    return runInPostgresTransaction(client, () => getPartitionsWithPgOverlay(client, runId));
  }

  /**
   * Writes a contract update to `runId`'s isolated Copy-on-Write overlay.
   *
   * Increments the partition's overlay epoch at most once per `(runId, partitionId)` unless reset,
   * and tags the mutation with `stepExecId` for step-scoped rollback.
   *
   * @param {string} runId           - Active flow run identifier.
   * @param {string} partitionId     - Target partition identifier.
   * @param {string} newContractText - Updated contract text.
   * @param {string} [stepExecId]    - Optional active step execution identifier.
   *
   * @returns {Promise<{ readonly newEpoch: number }>} Updated overlay epoch for `partitionId`.
   */
  async updateContract(
    runId: string,
    partitionId: string,
    newContractText: string,
    stepExecId?: string,
  ): Promise<{ readonly newEpoch: number }> {
    const client = await this.ensureReady();
    return runInPostgresTransaction(client, () =>
      updateContractInPgOverlay(client, {
        runId,
        partitionId,
        newContractText,
        stepExecId,
      }),
    );
  }

  /**
   * Merges prerequisite runs' `ACTIVE` or `SEALED_UNMERGED` overlays into `targetRunId`'s overlay.
   *
   * Advances `targetRunId`'s 3-way merge-base text for each absorbed partition so stacked PRs never false-conflict.
   *
   * @param {string}            targetRunId        - Dependent run absorbing the prerequisite overlays.
   * @param {readonly string[]} prerequisiteRunIds - Prerequisite run identifiers to merge from.
   *
   * @returns {Promise<void>} Resolves once prerequisite overlays are merged.
   */
  async syncRunOverlays(
    targetRunId: string,
    prerequisiteRunIds: readonly string[],
  ): Promise<void> {
    const client = await this.ensureReady();
    await runInPostgresTransaction(client, () =>
      syncPrerequisitePgOverlays(client, targetRunId, prerequisiteRunIds),
    );
  }

  /**
   * Resets uncommitted overlay mutations for `runId` at either the `'step'` or `'run'` scope.
   *
   * Preserves completed step mutations when `scope === 'step'` and rolls back the entire run overlay when `scope === 'run'`.
   *
   * @param {string}                                                            runId  - Target flow run identifier.
   * @param {{ readonly scope?: 'step' | 'run'; readonly stepExecId?: string }} [opts] - Reset scope options.
   *
   * @returns {Promise<void>} Resolves once matching uncommitted overlay mutations are rolled back.
   */
  async resetRunOverlay(
    runId: string,
    opts?: { readonly scope?: 'step' | 'run'; readonly stepExecId?: string },
  ): Promise<void> {
    const client = await this.ensureReady();
    await runInPostgresTransaction(client, () => resetPgOverlayByScope(client, runId, opts));
  }

  /**
   * Transitions `runId`'s overlay to `SEALED_UNMERGED` upon flow exit `'done'` when awaiting an external merge signal.
   *
   * Allows dependent stacked runs to absorb the sealed overlay via `syncRunOverlays`.
   *
   * @param {string} runId - Completed flow run identifier.
   *
   * @returns {Promise<void>} Resolves once the overlay is sealed.
   */
  async sealRunOverlay(runId: string): Promise<void> {
    const client = await this.ensureReady();
    await sealPgOverlayForRun(client, runId);
  }

  /**
   * Atomically commits `runId`'s overlay (and any absorbed prerequisite `SEALED_UNMERGED` overlays)
   * to the base store using a 3-way merge against `baseContractTextAtAcquire`.
   *
   * Allocates monotonic base epoch numbers at commit time and returns `{ committedRunIds, updatedEpochs }`.
   *
   * @param {string} runId - Flow run identifier whose changes landed.
   *
   * @returns {Promise<CommitRunOverlayResult>} Committed run IDs and newly allocated base epoch numbers.
   */
  async commitRunOverlay(runId: string): Promise<CommitRunOverlayResult> {
    const client = await this.ensureReady();
    return runInPostgresTransaction(client, () => commitPgOverlayThreeWayMerge(client, runId));
  }

  /**
   * Discards `runId`'s overlay when a run fails, a PR closes unmerged, or `maxSealedAgeHours` expires.
   *
   * Removes all uncommitted or sealed overlay rows for `runId` without modifying the base store.
   *
   * @param {string} runId - Flow run identifier whose overlay should be discarded.
   *
   * @returns {Promise<void>} Resolves once the overlay is removed.
   */
  async discardRunOverlay(runId: string): Promise<void> {
    const client = await this.ensureReady();
    await discardPgOverlayForRun(client, runId);
  }
}
