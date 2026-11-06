import type { InterruptedStepBootRecord } from '../../../src/ports/interrupted-step-boot-record.js';
import type { RunTerminalReceiptRecord } from '../../../src/ports/run-terminal-receipt-record.js';
import type { SuspendedForkRecord } from '../../../src/ports/suspended-fork-record.js';
import type { WireFrameRecord } from '../../../src/ports/wire-frame-record.js';
import type { InMemoryLedgerStore } from '../in-memory-ledger-store.js';

/**
 * Reconstructs the root-to-leaf `WireFrameRecord[]` chain ending at `leafMessageId` in `store`.
 *
 * Walks `parentMessageId` pointers backward and reverses the collected list.
 *
 * @param {InMemoryLedgerStore} store         - Target in-memory ledger store.
 * @param {string}              leafMessageId - Trailing message frame ID.
 *
 * @returns {readonly WireFrameRecord[]} Ordered root-to-leaf wire frame chain.
 */
export function queryMessageChain(store: InMemoryLedgerStore, leafMessageId: string): readonly WireFrameRecord[] {
  const chain: WireFrameRecord[] = [];
  let cursor: string | null = leafMessageId;
  while (cursor !== null) {
    const frame = store.frames.get(cursor);
    if (frame === undefined) {
      break;
    }
    chain.unshift(frame);
    cursor = frame.parentMessageId;
  }
  return Object.freeze(chain);
}

/**
 * Queries open (`'SUSPENDED'`) fork records for `runId` in `store`.
 *
 * Filters by `opts.forkIds` and `opts.parentStepExecId` when provided.
 *
 * @param {InMemoryLedgerStore}                                                          store  - Target in-memory ledger store.
 * @param {string}                                                                       runId  - Enclosing flow run identifier.
 * @param {{ readonly forkIds?: readonly string[]; readonly parentStepExecId?: string }} [opts] - Optional filter criteria.
 *
 * @returns {readonly SuspendedForkRecord[]} Matching open suspended fork records.
 */
export function querySuspendedForks(
  store: InMemoryLedgerStore,
  runId: string,
  opts?: { readonly forkIds?: readonly string[]; readonly parentStepExecId?: string },
): readonly SuspendedForkRecord[] {
  const matches: SuspendedForkRecord[] = [];
  for (const rec of store.suspendedForks.values()) {
    const matchesFork = opts?.forkIds === undefined || opts.forkIds.includes(rec.forkId) || opts.forkIds.includes(rec.suspendedForkId);
    const matchesParent = opts?.parentStepExecId === undefined || rec.parentStepExecId === opts.parentStepExecId;
    if (rec.runId === runId && !store.resolvedSuspendedForks.has(rec.suspendedForkId) && matchesFork && matchesParent) {
      matches.push(rec);
    }
  }
  return Object.freeze(matches);
}

/**
 * Retrieves terminal run receipts keyed by `itemKey` from `store`.
 *
 * Returns a read-only map of matching receipts.
 *
 * @param {InMemoryLedgerStore} store    - Target in-memory ledger store.
 * @param {readonly string[]}   itemKeys - Work item keys to look up.
 *
 * @returns {ReadonlyMap<string, RunTerminalReceiptRecord>} Map of `itemKey` to terminal receipt record.
 */
export function queryTerminalReceipts(
  store: InMemoryLedgerStore,
  itemKeys: readonly string[],
): ReadonlyMap<string, RunTerminalReceiptRecord> {
  const out = new Map<string, RunTerminalReceiptRecord>();
  for (const key of itemKeys) {
    const receipt = store.terminalReceipts.get(key);
    if (receipt !== undefined) {
      out.set(key, receipt);
    }
  }
  return out;
}

/**
 * Queries all non-terminal runs on boot from `store`.
 *
 * Returns `InterruptedStepBootRecord` entries for steps in `'RUNNING'` or `'SUSPENDED'`.
 *
 * @param {InMemoryLedgerStore} store - Target in-memory ledger store.
 *
 * @returns {readonly InterruptedStepBootRecord[]} Non-terminal boot records.
 */
export function queryInterruptedStepsOnBoot(store: InMemoryLedgerStore): readonly InterruptedStepBootRecord[] {
  const out: InterruptedStepBootRecord[] = [];
  for (const step of store.steps.values()) {
    if (step.status === 'RUNNING' || step.status === 'SUSPENDED') {
      const run = store.runs.get(step.runId);
      out.push(
        Object.freeze<InterruptedStepBootRecord>({
          runId: step.runId,
          laneId: run?.laneId ?? 'lane',
          itemKey: run?.itemKey ?? step.runId,
          inputJson: run?.inputJson ?? '{}',
          status: step.status as 'RUNNING' | 'SUSPENDED',
          dependsOn: Object.freeze([...(run?.dependsOn ?? [])]),
          stepExecId: step.stepExecId,
          stepId: step.stepId,
          executableId: step.executableId,
          baseScopeCheckpoint: step.baseScopeCheckpoint,
          headScopeCheckpoint: step.headScopeCheckpoint,
          continuationStack: step.continuationStack,
        }),
      );
    }
  }
  return Object.freeze(out);
}
