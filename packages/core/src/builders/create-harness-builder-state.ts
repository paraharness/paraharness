import type {
  ControlPlaneASTNode,
  LedgerStoreASTNode,
  RunnerPoolASTNode,
} from '../ast/domain-ast.types.js';
import type { HarnessSignalNotification } from '../ast/harness-node.js';
import type { LaneNode } from '../ast/lane-node.js';
import type { PoolNode } from '../ast/pool-node.js';
import type { StreamNode } from '../ast/stream-node.js';

/**
 * Internal copy-on-write state for `createHarnessBuilder`.
 *
 * Holds the bound ledger store, pools, streams, lanes, signal notifications, and
 * exposed control-plane servers across immutable builder transitions.
 */
export interface CreateHarnessBuilderState {
  /** Bound ledger store node. */
  readonly ledger?: LedgerStoreASTNode;
  /** Registered pools and runner pools. */
  readonly pools?: ReadonlyArray<PoolNode | RunnerPoolASTNode>;
  /** Registered streams. */
  readonly streams?: readonly StreamNode[];
  /** Registered lanes. */
  readonly lanes?: readonly LaneNode[];
  /** Registered signal notifications. */
  readonly onSignalNotifications?: readonly HarnessSignalNotification[];
  /** Exposed control planes. */
  readonly exposedControlPlanes?: readonly ControlPlaneASTNode[];
}
