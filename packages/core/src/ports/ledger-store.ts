import type { ContinuationFrame } from './continuation-frame.types.js';
import type { CreateOrResumeRunInput } from './create-or-resume-run-input.js';
import type { CreateOrResumeRunResult } from './create-or-resume-run-result.js';
import type { InterruptedStepBootRecord } from './interrupted-step-boot-record.js';
import type { MutateLanePlanRequest } from './mutate-lane-plan-request.js';
import type { RecordStepStartInput } from './record-step-start-input.js';
import type { RecordStepTransitionInput } from './record-step-transition-input.js';
import type { RunTerminalReceiptRecord } from './run-terminal-receipt-record.js';
import type { SuspendedForkRecord } from './suspended-fork-record.js';
import type { WireFrameRecord } from './wire-frame-record.js';

/**
 * Durable runtime storage port for flow runs, continuation call stacks, wire frames,
 * suspended child forks, and lane DAG mutations.
 *
 * Always resolves file or database paths against the immutable host process root (Invariant 5).
 */
export interface LedgerStore {
  /**
   * Creates a new flow run record or resumes an existing run for `run.runId`.
   *
   * Pins `compiledPrefixesJson` on initial creation and returns the latest persisted status and step outputs.
   *
   * @param {CreateOrResumeRunInput} run - Run initialization and pinned wire prefix payload.
   *
   * @returns {Promise<CreateOrResumeRunResult>} Current persisted state and completed step outputs for the run.
   */
  createOrResumeRun(run: CreateOrResumeRunInput): Promise<CreateOrResumeRunResult>;

  /**
   * Records the start of a flow step execution and initializes its `ContinuationFrame[]` stack.
   *
   * Persists the initial `baseScopeCheckpoint` and `executableId` so crash recovery can rebind the step.
   *
   * @param {RecordStepStartInput} step - Step execution metadata and initial continuation stack.
   *
   * @returns {Promise<void>} Resolves once the step start is durably committed.
   */
  recordStepStart(step: RecordStepStartInput): Promise<void>;

  /**
   * Atomically updates the serialized `ContinuationFrame[]` stack for `stepExecId`.
   *
   * Serialized per `stepExecId` by the runtime to preserve active leases, skill state, and child fork frames.
   *
   * @param {string}                                    runId             - Enclosing flow run identifier.
   * @param {string}                                    stepExecId        - Target step execution identifier.
   * @param {readonly ContinuationFrame[]}              continuationStack - Updated outer-to-inner continuation stack.
   * @param {{ readonly baseScopeCheckpoint?: string }} [opts]            - Optional updated base scope checkpoint.
   *
   * @returns {Promise<void>} Resolves once the continuation stack is persisted.
   */
  updateContinuationStack(runId: string, stepExecId: string, continuationStack: readonly ContinuationFrame[], opts?: { readonly baseScopeCheckpoint?: string }): Promise<void>;

  /**
   * Updates a run's serialized flow input payload and optional pending rewind target step ID.
   *
   * Used during `.replaceWith()` step promotion and `.onSignal().rewindTo()` transitions.
   *
   * @param {string}                                                                         runId  - Target flow run identifier.
   * @param {{ readonly inputJson: string; readonly rewindPendingToStepId?: string | null }} update - Updated input JSON and rewind target.
   *
   * @returns {Promise<void>} Resolves once the run input update is committed.
   */
  updateRunInput(runId: string, update: { readonly inputJson: string; readonly rewindPendingToStepId?: string | null }): Promise<void>;

  /**
   * Atomically validates DAG acyclicity and `maxPrerequisiteDepth` and enqueues spawned prerequisite items or dependencies.
   *
   * Rejects cycles or depth violations before mutating the lane work queue.
   *
   * @param {MutateLanePlanRequest} req - Lane plan mutation request.
   *
   * @returns {Promise<void>} Resolves once the lane DAG mutation is committed.
   */
  mutateLanePlan(req: MutateLanePlanRequest): Promise<void>;

  /**
   * Appends a new `WireFrameRecord` to the conversation transcript for `runId`.
   *
   * Stores both the raw vendor wire bytes and canonical projection keyed by `frame.messageId`.
   *
   * @param {string}          runId - Enclosing flow run identifier.
   * @param {WireFrameRecord} frame - Immutable wire frame record to append.
   *
   * @returns {Promise<void>} Resolves once the frame is persisted.
   */
  appendMessageFrame(runId: string, frame: WireFrameRecord): Promise<void>;

  /**
   * Replaces an existing `WireFrameRecord` in-place (such as after `ModelDriver.appendToolResultNotes()`).
   *
   * Preserves `messageId` and `parentMessageId` chain links while updating `rawWireFrame` and `canonical`.
   *
   * @param {string}          runId - Enclosing flow run identifier.
   * @param {WireFrameRecord} frame - Updated wire frame record with matching `messageId`.
   *
   * @returns {Promise<void>} Resolves once the frame replacement is committed.
   */
  replaceMessageFrame(runId: string, frame: WireFrameRecord): Promise<void>;

  /**
   * Records a per-`callId` compacted skill tombstone on an earlier `activateSkill` message frame.
   *
   * Substituted only when `ModelDriver.prepareFork()` escalates across distinct models (`substituteTombstones: true`).
   *
   * @param {string} runId              - Enclosing flow run identifier.
   * @param {string} messageId          - Target `WireFrameRecord.messageId`.
   * @param {string} callId             - Tool call ID of the `activateSkill` invocation.
   * @param {string} compactedTombstone - Tombstone replacement string used on cross-model escalations.
   *
   * @returns {Promise<void>} Resolves once the tombstone entry is recorded.
   */
  markFrameTombstone(runId: string, messageId: string, callId: string, compactedTombstone: string): Promise<void>;

