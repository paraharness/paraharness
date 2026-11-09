import type { CreateOrResumeRunResult } from '../../../ports/create-or-resume-run-result.js';
import type { LedgerStore } from '../../../ports/ledger-store.js';
import type { RunTerminalReceiptRecord } from '../../../ports/run-terminal-receipt-record.js';
import type { SuspendedForkRecord } from '../../../ports/suspended-fork-record.js';
import type { WireFrameRecord } from '../../../ports/wire-frame-record.js';

/**
 * Creates a lightweight in-memory `LedgerStore` for standalone single-step executions via `runStep`.
 *
 * Preserves Turn-0 `[ROLE_AND_SCOPE_CONTEXT]` frames, multi-turn tool call/result chains, skill
 * tombstones, and child-fork suspension records across turns within the step without requiring
 * an external database ledger.
 *
 * @param {readonly WireFrameRecord[]} [seededHistory] - Optional pre-seeded wire frames to index initially.
 *
 * @returns {LedgerStore} Ephemeral in-memory `LedgerStore` instance.
 */
export function createEphemeralStepLedgerStore(
  seededHistory?: readonly WireFrameRecord[],
): LedgerStore {
  const frames = new Map<string, WireFrameRecord>();
  const suspendedForks = new Map<string, SuspendedForkRecord>();
  const resolvedForkIds = new Set<string>();
  for (const seeded of seededHistory ?? []) {
    frames.set(seeded.messageId, seeded);
  }
  return Object.freeze<LedgerStore>({
    async createOrResumeRun(run): Promise<CreateOrResumeRunResult> {
      return Object.freeze<CreateOrResumeRunResult>({
        status: 'RUNNING',
        currentStepId: null,
        inputJson: run.inputJson,
        costUsd: 0,
        completedStepOutputsJson: new Map<string, string>(),
      });
    },
    async recordStepStart(): Promise<void> {
      return undefined;
    },
    async updateContinuationStack(): Promise<void> {
      return undefined;
    },
    async updateRunInput(): Promise<void> {
      return undefined;
    },
    async mutateLanePlan(): Promise<void> {
      return undefined;
    },
    async appendMessageFrame(_runId, frame): Promise<void> {
      frames.set(frame.messageId, frame);
    },
    async replaceMessageFrame(_runId, frame): Promise<void> {
      frames.set(frame.messageId, frame);
    },
    async markFrameTombstone(_runId, messageId, callId, compactedTombstone): Promise<void> {
      const existing = frames.get(messageId);
      if (existing === undefined) {
        return;
      }
      frames.set(
        messageId,
        Object.freeze<WireFrameRecord>({
          ...existing,
          compactedTombstones: Object.freeze({
            ...(existing.compactedTombstones ?? {}),
            [callId]: compactedTombstone,
          }),
        }),
      );
    },
    async getMessageChain(leafMessageId): Promise<readonly WireFrameRecord[]> {
      const chain: WireFrameRecord[] = [];
      let cursor: string | null = leafMessageId;
      while (cursor !== null) {
        const frame = frames.get(cursor);
        if (frame === undefined) {
          break;
        }
        chain.push(frame);
        cursor = frame.parentMessageId;
      }
      chain.reverse();
      return Object.freeze(chain);
    },
    async recordForkSuspension(record): Promise<void> {
      suspendedForks.set(record.suspendedForkId, record);
    },
    async getSuspendedForks(runId, opts): Promise<readonly SuspendedForkRecord[]> {
      const matches: SuspendedForkRecord[] = [];
      const forkIdFilter = opts?.forkIds !== undefined ? new Set<string>(opts.forkIds) : undefined;
      for (const rec of suspendedForks.values()) {
        if (rec.runId !== runId || resolvedForkIds.has(rec.suspendedForkId)) {
          continue;
        }
        if (forkIdFilter !== undefined && !forkIdFilter.has(rec.forkId)) {
          continue;
        }
        if (opts?.parentStepExecId !== undefined && rec.parentStepExecId !== opts.parentStepExecId) {
          continue;
        }
        matches.push(rec);
      }
      return Object.freeze(matches);
    },
    async resolveSuspendedFork(suspendedForkId): Promise<void> {
      resolvedForkIds.add(suspendedForkId);
    },
    async recordStepTransition(): Promise<void> {
      return undefined;
    },
    async recordRunTerminalReceipt(): Promise<void> {
      return undefined;
    },
    async getRunTerminalReceipts(): Promise<ReadonlyMap<string, RunTerminalReceiptRecord>> {
      return new Map<string, RunTerminalReceiptRecord>();
    },
    async getInterruptedStepsOnBoot() {
      return Object.freeze([]);
    },
    async compactRunFrames(): Promise<void> {
      return undefined;
    },
  });
}
