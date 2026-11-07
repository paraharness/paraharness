import type {
  CommitRunOverlayResult,
  TopologyPartitionState,
  TopologyStore,
} from '@harness-dsl/core';
import type Database from 'better-sqlite3';
import PQueue from 'p-queue';
import { openSqliteConnection } from '../ddl/internal/open-sqlite-connection.js';
import {
  commitOverlayThreeWayMerge,
  discardOverlayForRun,
  sealOverlayForRun,
} from './internal/sqlite-topology-commit-ops.js';
import {
  getPartitionsWithOverlay,
  resetOverlayByScope,
  syncPrerequisiteOverlays,
  updateContractInOverlay,
} from './internal/sqlite-topology-overlay-ops.js';

/**
 * WAL-mode SQLite implementation of the `@harness-dsl/core` `TopologyStore` runtime port.
 *
 * Manages canonical base partition contracts alongside per-run Copy-on-Write overlays,
 * stacked prerequisite synchronization, step/run-scoped resets, and 3-way overlay commits.
 */
export class SqliteTopologyStore implements TopologyStore {
  /** Underlying `better-sqlite3` database connection. */
  private readonly db: Database.Database;
  /** Single-concurrency FIFO queue serializing asynchronous store operations. */
  private readonly queue = new PQueue({ concurrency: 1 });

  /**
   * Initializes a `SqliteTopologyStore` against a SQLite file path, `:memory:`, or existing `Database` handle.
   *
   * Applies WAL-mode PRAGMAs and idempotent topology DDL statements on initialization.
   *
   * @param {string | Database.Database} uriOrDb - SQLite database URI or open `better-sqlite3` handle.
   */
  constructor(uriOrDb: string | Database.Database) {
    this.db = openSqliteConnection(uriOrDb);
  }

  /**
   * Loads the partition state map for `runId` (merging any uncommitted per-run CoW overlay over the base store).
   *
   * Pins each partition's initial `baseContractTextAtAcquire` when `runId` first inspects the partition.
   *
   * @param {string} [runId] - Optional active flow run identifier.
   *
   * @returns {Promise<ReadonlyMap<string, TopologyPartitionState>>} Map of `partitionId` to partition state.
   */
  getPartitions(runId?: string): Promise<ReadonlyMap<string, TopologyPartitionState>> {
    return this.queue.add(() => this.db.transaction(() => getPartitionsWithOverlay(this.db, runId))());
  }

  /**
   * Writes a contract update to `runId`'s isolated Copy-on-Write overlay.
   *
   * Increments the partition's overlay epoch at most once per `(runId, partitionId)` unless reset
   * by `resetRunOverlay()`, and tags the mutation with `stepExecId` for step-scoped rollback.
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
    return this.queue.add(() =>
      this.db.transaction(() =>
        updateContractInOverlay(this.db, { runId, partitionId, newContractText, stepExecId }),
      )(),
    );
  }

  /**
   * Merges prerequisite runs' `ACTIVE` or `SEALED_UNMERGED` overlays into `targetRunId`'s overlay.
   *
   * Advances `targetRunId`'s 3-way merge-base text for each absorbed partition so stacked PRs
   * never false-conflict when committed sequentially.
   *
   * @param {string}            targetRunId        - Dependent run absorbing the prerequisite overlays.
   * @param {readonly string[]} prerequisiteRunIds - Prerequisite run identifiers to merge from.
   *
   * @returns {Promise<void>} Resolves once prerequisite overlays are merged.
   */
  syncRunOverlays(targetRunId: string, prerequisiteRunIds: readonly string[]): Promise<void> {
    return this.queue.add(() => {
      this.db.transaction(() => syncPrerequisiteOverlays(this.db, targetRunId, prerequisiteRunIds))();
    });
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
  resetRunOverlay(
    runId: string,
    opts?: { readonly scope?: 'step' | 'run'; readonly stepExecId?: string },
  ): Promise<void> {
    return this.queue.add(() => {
      this.db.transaction(() => resetOverlayByScope(this.db, runId, opts))();
    });
  }

  /**
   * Transitions `runId`'s overlay to `SEALED_UNMERGED` upon flow exit `'done'` when awaiting an external merge signal.
   *
   * Allows dependent stacked runs to absorb the sealed overlay via `syncRunOverlays` without polluting the base store.
   *
   * @param {string} runId - Completed flow run identifier.
   *
   * @returns {Promise<void>} Resolves once the overlay is sealed.
   */
  sealRunOverlay(runId: string): Promise<void> {
    return this.queue.add(() => {
      sealOverlayForRun(this.db, runId);
    });
  }

  /**
   * Atomically commits `runId`'s overlay (and any absorbed ancestor/prerequisite `SEALED_UNMERGED` overlays)
   * to the base store using a 3-way merge against `baseContractTextAtAcquire`.
   *
   * Allocates monotonic base epoch numbers at commit time and returns the committed run IDs and updated epochs.
   *
   * @param {string} runId - Flow run identifier whose changes landed.
   *
   * @returns {Promise<CommitRunOverlayResult>} Committed run IDs and newly allocated base epoch numbers.
   */
  commitRunOverlay(runId: string): Promise<CommitRunOverlayResult> {
    return this.queue.add(() => this.db.transaction(() => commitOverlayThreeWayMerge(this.db, runId))());
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
    return this.queue.add(() => {
      discardOverlayForRun(this.db, runId);
    });
  }

  /**
   * Closes the underlying `better-sqlite3` database connection.
   *
   * Releases file descriptors and WAL shared-memory locks held by this store instance.
   *
   * @returns {void} Returns nothing once the connection is closed.
   */
  close(): void {
    this.db.close();
  }
}
