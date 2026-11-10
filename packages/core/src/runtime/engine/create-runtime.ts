import type { AstBuilder } from '../../ast/ast-builder.js';
import type { MaybeBuilder } from '../../ast/ast-foundation.types.js';
import type { HarnessNode } from '../../ast/harness-node.js';
import type { LaneNode } from '../../ast/lane-node.js';
import type { SignalNode } from '../../ast/signal-node.js';
import type { TopologyNode } from '../../ast/topology-node.js';
import type { ActiveRunSummary } from '../../ports/active-run-summary.js';
import type { ControlPlaneHandle } from '../../ports/control-plane-handle.js';
import type { HarnessRuntime } from '../../ports/harness-runtime.js';
import type { HarnessRuntimeController } from '../../ports/harness-runtime-controller.js';
import type { HarnessRuntimeOptions } from '../../ports/harness-runtime-options.js';
import type { HumanAdapter } from '../../ports/human-adapter.js';
import type { LessonStore } from '../../ports/lesson-store.js';
import type { StreamSubscriptionHandle } from '../../ports/stream-subscription-handle.js';
import type { TopologyStore } from '../../ports/topology-store.js';
import { handleEmittedRuntimeSignal } from './internal/handle-emitted-runtime-signal.js';
import {
  collectActiveRunSummaries,
  drainSchedulerReadyRuns,
  startHarnessSubscriptions,
  stopHarnessSubscriptions,
} from './internal/manage-harness-runtime-lifecycle.js';
import { prepareHarnessRuntimeState } from './internal/prepare-harness-runtime-state.js';

/**
 * Instantiates a `HarnessRuntime` from a declarative `HarnessNode` AST (or `P.harness` builder) (`SPEC.md` §3.1 & §3.10).
 *
 * Binds the `RuntimeExecutorRegistry`, initializes per-lane `LaneScheduler` instances, subscribes
 * inbound `StreamSource` adapters, starts exposed `ControlPlaneAdapter` servers, and routes signals
 * across `.notify()`, `commitOverlayWhen`, `compactWhen`, and `.onSignal()` lane rewinds.
 *
 * @param {HarnessNode | AstBuilder<HarnessNode>} harness   - Compiled `HarnessNode` or `P.harness(...)` builder.
 * @param {HarnessRuntimeOptions}                 [options] - Optional executor registry, environment map, and runtime stores.
 *
 * @returns {HarnessRuntime} Lifecycle handle with `start()`, `stop()`, and `controller`.
 */
export function createRuntime(
  harness: HarnessNode | AstBuilder<HarnessNode>,
  options?: HarnessRuntimeOptions & {
    readonly topologyNode?: TopologyNode<string>;
    readonly topologyStore?: TopologyStore;
    readonly lessonStore?: LessonStore;
    readonly humanAdaptersById?: ReadonlyMap<string, HumanAdapter>;
  },
): HarnessRuntime {
  const prepared = prepareHarnessRuntimeState(harness, options);
  const streamHandles: StreamSubscriptionHandle[] = [];
  const controlPlaneHandles: ControlPlaneHandle[] = [];
  const trackerTimerHandles: Array<ReturnType<typeof setInterval>> = [];
  const controller: HarnessRuntimeController = {
    async emitSignal<TPayload>(
      signal: MaybeBuilder<SignalNode<TPayload>> | string,
      payload: TPayload,
    ): Promise<void> {
      const signalNode =
        typeof signal === 'string'
          ? undefined
          : 'toAST' in signal
            ? signal.toAST()
            : signal;
      const signalId = signalNode !== undefined ? signalNode.id : (signal as string);
      const validatedPayload =
        signalNode !== undefined ? (signalNode.schema.parse(payload) as TPayload) : payload;
      await handleEmittedRuntimeSignal({
        signalId,
        payload: validatedPayload,
        node: prepared.node,
        ledgerStore: prepared.ledgerStore,
        topologyNode: prepared.topologyNode,
        topologyStore: prepared.topologyStore,
        lessonStore: prepared.lessonStore,
        humanAdaptersById: prepared.humanAdaptersById,
        laneSchedulers: prepared.laneSchedulers,
      });
    },
    async enqueue<TIn = unknown>(
      lane: MaybeBuilder<LaneNode<TIn, string>> | string,
      item: TIn,
    ): Promise<void> {
      const laneId =
        typeof lane === 'string'
          ? lane
          : 'toAST' in lane
            ? lane.toAST().id
            : lane.id;
      const scheduler = prepared.laneSchedulers.get(laneId);
      if (scheduler === undefined) {
        throw new Error(
          `Unknown lane '${laneId}' in HarnessRuntimeController.enqueue on harness '${prepared.node.id}'.`,
        );
      }
      await scheduler.enqueueItem({ input: item });
      await drainSchedulerReadyRuns(scheduler);
    },
    async getActiveRuns(): Promise<ReadonlyArray<ActiveRunSummary>> {
      return collectActiveRunSummaries(prepared.laneSchedulers);
    },
  };
  const lifecycleParams = {
    node: prepared.node,
    registry: prepared.registry,
    drvCtx: prepared.drvCtx,
    ledgerStore: prepared.ledgerStore,
    controller,
    serviceRegistry: prepared.serviceRegistry,
    streamHandles,
    controlPlaneHandles,
    laneSchedulers: prepared.laneSchedulers,
    trackerTimerHandles,
  };
  return Object.freeze<HarnessRuntime>({
    controller,
    async start(): Promise<void> {
      await startHarnessSubscriptions(lifecycleParams);
    },
    async stop(): Promise<void> {
      await stopHarnessSubscriptions(lifecycleParams);
    },
  });
}
