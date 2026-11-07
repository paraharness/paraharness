import type { MaybeBuilder } from '../ast/ast-foundation.types.js';
import type { HarnessSignalNotification } from '../ast/harness-node.js';
import type { HumanNode } from '../ast/human-node.js';

/**
 * Fluent sub-builder for a root-level signal notification rule (`harness.onSignal(sig, $sig => $sig.notify(human, mapper))`).
 *
 * Routes an emitted `SignalNode<TPayload>` to a `HumanNode` channel using a synchronous
 * message formatter.
 *
 * @template TPayload Signal payload type.
 */
export interface HarnessSignalNotificationBuilder<TPayload = unknown> {
  /**
   * Routes the emitted signal to a `HumanNode` channel using `messageMapper`.
   *
   * Accepts both `'bidirectional'` and `'notify-only'` human channels for outbound notifications.
   *
   * @param {MaybeBuilder<HumanNode<'bidirectional'>> | MaybeBuilder<HumanNode<'notify-only'>> | MaybeBuilder<HumanNode>} human         - Target human authority or notification channel.
   * @param {(payload: TPayload) => string}                                                                               messageMapper - Synchronous notification message formatter.
   *
   * @returns {HarnessSignalNotificationBuilder<TPayload>} New immutable signal notification builder.
   */
  notify(
    human:
      | MaybeBuilder<HumanNode<'bidirectional'>>
      | MaybeBuilder<HumanNode<'notify-only'>>
      | MaybeBuilder<HumanNode>,
    messageMapper: (payload: TPayload) => string,
  ): HarnessSignalNotificationBuilder<TPayload>;

  /**
   * Compiles this notification builder into an immutable `HarnessSignalNotification`.
   *
   * Throws at builder compilation time if `.notify(human, mapper)` has not been called.
   *
   * @returns {HarnessSignalNotification<TPayload>} Deeply frozen signal notification record.
   */
  toAST(): HarnessSignalNotification<TPayload>;
}