  /**
   * Reconstructs the ordered `WireFrameRecord[]` ancestor chain from Turn 0 through `leafMessageId`.
   *
   * Traverses `parentMessageId` links to return the root-to-leaf conversation history.
   *
   * @param {string} leafMessageId - Identifier of the trailing message frame in the chain.
   *
   * @returns {Promise<readonly WireFrameRecord[]>} Ordered root-to-leaf wire frame sequence.
   */
  getMessageChain(leafMessageId: string): Promise<readonly WireFrameRecord[]>;

  /**
   * Persists a `SuspendedForkRecord` when a child fork suspends on an upward or sibling interrupt.
   *
   * Captures the monotonic `suspendedForkId` epoch, child scope checkpoint, and nested continuation stack.
   *
   * @param {SuspendedForkRecord} record - Suspended fork snapshot and continuation stack.
   *
   * @returns {Promise<void>} Resolves once the suspension record is persisted.
   */
  recordForkSuspension(record: SuspendedForkRecord): Promise<void>;

  /**
   * Queries open (`'SUSPENDED'`) fork records for `runId`, optionally filtered by `forkIds` or `parentStepExecId`.
   *
   * Returns only unresolved suspension epochs awaiting `resumeFork` resolution.
   *
   * @param {string}                                                                       runId  - Enclosing flow run identifier.
   * @param {{ readonly forkIds?: readonly string[]; readonly parentStepExecId?: string }} [opts] - Optional filter criteria.
   *
   * @returns {Promise<readonly SuspendedForkRecord[]>} Matching open suspended fork records.
   */
  getSuspendedForks(runId: string, opts?: { readonly forkIds?: readonly string[]; readonly parentStepExecId?: string }): Promise<readonly SuspendedForkRecord[]>;

  /**
   * Marks a previously suspended fork epoch as `'RESUMED'` or `'ABORTED'`.
   *
   * Prevents a resolved `suspendedForkId` epoch from being replayed more than once.
   *
   * @param {string}                suspendedForkId - Monotonic `${forkId}#${suspensionEpoch}` identifier.
   * @param {'RESUMED' | 'ABORTED'} status          - Resolution status.
   *
   * @returns {Promise<void>} Resolves once the status transition is committed.
   */
  resolveSuspendedFork(suspendedForkId: string, status: 'RESUMED' | 'ABORTED'): Promise<void>;

  /**
   * Records a step lifecycle transition (`'RUNNING' | 'COMPLETED' | 'INTERRUPTED' | 'FAILED' | 'SUSPENDED'`).
   *
   * Commits the step's serialized output, scope checkpoints, and universal telemetry snapshot.
   *
   * @param {RecordStepTransitionInput} transition - Step transition payload and telemetry snapshot.
   *
   * @returns {Promise<void>} Resolves once the step transition is persisted.
   */
  recordStepTransition(transition: RecordStepTransitionInput): Promise<void>;

  /**
   * Persists the terminal exit state and final scope receipt for `runId` and `itemKey`.
   *
   * Enables dependent runs to inspect prerequisite terminal receipts during `syncRoot` wakeup.
   *
   * @param {string} runId              - Completed flow run identifier.
   * @param {string} itemKey            - Work item deduplication key.
   * @param {string} terminalState      - Terminal exit state string.
   * @param {string} [scopeReceiptJson] - Optional JSON-serialized final scope receipt.
   *
   * @returns {Promise<void>} Resolves once the terminal receipt is committed.
   */
  recordRunTerminalReceipt(runId: string, itemKey: string, terminalState: string, scopeReceiptJson?: string): Promise<void>;

  /**
   * Retrieves the latest terminal run receipts keyed by `itemKey`.
   *
   * Used by the scheduler and prerequisite barrier to verify prerequisite completion and gather receipts.
   *
   * @param {readonly string[]} itemKeys - Work item keys to look up.
   *
   * @returns {Promise<ReadonlyMap<string, RunTerminalReceiptRecord>>} Map of `itemKey` to terminal receipt record.
   */
  getRunTerminalReceipts(itemKeys: readonly string[]): Promise<ReadonlyMap<string, RunTerminalReceiptRecord>>;

  /**
   * Queries all non-terminal runs (`'QUEUED' | 'RUNNING' | 'WAITING' | 'SUSPENDED'`) on runtime startup.
   *
   * Includes both mid-step runs and runs that crashed between steps where `stepExecId` is `null`.
   *
   * @returns {Promise<readonly InterruptedStepBootRecord[]>} Non-terminal runs requiring crash recovery or scheduling.
   */
  getInterruptedStepsOnBoot(): Promise<readonly InterruptedStepBootRecord[]>;

  /**
   * Prunes raw `WireFrameRecord` payloads for a terminal `runId` while retaining run receipts and telemetry.
   *
   * Scoped strictly to `runId` so compaction never prunes frames of a newer run for the same `itemKey`.
   *
   * @param {string} runId - Terminal flow run identifier to compact.
   *
   * @returns {Promise<void>} Resolves once wire frames for `runId` are compacted.
   */
  compactRunFrames(runId: string): Promise<void>;
}
