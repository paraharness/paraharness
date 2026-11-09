import type { MaybeBuilder } from '../ast/ast-foundation.types.js';
import type {
  ControlPlaneASTNode,
  LedgerStoreASTNode,
  RunnerPoolASTNode,
} from '../ast/domain-ast.types.js';
import { extractAST } from '../ast/extract-ast.js';
import type { HarnessNode } from '../ast/harness-node.js';
import type { HumanNode } from '../ast/human-node.js';
import type { LaneNode } from '../ast/lane-node.js';
import type { PoolNode } from '../ast/pool-node.js';
import type { SignalNode } from '../ast/signal-node.js';
import type { StreamNode } from '../ast/stream-node.js';
import type { CreateHarnessBuilderState } from './create-harness-builder-state.js';
import type { HarnessBuilder } from './harness-builder.js';
import type { HarnessSignalNotificationBuilder } from './harness-signal-notification-builder.js';
import { createHarnessSignalNotificationSubBuilder } from './internal/create-harness-signal-notification-sub-builder.js';
import { assertNonEmptyIdentifier, deepFreeze } from './internal/deep-freeze.js';

/**
 * Creates a fluent `HarnessBuilder` for `P.harness(id)`.
 *
 * Accumulates the durable ledger store, warm pools, streams, lanes, signal notifications,
 * and exposed control planes, requiring `.ledger(ledgerStore)` before `.toAST()` compilation.
 *
 * @param {string}                    id      - Unique identifier of the harness application.
 * @param {CreateHarnessBuilderState} [state] - Optional internal copy-on-write state.
 *
 * @returns {HarnessBuilder} Frozen `HarnessBuilder` instance.
 */
export function createHarnessBuilder(id: string, state?: CreateHarnessBuilderState): HarnessBuilder {
  assertNonEmptyIdentifier('P.harness', id);
  const pools = state?.pools ?? [];
  const streams = state?.streams ?? [];
  const lanes = state?.lanes ?? [];
  const onSignalNotifications = state?.onSignalNotifications ?? [];
  const exposedControlPlanes = state?.exposedControlPlanes ?? [];

  return Object.freeze<HarnessBuilder>({
    id,
    ledger(ledger: MaybeBuilder<LedgerStoreASTNode>): HarnessBuilder {
      return createHarnessBuilder(id, { ...state, ledger: extractAST(ledger) });
    },
    pools(...items: ReadonlyArray<MaybeBuilder<PoolNode | RunnerPoolASTNode>>): HarnessBuilder {
      const nextPools: Array<PoolNode | RunnerPoolASTNode> = [...pools];
      for (const item of items) {
        nextPools.push(extractAST(item));
      }
      return createHarnessBuilder(id, { ...state, pools: nextPools });
    },
    streams(...items: ReadonlyArray<MaybeBuilder<StreamNode>>): HarnessBuilder {
      const nextStreams: StreamNode[] = [...streams];
      for (const item of items) {
        nextStreams.push(extractAST(item));
      }
      return createHarnessBuilder(id, { ...state, streams: nextStreams });
    },
    lanes(...items: ReadonlyArray<MaybeBuilder<LaneNode>>): HarnessBuilder {
      const nextLanes: LaneNode[] = [...lanes];
      for (const item of items) {
        nextLanes.push(extractAST(item));
      }
      return createHarnessBuilder(id, { ...state, lanes: nextLanes });
    },
    onSignal<TPayload>(
      signal: MaybeBuilder<SignalNode<TPayload>>,
      configureOrHuman:
        | (($sig: HarnessSignalNotificationBuilder<TPayload>) => HarnessSignalNotificationBuilder<TPayload>)
        | MaybeBuilder<HumanNode<'bidirectional'>>
        | MaybeBuilder<HumanNode<'notify-only'>>
        | MaybeBuilder<HumanNode>,
      messageMapper?: (payload: TPayload) => string,
    ): HarnessBuilder {
      const signalNode = extractAST(signal);
      const subBuilder = createHarnessSignalNotificationSubBuilder<TPayload>(signalNode);
      const notification =
        typeof configureOrHuman === 'function'
          ? configureOrHuman(subBuilder).toAST()
          : ((): ReturnType<typeof subBuilder.toAST> => {
              if (typeof messageMapper !== 'function') {
                throw new Error(
                  `Harness '${id}' signal notification on '${signalNode.id}' requires a messageMapper function.`,
                );
              }
              return subBuilder.notify(configureOrHuman, messageMapper).toAST();
            })();
      return createHarnessBuilder(id, {
        ...state,
        onSignalNotifications: [...onSignalNotifications, notification],
      });
    },
    expose(...controlPlanes: ReadonlyArray<MaybeBuilder<ControlPlaneASTNode>>): HarnessBuilder {
      const nextExposed: ControlPlaneASTNode[] = [...exposedControlPlanes];
      for (const cp of controlPlanes) {
        nextExposed.push(extractAST(cp));
      }
      return createHarnessBuilder(id, { ...state, exposedControlPlanes: nextExposed });
    },
    toAST(): HarnessNode {
      if (state?.ledger === undefined) {
        throw new Error(`Harness '${id}' requires .ledger(ledgerStore).`);
      }
      return deepFreeze<HarnessNode>({
        type: 'harness:root',
        id,
        ledger: state.ledger,
        pools,
        streams,
        lanes,
        onSignalNotifications,
        exposedControlPlanes,
      });
    },
  });
}
