import type { CompactionConfigNode } from '../../../ast/compaction-config-node.js';
import type { HarnessNode } from '../../../ast/harness-node.js';
import type { TopologyNode } from '../../../ast/topology-node.js';
import type { HumanAdapter } from '../../../ports/human-adapter.js';
import type { LedgerStore } from '../../../ports/ledger-store.js';
import type { LessonStore } from '../../../ports/lesson-store.js';
import type { TopologyStore } from '../../../ports/topology-store.js';
import type { LaneScheduler } from '../../lane/lane-scheduler.js';

/**
 * Routes an emitted signal across `.notify()`, `commitOverlayWhen`, `compactWhen`, and `.onSignal()` lane rewinds (`SPEC.md` §3.1 & §3.10).
 *
 * Handles child-branch overlay absorption (`syncRunOverlays` + `discardRunOverlay`) and canonical trunk
 * overlay promotion (`commitRunOverlay` + `syncCreationEpochsForRuns`).
 *
 * @template TPayload Emitted signal payload type.
 *
 * @param {string}   signalId - Identifier of the emitted signal.
 * @param {TPayload} payload  - Signal payload.
 * @param {object}   deps     - Harness AST, stores, human adapters, and lane schedulers.
 *
 * @returns {Promise<void>} Resolves once all matching signal handlers complete.
 */
export async function handleEmittedRuntimeSignal<TPayload>(
  signalId: string,
  payload: TPayload,
  deps: {
    readonly node: HarnessNode;
    readonly ledgerStore: LedgerStore;
    readonly topologyNode: TopologyNode<string> | undefined;
    readonly topologyStore: TopologyStore | undefined;
    readonly lessonStore: LessonStore | undefined;
    readonly humanAdaptersById: ReadonlyMap<string, HumanAdapter>;
    readonly laneSchedulers: ReadonlyMap<string, LaneScheduler<unknown>>;
  },
): Promise<void> {
  for (const notif of deps.node.onSignalNotifications) {
    if (notif.signal.id === signalId) await deps.humanAdaptersById.get(notif.human.id)?.notify(notif.messageMapper(payload));
  }
  const commitCfg = deps.topologyNode?.commitOverlayWhen;
  if (commitCfg?.onSignal !== undefined && commitCfg.onSignal.signal.id === signalId && deps.topologyStore !== undefined) {
    const correlatedId = commitCfg.onSignal.correlateBy(payload);
    const rec = (await deps.ledgerStore.getRunTerminalReceipts([correlatedId])).get(correlatedId);
    const targetRunId = rec?.runId ?? correlatedId;
    const parsed = rec?.scopeReceiptJson !== undefined
      ? JSON.parse(rec.scopeReceiptJson) as { readonly baseBranch?: string; readonly prerequisiteRunId?: string }
      : (typeof payload === 'object' && payload !== null ? payload as { readonly baseBranch?: string; readonly prerequisiteRunId?: string } : {});
    if (parsed.baseBranch !== undefined && parsed.baseBranch !== 'main' && parsed.baseBranch !== 'master' && parsed.prerequisiteRunId !== undefined) {
      await deps.topologyStore.syncRunOverlays(parsed.prerequisiteRunId, [targetRunId]);
      await deps.topologyStore.discardRunOverlay(targetRunId);
    } else {
      const commitRes = await deps.topologyStore.commitRunOverlay(targetRunId);
      if (deps.lessonStore !== undefined && commitRes.committedRunIds.length > 0) {
        await deps.lessonStore.syncCreationEpochsForRuns(commitRes.committedRunIds, commitRes.updatedEpochs);
      }
    }
  }
  const compaction = (deps.node.ledger as { readonly compaction?: CompactionConfigNode }).compaction;
  for (const trig of compaction?.signalTriggers ?? []) {
    if (trig.signal.id === signalId) {
      const itemKeyOrRunId = trig.correlateBy(payload);
      const rec = (await deps.ledgerStore.getRunTerminalReceipts([itemKeyOrRunId])).get(itemKeyOrRunId);
      await deps.ledgerStore.compactRunFrames(rec?.runId ?? itemKeyOrRunId);
    }
  }
  for (const scheduler of deps.laneSchedulers.values()) await scheduler.handleSignalRewind(signalId, payload);
}
