import type {
  CommitRunOverlayResult,
  TopologyPartitionState,
  TopologyStore,
} from '@metaharness/core';
import PQueue from 'p-queue';
import type { Pool } from 'pg';
import { normalizePostgresClient } from '../ddl/internal/normalize-postgres-client.js';
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
  type ResetPgRunOverlayOptions,
  getPartitionsWithPgOverlay,
  resetPgOverlayByScope,
  syncPrerequisitePgOverlays,
  updateContractInPgOverlay,
} from './internal/pg-topology-overlay-ops.js';

/**
 * PostgreSQL implementation of the `@metaharness/core` `TopologyStore` runtime port.
 *
 * Provides run-isolated Copy-on-Write partition contract overlays, at-most-once per-run epoch
 * increments, stacked-PR `syncRunOverlays` baseline advancement, step/run-scoped rollbacks,
 * and atomic 3-way merge commits into `harness_topology_base`.
 */
export class PostgresTopologyStore implements TopologyStore {
  /** Underlying PostgreSQL query client. */
  private readonly client: PostgresQueryClient;
  /** Single-concurrency FIFO queue serializing asynchronous store operations. */
  private readonly queue = new PQueue({ concurrency: 1 });
  /** Lazily memoized schema initialization promise. */
  private initPromise: Promise<PostgresQueryClient> | undefined;

  /**
   * Initializes a `PostgresTopologyStore` backed by a `PostgresQueryClient`, `pg.Pool`, or connection URI string.
   *
   * Defers DDL execution until the first store operation so constructing the store performs zero I/O.
   *
   * @param {PostgresQueryClient | Pool | string} client - PostgreSQL query client, `pg.Pool`, or connection URI.
   */
  constructor(client: PostgresQueryClient | Pool | string) {
    this.client = normalizePostgresClient(client);
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
      this.initPromise = ensurePostgresSchemaInitialized(this.client).catch((error: unknown) => {
        this.initPromise = undefined;
        throw error;
      });
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
  getPartitions(runId?: string): Promise<ReadonlyMap<string, TopologyPartitionState>> {
    return this.queue.add(async () =>
      runInPostgresTransaction(await this.ensureReady(), (tx) =>
        getPartitionsWithPgOverlay(tx, runId),
      ),
    );
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
  updateContract(
    runId: string,
    partitionId: string,
    newContractText: string,
    stepExecId?: string,
  ): Promise<{ readonly newEpoch: number }> {
    return this.queue.add(async () =>
      runInPostgresTransaction(await this.ensureReady(), (tx) =>
        updateContractInPgOverlay(tx, {
          runId,
          partitionId,
          newContractText,
          stepExecId,
        }),
      ),
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
  syncRunOverlays(
    targetRunId: string,
    prerequisiteRunIds: readonly string[],
  ): Promise<void> {
    return this.queue.add(async () =>
      runInPostgresTransaction(await this.ensureReady(), (tx) =>
        syncPrerequisitePgOverlays(tx, targetRunId, prerequisiteRunIds),
      ),
    );
  }

  /**
   * Resets uncommitted overlay mutations for `runId` at either the `'step'` or `'run'` scope.
   *
   * Preserves completed step mutations when `scope === 'step'` and rolls back the entire run overlay when `scope === 'run'`.
   *
   * @param {string}                  runId  - Target flow run identifier.
   * @param {ResetPgRunOverlayOptions} [opts] - Reset scope options.
   *
   * @returns {Promise<void>} Resolves once matching uncommitted overlay mutations are rolled back.
   */
  resetRunOverlay(runId: string, opts?: ResetPgRunOverlayOptions): Promise<void> {
    return this.queue.add(async () =>
      runInPostgresTransaction(await this.ensureReady(), (tx) =>
        resetPgOverlayByScope(tx, runId, opts),
      ),
    );
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
  sealRunOverlay(runId: string): Promise<void> {
    return this.queue.add(async () => sealPgOverlayForRun(await this.ensureReady(), runId));
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
  commitRunOverlay(runId: string): Promise<CommitRunOverlayResult> {
    return this.queue.add(async () =>
      runInPostgresTransaction(await this.ensureReady(), (tx) =>
        commitPgOverlayThreeWayMerge(tx, runId),
      ),
    );
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
  discardRunOverlay(runId: string): Promise<void> {
    return this.queue.add(async () => discardPgOverlayForRun(await this.ensureReady(), runId));
  }
}
