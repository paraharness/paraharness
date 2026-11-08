import type { BivariantCallback, MaybeBuilder } from '../ast/ast-foundation.types.js';
import type { SignalNode } from '../ast/signal-node.js';

/**
 * Builder input options for `P.topology(id).commitOverlayWhen(...)`, accepting `MaybeBuilder<SignalNode>` on signal triggers.
 *
 * Configures signal-correlated commit and discard triggers for per-run copy-on-write
 * topology contract overlays along with an optional maximum sealed age TTL.
 *
 * @template TOnSig      Commit signal payload type.
 * @template TDiscardSig Discard signal payload type.
 */
export interface TopologyCommitOverlayBuilderInput<TOnSig = unknown, TDiscardSig = unknown> {
  /** Optional signal trigger that commits the run's sealed overlay to the base store. */
  readonly onSignal?: {
    readonly signal: MaybeBuilder<SignalNode<TOnSig>>;
    readonly correlateBy: BivariantCallback<[sig: TOnSig], string>;
    readonly baseBranch?: BivariantCallback<[sig: TOnSig], string>;
  };
  /** Optional signal trigger that discards an unmerged run overlay. */
  readonly discardOnSignal?: {
    readonly signal: MaybeBuilder<SignalNode<TDiscardSig>>;
    readonly correlateBy: BivariantCallback<[sig: TDiscardSig], string>;
  };
  /** Optional TTL in hours after which unmerged sealed overlays are garbage-collected. */
  readonly maxSealedAgeHours?: number;
}
