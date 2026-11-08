import type {
  ContinuationFrame,
  CreateOrResumeRunInput,
  CreateOrResumeRunResult,
  InterruptedStepBootRecord,
  LedgerStore,
  MutateLanePlanRequest,
  RecordStepStartInput,
  RecordStepTransitionInput,
  RunTerminalReceiptRecord,
  SuspendedForkRecord,
  WireFrameRecord,
} from '@metaharness/core';
import PQueue from 'p-queue';
import type { Pool } from 'pg';
import { normalizePostgresClient } from '../ddl/internal/normalize-postgres-client.js';
import {
  ensurePostgresSchemaInitialized,
  runInPostgresTransaction,
} from '../ddl/internal/resolve-postgres-client.js';
import type { PostgresQueryClient } from '../ddl/postgres-query-client.js';
import { compactRunFramesInPg } from './internal/pg-ledger-compaction-ops.js';
import {
  appendMessageFrameInPg,
  getMessageChainFromPg,
  markFrameTombstoneInPg,
  replaceMessageFrameInPg,
} from './internal/pg-ledger-frame-ops.js';
import {
  type GetPgSuspendedForksOptions,
  getSuspendedForksFromPg,
  mutateLanePlanInPg,
  recordForkSuspensionInPg,
  resolveSuspendedForkInPg,
} from './internal/pg-ledger-plan-and-fork-ops.js';
import {
  type UpdatePgRunInputParams,
  createOrResumeRunInPg,
  getRunTerminalReceiptsFromPg,
  recordRunTerminalReceiptInPg,
  updateRunInputInPg,
} from './internal/pg-ledger-run-ops.js';
import {
  getInterruptedStepsOnBootFromPg,
  recordStepStartInPg,
  recordStepTransitionInPg,
  updateContinuationStackInPg,
} from './internal/pg-ledger-step-ops.js';

/**
 * Optional parameters for updating a step's continuation stack in `updateContinuationStack`.
 */
export interface UpdatePgContinuationStackOptions {
  /** Optional updated base scope checkpoint after prerequisite `syncRoot` wakeup. */
  readonly baseScopeCheckpoint?: string;
}

/**
 * PostgreSQL implementation of the `@metaharness/core` `LedgerStore` runtime port.
 *
 * Persists flow runs, step continuation stacks, wire-frame chains, dynamic lane DAG mutations,
 * and suspended fork records inside transactional PostgreSQL tables serialized via `p-queue`.
 */
export class PostgresLedgerStore implements LedgerStore {
  /** Underlying PostgreSQL query client. */
  private readonly client: PostgresQueryClient;
  /** Single-concurrency FIFO queue serializing asynchronous store operations. */
  private readonly queue = new PQueue({ concurrency: 1 });
  /** Lazily memoized schema initialization promise. */
  private initPromise: Promise<PostgresQueryClient> | undefined;

  /**
   * Initializes a `PostgresLedgerStore` backed by a `PostgresQueryClient`, `pg.Pool`, or connection URI string.
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
   * Creates a new flow run row (`status: 'RUNNING'`) or resumes an existing run.
   *
   * Pins `compiledPrefixesJson` on initial creation and returns completed step outputs for `.inputFrom()`.
   *
   * @param {CreateOrResumeRunInput} run - Run initialization or resume request payload.
   *
   * @returns {Promise<CreateOrResumeRunResult>} Current persisted state and completed step outputs.
   */
  createOrResumeRun(run: CreateOrResumeRunInput): Promise<CreateOrResumeRunResult> {
    return this.queue.add(async () =>
      runInPostgresTransaction(await this.ensureReady(), (tx) => createOrResumeRunInPg(tx, run)),
    );
  }

  /**
   * Records the start of a flow step execution and initializes its `ContinuationFrame[]` stack.
   *
   * Persists `baseScopeCheckpoint` and `executableId` for reboot recovery.
   *
   * @param {RecordStepStartInput} step - Step start metadata and initial continuation stack.
   *
   * @returns {Promise<void>} Resolves once the step start is committed.
   */
  recordStepStart(step: RecordStepStartInput): Promise<void> {
    return this.queue.add(async () =>
      runInPostgresTransaction(await this.ensureReady(), (tx) => recordStepStartInPg(tx, step)),
    );
  }

  /**
   * Atomically updates the serialized `ContinuationFrame[]` stack for `stepExecId`.
   *
   * Optionally updates `baseScopeCheckpoint` after prerequisite `syncRoot` wakeup.
   *
   * @param {string}                           runId             - Enclosing flow run identifier.
   * @param {string}                           stepExecId        - Target step execution identifier.
   * @param {readonly ContinuationFrame[]}     continuationStack - Updated outer-to-inner continuation stack.
   * @param {UpdatePgContinuationStackOptions} [opts]            - Optional updated base scope checkpoint.
   *
   * @returns {Promise<void>} Resolves once the continuation stack is persisted.
   */
  updateContinuationStack(
    runId: string,
    stepExecId: string,
    continuationStack: readonly ContinuationFrame[],
    opts?: UpdatePgContinuationStackOptions,
  ): Promise<void> {
    return this.queue.add(async () =>
      updateContinuationStackInPg(await this.ensureReady(), {
        runId,
        stepExecId,
        continuationStack,
        baseScopeCheckpoint: opts?.baseScopeCheckpoint,
      }),
    );
  }

