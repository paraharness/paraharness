import type { MaybeBuilder } from '../../ast/ast-foundation.types.js';
import type { HarnessSignalNotification } from '../../ast/harness-node.js';
import type { HumanNode } from '../../ast/human-node.js';
import type { SignalNode } from '../../ast/signal-node.js';
import type { HarnessSignalNotificationBuilder } from '../harness-signal-notification-builder.js';
import { deepFreeze } from './deep-freeze.js';

/**
 * Creates an immutable `HarnessSignalNotificationBuilder` for `harness.onSignal(signal, $sig => ...)`.
 *
 * Requires `.notify(human, mapper)` to be called before `.toAST()` compilation and
 * deeply freezes the resulting `HarnessSignalNotification` record.
 *
 * @template TPayload Signal payload type.
 *
 * @param {SignalNode<TPayload>}                                                   signalNode      - Target signal AST node.
 * @param {HumanNode<'bidirectional'> | HumanNode<'notify-only'> | HumanNode}      [humanNode]     - Configured human notification channel.
 * @param {(payload: TPayload) => string}                                          [messageMapper] - Notification message formatter.
 *
 * @returns {HarnessSignalNotificationBuilder<TPayload>} Frozen signal notification sub-builder.
 */
export function createHarnessSignalNotificationSubBuilder<TPayload = unknown>(
  signalNode: SignalNode<TPayload>,
  humanNode?: HumanNode<'bidirectional'> | HumanNode<'notify-only'> | HumanNode,
  messageMapper?: (payload: TPayload) => string,
): HarnessSignalNotificationBuilder<TPayload> {
  return Object.freeze<HarnessSignalNotificationBuilder<TPayload>>({
    notify(
      human:
        | MaybeBuilder<HumanNode<'bidirectional'>>
        | MaybeBuilder<HumanNode<'notify-only'>>
        | MaybeBuilder<HumanNode>,
      mapper: (payload: TPayload) => string,
    ): HarnessSignalNotificationBuilder<TPayload> {
      const extractedHuman: HumanNode<'bidirectional'> | HumanNode<'notify-only'> | HumanNode =
        'toAST' in human ? human.toAST() : human;
      return createHarnessSignalNotificationSubBuilder(signalNode, extractedHuman, mapper);
    },
    toAST(): HarnessSignalNotification<TPayload> {
      if (humanNode === undefined || messageMapper === undefined) {
        throw new Error(
          `Harness signal notification on '${signalNode.id}' requires .notify(human, mapper).`,
        );
      }
      return deepFreeze<HarnessSignalNotification<TPayload>>({
        signal: signalNode,
        human: humanNode,
        messageMapper,
      });
    },
  });
}
