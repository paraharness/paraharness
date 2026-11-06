import type { ContinuationFrame, CreateOrResumeRunInput, CreateOrResumeRunResult, InterruptedStepBootRecord, LedgerStore, MutateLanePlanRequest, RecordStepStartInput, RecordStepTransitionInput, RunTerminalReceiptRecord, SuspendedForkRecord, WireFrameRecord } from '@harness-dsl/core';
import type Database from 'better-sqlite3';
import { openSqliteConnection } from '../ddl/internal/open-sqlite-connection.js';
import { compactRunFramesInSqlite } from './internal/sqlite-ledger-compaction-ops.js';
import { appendMessageFrameInSqlite, getMessageChainFromSqlite, markFrameTombstoneInSqlite, replaceMessageFrameInSqlite } from './internal/sqlite-ledger-frame-ops.js';
import { getSuspendedForksFromSqlite, mutateLanePlanInSqlite, recordForkSuspensionInSqlite, resolveSuspendedForkInSqlite } from './internal/sqlite-ledger-plan-and-fork-ops.js';
import { createOrResumeRunInSqlite, getRunTerminalReceiptsFromSqlite, recordRunTerminalReceiptInSqlite, updateRunInputInSqlite } from './internal/sqlite-ledger-run-ops.js';
import { getInterruptedStepsOnBootFromSqlite, recordStepStartInSqlite, recordStepTransitionInSqlite, updateContinuationStackInSqlite } from './internal/sqlite-ledger-step-ops.js';

/**
 * WAL-mode SQLite implementation of the `@harness-dsl/core` `LedgerStore` runtime port.
 *
 * Persists flow runs, step continuation stacks, wire-frame chains, dynamic lane DAG mutations,
 * and suspended fork records inside transactional SQLite tables.
 */