  /**
   * Updates a run's serialized flow input payload and optional pending rewind target step ID.
   *
   * Used during `.replaceWith()` step promotion and `.onSignal().rewindTo()` transitions.
   *
   * @param {string}                 runId  - Target flow run identifier.
   * @param {UpdatePgRunInputParams} update - Updated input JSON and rewind target.
   *
   * @returns {Promise<void>} Resolves once the run input update is committed.
   */
  updateRunInput(runId: string, update: UpdatePgRunInputParams): Promise<void> {
    return this.queue.add(async () => updateRunInputInPg(await this.ensureReady(), runId, update));
  }

  /**
   * Atomically chains spawned prerequisite items and validates DAG acyclicity and `maxPrerequisiteDepth`.
   *
   * Rejects cycles and depth limit breaches before committing any edge to PostgreSQL.
   *
   * @param {MutateLanePlanRequest} req - Lane plan mutation request.
   *
   * @returns {Promise<void>} Resolves once the lane DAG mutation is committed.
   */
  mutateLanePlan(req: MutateLanePlanRequest): Promise<void> {
    return this.queue.add(async () =>
      runInPostgresTransaction(await this.ensureReady(), (tx) => mutateLanePlanInPg(tx, req)),
    );
  }

  /**
   * Appends a new `WireFrameRecord` to the conversation transcript for `runId`.
   *
   * Persists both raw vendor wire bytes and canonical message projections.
   *
   * @param {string}          runId - Enclosing flow run identifier.
   * @param {WireFrameRecord} frame - Immutable wire frame record to append.
   *
   * @returns {Promise<void>} Resolves once the frame is persisted.
   */
  appendMessageFrame(runId: string, frame: WireFrameRecord): Promise<void> {
    return this.queue.add(async () =>
      appendMessageFrameInPg(await this.ensureReady(), runId, frame),
    );
  }

  /**
   * Replaces an existing `WireFrameRecord` in-place (such as after `appendToolResultNotes`).
   *
   * Updates `rawWireFrame` and `canonical` while preserving `messageId` and `parentMessageId`.
   *
   * @param {string}          runId - Enclosing flow run identifier.
   * @param {WireFrameRecord} frame - Updated wire frame record.
   *
   * @returns {Promise<void>} Resolves once the frame replacement is committed.
   */
  replaceMessageFrame(runId: string, frame: WireFrameRecord): Promise<void> {
    return this.queue.add(async () =>
      replaceMessageFrameInPg(await this.ensureReady(), runId, frame),
    );
  }

  /**
   * Records a per-`callId` compacted skill tombstone on an earlier `activateSkill` message frame.
   *
   * Updates `compactedTombstones[callId]` without mutating `rawWireFrame`.
   *
   * @param {string} runId              - Enclosing flow run identifier.
   * @param {string} messageId          - Target `WireFrameRecord.messageId`.
   * @param {string} callId             - Tool call ID of the `activateSkill` invocation.
   * @param {string} compactedTombstone - Tombstone replacement string for cross-model escalations.
   *
   * @returns {Promise<void>} Resolves once the tombstone entry is recorded.
   */
  markFrameTombstone(
    runId: string,
    messageId: string,
    callId: string,
    compactedTombstone: string,
  ): Promise<void> {
    return this.queue.add(async () =>
      runInPostgresTransaction(await this.ensureReady(), (tx) =>
        markFrameTombstoneInPg(tx, {
          runId,
          messageId,
          callId,
          compactedTombstone,
        }),
      ),
    );
  }

  /**
   * Reconstructs the ordered `WireFrameRecord[]` ancestor chain from Turn 0 through `leafMessageId`.
   *
   * Traverses `parentMessageId` links and returns frames in chronological root-to-leaf order.
   *
   * @param {string} leafMessageId - Identifier of the trailing message frame in the chain.
   *
   * @returns {Promise<readonly WireFrameRecord[]>} Ordered root-to-leaf wire frame sequence.
   */
  getMessageChain(leafMessageId: string): Promise<readonly WireFrameRecord[]> {
    return this.queue.add(async () =>
      getMessageChainFromPg(await this.ensureReady(), leafMessageId),
    );
  }

  /**
   * Persists a `SuspendedForkRecord` when a child fork suspends on an upward or sibling interrupt.
   *
   * Stores the monotonic `suspendedForkId` (`${forkId}#${suspensionEpoch}`) and continuation stack.
   *
   * @param {SuspendedForkRecord} record - Suspended fork snapshot and continuation stack.
   *
   * @returns {Promise<void>} Resolves once the suspension record is persisted.
   */
  recordForkSuspension(record: SuspendedForkRecord): Promise<void> {
    return this.queue.add(async () => recordForkSuspensionInPg(await this.ensureReady(), record));
  }

