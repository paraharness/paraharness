import type { CompactionConfigNode } from '../../../ast/compaction-config-node.js';
import type { HarnessNode } from '../../../ast/harness-node.js';
import type { TopologyNode } from '../../../ast/topology-node.js';
import type { HumanAdapter } from '../../../ports/human-adapter.js';
import type { LedgerStore } from '../../../ports/ledger-store.js';
import type { LessonStore } from '../../../ports/lesson-store.js';
import type { TopologyStore } from '../../../ports/topology-store.js';
import type { LaneScheduler } from '../../lane/lane-scheduler.js';

/**
 * Parameters passed to `handleTopologyOverlayCommitSignal`.
 *
 * @template TPayload Emitted signal payload type.
 */
export interface HandleTopologyOverlayCommitSignalParams<TPayload = unknown> {
  /** Identifier of the emitted signal. */
  readonly signalId: string;

  /** Emitted signal payload. */
  readonly payload: TPayload;

  /** Durable execution ledger store. */
  readonly ledgerStore: LedgerStore;

  /** Optional topology AST node. */
  readonly topologyNode: TopologyNode<string> | undefined;

  /** Optional topology store instance. */
  readonly topologyStore: TopologyStore | undefined;

  /** Optional institutional memory lesson store. */
  readonly lessonStore: LessonStore | undefined;
}

/**
 * Parameters passed to `handleEmittedRuntimeSignal`.
 *
 * @template TPayload Emitted signal payload type.
 */
export interface HandleEmittedRuntimeSignalParams<TPayload = unknown>
  extends HandleTopologyOverlayCommitSignalParams<TPayload> {
  /** Root harness AST node. */
  readonly node: HarnessNode;

  /** Registered human escalation and notification adapters keyed by `humanNode.id`. */
  readonly humanAdaptersById: ReadonlyMap<string, HumanAdapter>;

  /** Active lane schedulers keyed by `laneNode.id`. */
  readonly laneSchedulers: ReadonlyMap<string, LaneScheduler<unknown>>;
}

/**
 * Handles `topology.commitOverlayWhen` on-signal promotion or child-branch absorption (`SPEC.md` §3.3 & §3.10).
 *
 * Absorbs child branch overlays into `prerequisiteRunId` when `baseBranch` is non-trunk, or commits to canonical trunk
 * and syncs lesson creation epochs.
 *
 * @template TPayload Emitted signal payload type.
 *
 * @param {HandleTopologyOverlayCommitSignalParams<TPayload>} params - Signal ID, payload, topology node, and stores.
 *
 * @returns {Promise<void>} Resolves once overlay promotion or absorption completes.
 */
async function handleTopologyOverlayCommitSignal<TPayload>(
  params: HandleTopologyOverlayCommitSignalParams<TPayload>,
): Promise<void> {
  const { signalId, payload } = params;
  const commitCfg = params.topologyNode?.commitOverlayWhen;
  if (
    commitCfg?.onSignal === undefined ||
    commitCfg.onSignal.signal.id !== signalId ||
    params.topologyStore === undefined
  ) {
    return;
  }
  const correlatedId = commitCfg.onSignal.correlateBy(payload);
  const rec = (await params.ledgerStore.getRunTerminalReceipts([correlatedId])).get(correlatedId);
  const targetRunId = rec?.runId ?? correlatedId;
  const parsed =
    rec?.scopeReceiptJson !== undefined
      ? (JSON.parse(rec.scopeReceiptJson) as {
          readonly baseBranch?: string;
          readonly prerequisiteRunId?: string;
        })
      : typeof payload === 'object' && payload !== null
        ? (payload as { readonly baseBranch?: string; readonly prerequisiteRunId?: string })
        : {};
  if (
    parsed.baseBranch !== undefined &&
    parsed.baseBranch !== 'main' &&
    parsed.baseBranch !== 'master' &&
    parsed.prerequisiteRunId !== undefined
  ) {
    await params.topologyStore.syncRunOverlays(parsed.prerequisiteRunId, [targetRunId]);
    await params.topologyStore.discardRunOverlay(targetRunId);
  } else {
    const commitRes = await params.topologyStore.commitRunOverlay(targetRunId);
    if (params.lessonStore !== undefined && commitRes.committedRunIds.length > 0) {
      await params.lessonStore.syncCreationEpochsForRuns(
        commitRes.committedRunIds,
        commitRes.updatedEpochs,
      );
    }
  }
}

/**
 * Routes an emitted signal across `.notify()`, `commitOverlayWhen`, `compactWhen`, and `.onSignal()` lane rewinds (`SPEC.md` §3.1 & §3.10).
 *
 * Handles child-branch overlay absorption (`syncRunOverlays` + `discardRunOverlay`) and canonical trunk
 * overlay promotion (`commitRunOverlay` + `syncCreationEpochsForRuns`).
 *
 * @template TPayload Emitted signal payload type.
 *
 * @param {HandleEmittedRuntimeSignalParams<TPayload>} params - Signal ID, payload, harness AST, stores, and lane schedulers.
 *
 * @returns {Promise<void>} Resolves once all matching signal handlers complete.
 */
export async function handleEmittedRuntimeSignal<TPayload>(
  params: HandleEmittedRuntimeSignalParams<TPayload>,
): Promise<void> {
  const { signalId, payload } = params;
  for (const notif of params.node.onSignalNotifications) {
    if (notif.signal.id === signalId) {
      await params.humanAdaptersById.get(notif.human.id)?.notify(notif.messageMapper(payload));
    }
  }
  await handleTopologyOverlayCommitSignal(params);
  const compaction = (params.node.ledger as { readonly compaction?: CompactionConfigNode })
    .compaction;
  for (const trig of compaction?.signalTriggers ?? []) {
    if (trig.signal.id === signalId) {
      const itemKeyOrRunId = trig.correlateBy(payload);
      const rec = (await params.ledgerStore.getRunTerminalReceipts([itemKeyOrRunId])).get(
        itemKeyOrRunId,
      );
      await params.ledgerStore.compactRunFrames(rec?.runId ?? itemKeyOrRunId);
    }
  }
  for (const scheduler of params.laneSchedulers.values()) {
    await scheduler.handleSignalRewind(signalId, payload);
  }
}
