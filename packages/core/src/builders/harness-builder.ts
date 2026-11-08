import type { MaybeBuilder } from '../ast/ast-foundation.types.js';
import type { AstBuilder } from '../ast/ast-builder.js';
import type {
  ControlPlaneASTNode,
  LedgerStoreASTNode,
  RunnerPoolASTNode,
} from '../ast/domain-ast.types.js';
import type { HarnessNode } from '../ast/harness-node.js';
import type { LaneNode } from '../ast/lane-node.js';
import type { PoolNode } from '../ast/pool-node.js';
import type { SignalNode } from '../ast/signal-node.js';
import type { StreamNode } from '../ast/stream-node.js';
import type { HarnessSignalNotificationBuilder } from './harness-signal-notification-builder.js';

/**
 * Fluent builder for the root MetaHarness application (`M.harness(id)`).
 *
 * Binds the durable state ledger, capacity and runner pools, inbound event streams,
 * execution lanes, signal notification rules, and exposed control-plane servers.
 */
export interface HarnessBuilder extends AstBuilder<HarnessNode> {
  /** Unique identifier of the harness application. */
  readonly id: string;

  /**
   * Binds the durable state ledger store AST node (`SqliteLedgerNode`, `PostgresLedgerNode`, or custom ledger).
   *
   * Required before `.toAST()` can compile a valid `HarnessNode`.
   *
   * @param {MaybeBuilder<LedgerStoreASTNode>} ledger - Ledger store AST node or builder.
   *
   * @returns {HarnessBuilder} New immutable harness builder.
   */
  ledger(ledger: MaybeBuilder<LedgerStoreASTNode>): HarnessBuilder;

  /**
   * Registers account seat pools, model pools, and OS runner pools.
   *
   * Appends `items` in declaration order to the harness's `pools` collection.
   *
   * @param {...ReadonlyArray<MaybeBuilder<PoolNode | RunnerPoolASTNode>>} items - Pool and runner pool AST nodes or builders.
   *
   * @returns {HarnessBuilder} New immutable harness builder.
   */
  pools(...items: ReadonlyArray<MaybeBuilder<PoolNode | RunnerPoolASTNode>>): HarnessBuilder;

  /**
   * Registers inbound webhook or event streams.
   *
   * Appends `items` in declaration order to the harness's `streams` collection.
   *
   * @param {...ReadonlyArray<MaybeBuilder<StreamNode>>} items - Stream AST nodes or builders.
   *
   * @returns {HarnessBuilder} New immutable harness builder.
   */
  streams(...items: ReadonlyArray<MaybeBuilder<StreamNode>>): HarnessBuilder;

  /**
   * Registers concurrent work execution lanes.
   *
   * Appends `items` in declaration order to the harness's `lanes` collection.
   *
   * @param {...ReadonlyArray<MaybeBuilder<LaneNode>>} items - Lane AST nodes or builders.
   *
   * @returns {HarnessBuilder} New immutable harness builder.
   */
  lanes(...items: ReadonlyArray<MaybeBuilder<LaneNode>>): HarnessBuilder;

  /**
   * Registers a root-level signal notification rule routing `signal` to a human channel.
   *
   * Invokes `configure` with a `HarnessSignalNotificationBuilder` and appends the compiled rule.
   *
   * @template TPayload Signal payload type.
   *
   * @param {MaybeBuilder<SignalNode<TPayload>>}                                                               signal    - Target `SignalNode` or builder.
   * @param {($sig: HarnessSignalNotificationBuilder<TPayload>) => HarnessSignalNotificationBuilder<TPayload>} configure - Notification configurator callback.
   *
   * @returns {HarnessBuilder} New immutable harness builder.
   */
  onSignal<TPayload>(
    signal: MaybeBuilder<SignalNode<TPayload>>,
    configure: (
      $sig: HarnessSignalNotificationBuilder<TPayload>,
    ) => HarnessSignalNotificationBuilder<TPayload>,
  ): HarnessBuilder;

  /**
   * Exposes inbound control-plane servers (MCP servers, HTTP control planes, Slack bots).
   *
   * Appends `controlPlanes` in declaration order to `exposedControlPlanes`.
   *
   * @param {...ReadonlyArray<MaybeBuilder<ControlPlaneASTNode>>} controlPlanes - Control-plane AST nodes or builders.
   *
   * @returns {HarnessBuilder} New immutable harness builder.
   */
  expose(...controlPlanes: ReadonlyArray<MaybeBuilder<ControlPlaneASTNode>>): HarnessBuilder;
}