  /**
   * Queries unresolved suspended fork records for `runId`, optionally filtered by `forkIds` or `parentStepExecId`.
   *
   * Excludes epochs already marked `'RESUMED'` or `'ABORTED'`.
   *
   * @param {string}                     runId  - Enclosing flow run identifier.
   * @param {GetPgSuspendedForksOptions} [opts] - Optional filter criteria.
   *
   * @returns {Promise<readonly SuspendedForkRecord[]>} Matching open suspended fork records.
   */
  getSuspendedForks(
    runId: string,
    opts?: GetPgSuspendedForksOptions,
  ): Promise<readonly SuspendedForkRecord[]> {
    return this.queue.add(async () =>
      getSuspendedForksFromPg(await this.ensureReady(), runId, opts),
    );
  }

  /**
   * Marks `suspendedForkId` and any earlier unresolved epochs `${forkId}#1 .. ${forkId}#${epoch}` as resolved.
   *
   * Prevents resolved suspension epochs from remaining open in subsequent queries.
   *
   * @param {string}                suspendedForkId - Monotonic `${forkId}#${suspensionEpoch}` identifier.
   * @param {'RESUMED' | 'ABORTED'} status          - Resolution status.
   *
   * @returns {Promise<void>} Resolves once the status transition is committed.
   */
  resolveSuspendedFork(suspendedForkId: string, status: 'RESUMED' | 'ABORTED'): Promise<void> {
    return this.queue.add(async () =>
      runInPostgresTransaction(await this.ensureReady(), (tx) =>
        resolveSuspendedForkInPg(tx, suspendedForkId, status),
      ),
    );
  }

  /**
   * Records a step lifecycle transition (`'RUNNING' | 'COMPLETED' | 'INTERRUPTED' | 'FAILED' | 'SUSPENDED'`).
   *
   * Commits serialized output, scope checkpoints, and universal step telemetry.
   *
   * @param {RecordStepTransitionInput} transition - Step transition payload and telemetry snapshot.
   *
   * @returns {Promise<void>} Resolves once the step transition is persisted.
   */
  recordStepTransition(transition: RecordStepTransitionInput): Promise<void> {
    return this.queue.add(async () =>
      runInPostgresTransaction(await this.ensureReady(), (tx) =>
        recordStepTransitionInPg(tx, transition),
      ),
    );
  }

  /**
   * Persists the terminal exit state and final scope receipt for `runId` and `itemKey`.
   *
   * Updates both `harness_terminal_receipts` and `harness_runs`.
   *
   * @param {string} runId              - Completed flow run identifier.
   * @param {string} itemKey            - Work item deduplication key.
   * @param {string} terminalState      - Terminal exit state string.
   * @param {string} [scopeReceiptJson] - Optional JSON-serialized final scope receipt.
   *
   * @returns {Promise<void>} Resolves once the terminal receipt is committed.
   */
  recordRunTerminalReceipt(
    runId: string,
    itemKey: string,
    terminalState: string,
    scopeReceiptJson?: string,
  ): Promise<void> {
    return this.queue.add(async () =>
      runInPostgresTransaction(await this.ensureReady(), (tx) =>
        recordRunTerminalReceiptInPg(tx, {
          runId,
          itemKey,
          terminalState,
          scopeReceiptJson,
        }),
      ),
    );
  }

  /**
   * Retrieves the latest terminal run receipts keyed by `itemKey`.
   *
   * Used during prerequisite `syncRoot` wakeup and signal-correlated overlay commits.
   *
   * @param {readonly string[]} itemKeys - Work item keys to look up.
   *
   * @returns {Promise<ReadonlyMap<string, RunTerminalReceiptRecord>>} Map of `itemKey` to terminal receipt record.
   */
  getRunTerminalReceipts(
    itemKeys: readonly string[],
  ): Promise<ReadonlyMap<string, RunTerminalReceiptRecord>> {
    return this.queue.add(async () =>
      getRunTerminalReceiptsFromPg(await this.ensureReady(), itemKeys),
    );
  }

  /**
   * Queries all non-terminal runs (`'QUEUED' | 'RUNNING' | 'WAITING' | 'SUSPENDED'`) on runtime startup.
   *
   * Returns active step checkpoints and continuation stacks for reboot crash recovery.
   *
   * @returns {Promise<readonly InterruptedStepBootRecord[]>} Non-terminal runs requiring recovery.
   */
  getInterruptedStepsOnBoot(): Promise<readonly InterruptedStepBootRecord[]> {
    return this.queue.add(async () => getInterruptedStepsOnBootFromPg(await this.ensureReady()));
  }

  /**
   * Prunes raw `WireFrameRecord` payloads for a terminal `runId` while retaining canonical audit headers.
   *
   * Scoped strictly to `runId` so active runs sharing the same `itemKey` are never pruned.
   *
   * @param {string} runId - Terminal flow run identifier to compact.
   *
   * @returns {Promise<void>} Resolves once wire frames for `runId` are compacted.
   */
  compactRunFrames(runId: string): Promise<void> {
    return this.queue.add(async () =>
      runInPostgresTransaction(await this.ensureReady(), (tx) => compactRunFramesInPg(tx, runId)),
    );
  }
}
