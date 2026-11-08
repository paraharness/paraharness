import type { LaneNode } from '../../ast/lane-node.js';
import type { PrefixGroupNode } from '../../ast/prefix-group-node.js';
import type { TopologyNode } from '../../ast/topology-node.js';
import type { HumanAdapter } from '../../ports/human-adapter.js';
import type { LedgerStore } from '../../ports/ledger-store.js';
import type { LessonStore } from '../../ports/lesson-store.js';
import type { RuntimeExecutorRegistry } from '../../ports/runtime-executor-registry.js';
import type { TopologyStore } from '../../ports/topology-store.js';
import type { TrackerAdapter } from '../../ports/tracker-adapter.js';
import type { ScopeLockManager } from '../locks/scope-lock-manager.js';
import type { StepContinuationQueue } from '../locks/step-continuation-queue.js';
import type { PoolManager } from '../pools/pool-manager.js';
import type { ServiceSessionRegistry } from '../services/service-session-registry.js';

/**
 * Configuration dependencies injected into `LaneScheduler` at construction time (`SPEC.md` §3.10).
 *
 * Supplies the `LaneNode` AST, runtime executor registry, durable stores, and optional tracker/topology hooks.
 *
 * @template TIn Validated lane work item input type.
 */
export interface LaneSchedulerConfig<TIn = unknown> {
  /** Passive `LaneNode` AST definition governed by this scheduler. */
  readonly lane: LaneNode<TIn, string>;
  /** Composite runtime executor registry. */
  readonly registry: RuntimeExecutorRegistry;
  /** Explicit environment variable map for resolving symbolic `M.env(key)` references. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Durable state ledger store. */
  readonly ledgerStore: LedgerStore;
  /** Optional topology store for run-scoped partition contract overlays. */
  readonly topologyStore?: TopologyStore;
  /** Optional declarative `TopologyNode` AST for `commitOverlayWhen` correlation. */
  readonly topologyNode?: TopologyNode<string>;
  /** Optional lesson store for empirical lesson recall and outcome attribution. */
  readonly lessonStore?: LessonStore;
  /** Per-handle read/write lock manager. */
  readonly lockManager?: ScopeLockManager;
  /** Per-`stepExecId` continuation stack serialization queue. */
  readonly continuationQueue?: StepContinuationQueue;
  /** Stateful pool manager for model and account seat selection. */
  readonly poolManager?: PoolManager;
  /** Lifecycle registry for `'scope'`, `'fork'`, and `'skill'` `ServiceSession` daemons. */
  readonly serviceRegistry?: ServiceSessionRegistry;
  /** Map of `HumanNode.id` to runtime `HumanAdapter`. */
  readonly humanAdaptersById?: ReadonlyMap<string, HumanAdapter>;
  /** Optional tracker adapter instance overriding registry lookup. */
  readonly trackerAdapter?: TrackerAdapter<unknown, string>;
  /** Optional prefix groups to compile and pin at run start. */
  readonly prefixGroups?: readonly PrefixGroupNode[];
}
