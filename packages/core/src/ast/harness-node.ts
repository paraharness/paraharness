import type { BivariantCallback } from './ast-foundation.types.js';
import type {
  ControlPlaneASTNode,
  LedgerStoreASTNode,
  RunnerPoolASTNode,
} from './domain-ast.types.js';
import type { HumanNode } from './human-node.js';
import type { LaneNode } from './lane-node.js';
import type { PoolNode } from './pool-node.js';
import type { SignalNode } from './signal-node.js';
import type { StreamNode } from './stream-node.js';

/**
 * Root-level signal notification rule routing an emitted `SignalNode` to a `HumanNode` channel.
 *
 * Formats emitted signal payloads via `messageMapper` and dispatches a one-way notification
 * to `human.channel` without suspending the emitting flow or actor.
 *
 * @template TPayload Signal payload type.
 */
export interface HarnessSignalNotification<TPayload = unknown> {
  /** Target `SignalNode` triggering the outbound human notification. */
  readonly signal: SignalNode<TPayload>;
  /** Human authority or notification channel receiving the formatted message. */
  readonly human: HumanNode<'bidirectional'> | HumanNode<'notify-only'> | HumanNode;
  /** Synchronous formatter projecting `TPayload` into a notification message string. */
  readonly messageMapper: BivariantCallback<[payload: TPayload], string>;
}

/**
 * Root passive AST node representing a complete MetaHarness application (`H.harness(id)`).
 *
 * Composes the durable ledger store, resource and runner pools, inbound event streams,
 * execution lanes, outbound signal notifications, and exposed control-plane servers.
 */
export interface HarnessNode {
  /** Discriminant identifying the root harness AST node. */
  readonly type: 'harness:root';
  /** Unique identifier of the harness application. */
  readonly id: string;
  /** Durable state ledger store AST node (`SqliteLedgerNode`, `PostgresLedgerNode`, or custom ledger). */
  readonly ledger: LedgerStoreASTNode;
  /** Registered account seat pools, model pools, and OS runner pools. */
  readonly pools: ReadonlyArray<PoolNode<unknown> | RunnerPoolASTNode>;
  /** Registered inbound webhook or event streams. */
  readonly streams: readonly StreamNode<unknown, unknown>[];
  /** Registered work execution lanes. */
  readonly lanes: readonly LaneNode<unknown, string>[];
  /** Registered root-level signal notification rules. */
  readonly onSignalNotifications: readonly HarnessSignalNotification[];
  /** Exposed inbound control-plane servers (MCP servers, HTTP control planes, Slack bots). */
  readonly exposedControlPlanes: readonly ControlPlaneASTNode[];
}