export class SqliteLedgerStore implements LedgerStore {
  /** Underlying `better-sqlite3` database connection. */
  private readonly db: Database.Database;
  /**
   * Initializes a `SqliteLedgerStore` against a SQLite file path, `:memory:`, or existing `Database` instance.
   *
   * Applies WAL-mode PRAGMAs and idempotent ledger DDL statements on initialization.
   * @param {string | Database.Database} uriOrDb - SQLite database URI or open `better-sqlite3` handle.
   */
  constructor(uriOrDb: string | Database.Database) {
    this.db = openSqliteConnection(uriOrDb);
  }
  /**
   * Creates a new flow run row (`status: 'RUNNING'`) or resumes an existing run.
   *
   * Pins `compiledPrefixesJson` on initial creation and returns completed step outputs for `.inputFrom()`.
   * @param {CreateOrResumeRunInput} run - Run initialization or resume request payload.
   * @returns {Promise<CreateOrResumeRunResult>} Current persisted state and completed step outputs.
   */
  createOrResumeRun(run: CreateOrResumeRunInput): Promise<CreateOrResumeRunResult> {
    return Promise.resolve(this.db.transaction(() => createOrResumeRunInSqlite(this.db, run))());
  }
  /**
   * Records the start of a flow step execution and initializes its `ContinuationFrame[]` stack.
   *
   * Persists `baseScopeCheckpoint` and `executableId` for reboot recovery.
   * @param {RecordStepStartInput} step - Step start metadata and initial continuation stack.
   * @returns {Promise<void>} Resolves once the step start is committed.
   */
  recordStepStart(step: RecordStepStartInput): Promise<void> {
    this.db.transaction(() => recordStepStartInSqlite(this.db, step))();
    return Promise.resolve();
  }
  /**
   * Atomically updates the serialized `ContinuationFrame[]` stack for `stepExecId`.
   *
   * Optionally updates `baseScopeCheckpoint` after prerequisite `syncRoot` wakeup.
   * @param {string}                                    runId             - Enclosing flow run identifier.
   * @param {string}                                    stepExecId        - Target step execution identifier.
   * @param {readonly ContinuationFrame[]}              continuationStack - Updated outer-to-inner continuation stack.
   * @param {{ readonly baseScopeCheckpoint?: string }} [opts]            - Optional updated base scope checkpoint.
   * @returns {Promise<void>} Resolves once the continuation stack is persisted.
   */
  updateContinuationStack(runId: string, stepExecId: string, continuationStack: readonly ContinuationFrame[], opts?: { readonly baseScopeCheckpoint?: string }): Promise<void> {
    updateContinuationStackInSqlite(this.db, { runId, stepExecId, continuationStack, baseScopeCheckpoint: opts?.baseScopeCheckpoint });
    return Promise.resolve();
  }
  /**
   * Updates a run's serialized flow input payload and optional pending rewind target step ID.
   *
   * Used during `.replaceWith()` step promotion and `.onSignal().rewindTo()` transitions.
   * @param {string}                                                                         runId  - Target flow run identifier.
   * @param {{ readonly inputJson: string; readonly rewindPendingToStepId?: string | null }} update - Updated input JSON and rewind target.
   * @returns {Promise<void>} Resolves once the run input update is committed.
   */
  updateRunInput(runId: string, update: { readonly inputJson: string; readonly rewindPendingToStepId?: string | null }): Promise<void> {
    updateRunInputInSqlite(this.db, runId, update);
    return Promise.resolve();
  }
  /**
   * Atomically chains spawned prerequisite items and validates DAG acyclicity and `maxPrerequisiteDepth`.
   *
   * Rejects cycles and depth limit breaches before committing any edge to SQLite.
   * @param {MutateLanePlanRequest} req - Lane plan mutation request.
   * @returns {Promise<void>} Resolves once the lane DAG mutation is committed.
   */
  mutateLanePlan(req: MutateLanePlanRequest): Promise<void> {
    try {
      this.db.transaction(() => mutateLanePlanInSqlite(this.db, req))();
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }
  /**
   * Appends a new `WireFrameRecord` to the conversation transcript for `runId`.
   *
   * Persists both raw vendor wire bytes and canonical message projections.
   * @param {string}          runId - Enclosing flow run identifier.
   * @param {WireFrameRecord} frame - Immutable wire frame record to append.
   * @returns {Promise<void>} Resolves once the frame is persisted.
   */
  appendMessageFrame(runId: string, frame: WireFrameRecord): Promise<void> {
    appendMessageFrameInSqlite(this.db, runId, frame);
    return Promise.resolve();
  }
  /**
   * Replaces an existing `WireFrameRecord` in-place (such as after `appendToolResultNotes`).
   *
   * Updates `rawWireFrame` and `canonical` while preserving `messageId` and `parentMessageId`.
   * @param {string}          runId - Enclosing flow run identifier.
   * @param {WireFrameRecord} frame - Updated wire frame record.
   * @returns {Promise<void>} Resolves once the frame replacement is committed.
   */
  replaceMessageFrame(runId: string, frame: WireFrameRecord): Promise<void> {
    replaceMessageFrameInSqlite(this.db, runId, frame);
    return Promise.resolve();
  }
  /**
   * Records a per-`callId` compacted skill tombstone on an earlier `activateSkill` message frame.
   *
   * Updates `compactedTombstones[callId]` without mutating `rawWireFrame`.
   * @param {string} runId              - Enclosing flow run identifier.
   * @param {string} messageId          - Target `WireFrameRecord.messageId`.
   * @param {string} callId             - Tool call ID of the `activateSkill` invocation.
   * @param {string} compactedTombstone - Tombstone replacement string for cross-model escalations.
   * @returns {Promise<void>} Resolves once the tombstone entry is recorded.
   */
  markFrameTombstone(runId: string, messageId: string, callId: string, compactedTombstone: string): Promise<void> {
    markFrameTombstoneInSqlite(this.db, { runId, messageId, callId, compactedTombstone });
    return Promise.resolve();
  }
  /**
   * Reconstructs the ordered `WireFrameRecord[]` ancestor chain from Turn 0 through `leafMessageId`.
   *
   * Traverses `parentMessageId` links and returns frames in chronological root-to-leaf order.
   * @param {string} leafMessageId - Identifier of the trailing message frame in the chain.
   * @returns {Promise<readonly WireFrameRecord[]>} Ordered root-to-leaf wire frame sequence.
   */
  getMessageChain(leafMessageId: string): Promise<readonly WireFrameRecord[]> {
    return Promise.resolve(getMessageChainFromSqlite(this.db, leafMessageId));
  }
  /**
   * Persists a `SuspendedForkRecord` when a child fork suspends on an upward or sibling interrupt.
   *
   * Stores the monotonic `suspendedForkId` (`${forkId}#${suspensionEpoch}`) and continuation stack.
   * @param {SuspendedForkRecord} record - Suspended fork snapshot and continuation stack.
   * @returns {Promise<void>} Resolves once the suspension record is persisted.
   */
  recordForkSuspension(record: SuspendedForkRecord): Promise<void> {
    recordForkSuspensionInSqlite(this.db, record);
    return Promise.resolve();
  }
  /**
   * Queries unresolved suspended fork records for `runId`, optionally filtered by `forkIds` or `parentStepExecId`.
   *
   * Excludes epochs already marked `'RESUMED'` or `'ABORTED'`.
   * @param {string}                                                                       runId  - Enclosing flow run identifier.
   * @param {{ readonly forkIds?: readonly string[]; readonly parentStepExecId?: string }} [opts] - Optional filter criteria.
   * @returns {Promise<readonly SuspendedForkRecord[]>} Matching open suspended fork records.
   */
  getSuspendedForks(runId: string, opts?: { readonly forkIds?: readonly string[]; readonly parentStepExecId?: string }): Promise<readonly SuspendedForkRecord[]> {
    return Promise.resolve(getSuspendedForksFromSqlite(this.db, runId, opts));
  }
  /**
   * Marks `suspendedForkId` and any earlier unresolved epochs `${forkId}#1 .. ${forkId}#${epoch}` as resolved.
   *
   * Prevents resolved suspension epochs from remaining open in subsequent queries.
   * @param {string}                suspendedForkId - Monotonic `${forkId}#${suspensionEpoch}` identifier.
   * @param {'RESUMED' | 'ABORTED'} status          - Resolution status.
   * @returns {Promise<void>} Resolves once the status transition is committed.
   */
  resolveSuspendedFork(suspendedForkId: string, status: 'RESUMED' | 'ABORTED'): Promise<void> {
    this.db.transaction(() => resolveSuspendedForkInSqlite(this.db, suspendedForkId, status))();
    return Promise.resolve();
  }
  /**
   * Records a step lifecycle transition (`'RUNNING' | 'COMPLETED' | 'INTERRUPTED' | 'FAILED' | 'SUSPENDED'`).
   *
   * Commits serialized output, scope checkpoints, and universal step telemetry.
   * @param {RecordStepTransitionInput} transition - Step transition payload and telemetry snapshot.
   * @returns {Promise<void>} Resolves once the step transition is persisted.
   */
  recordStepTransition(transition: RecordStepTransitionInput): Promise<void> {
    this.db.transaction(() => recordStepTransitionInSqlite(this.db, transition))();
    return Promise.resolve();
  }
  /**
   * Persists the terminal exit state and final scope receipt for `runId` and `itemKey`.
   *
   * Updates both `harness_terminal_receipts` and `harness_runs`.
   * @param {string} runId              - Completed flow run identifier.
   * @param {string} itemKey            - Work item deduplication key.
   * @param {string} terminalState      - Terminal exit state string.
   * @param {string} [scopeReceiptJson] - Optional JSON-serialized final scope receipt.
   * @returns {Promise<void>} Resolves once the terminal receipt is committed.
   */
  recordRunTerminalReceipt(runId: string, itemKey: string, terminalState: string, scopeReceiptJson?: string): Promise<void> {
    this.db.transaction(() => recordRunTerminalReceiptInSqlite(this.db, { runId, itemKey, terminalState, scopeReceiptJson }))();
    return Promise.resolve();
  }
  /**
   * Retrieves the latest terminal run receipts keyed by `itemKey`.
   *
   * Used during prerequisite `syncRoot` wakeup and signal-correlated overlay commits.
   * @param {readonly string[]} itemKeys - Work item keys to look up.
   * @returns {Promise<ReadonlyMap<string, RunTerminalReceiptRecord>>} Map of `itemKey` to terminal receipt record.
   */
  getRunTerminalReceipts(itemKeys: readonly string[]): Promise<ReadonlyMap<string, RunTerminalReceiptRecord>> {
    return Promise.resolve(getRunTerminalReceiptsFromSqlite(this.db, itemKeys));
  }
  /**
   * Queries all non-terminal runs (`'QUEUED' | 'RUNNING' | 'WAITING' | 'SUSPENDED'`) on runtime startup.
   *
   * Returns active step checkpoints and continuation stacks for reboot crash recovery.
   * @returns {Promise<readonly InterruptedStepBootRecord[]>} Non-terminal runs requiring recovery.
   */
  getInterruptedStepsOnBoot(): Promise<readonly InterruptedStepBootRecord[]> {
    return Promise.resolve(getInterruptedStepsOnBootFromSqlite(this.db));
  }
  /**
   * Prunes raw `WireFrameRecord` payloads for a terminal `runId` while retaining canonical audit headers.
   *
   * Scoped strictly to `runId` so active runs sharing the same `itemKey` are never pruned.
   * @param {string} runId - Terminal flow run identifier to compact.
   * @returns {Promise<void>} Resolves once wire frames for `runId` are compacted.
   */
  compactRunFrames(runId: string): Promise<void> {
    this.db.transaction(() => compactRunFramesInSqlite(this.db, runId))();
    return Promise.resolve();
  }
  /**
   * Closes the underlying `better-sqlite3` database connection.
   *
   * Releases file descriptors and WAL shared-memory locks held by this store instance.
   * @returns {void} Returns nothing once the connection is closed.
   */
  close(): void {
    this.db.close();
  }
}
