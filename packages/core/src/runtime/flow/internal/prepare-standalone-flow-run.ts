import type { MaybeBuilder } from '../../../ast/ast-foundation.types.js';
import type { LedgerStoreASTNode } from '../../../ast/domain-ast.types.js';
import type { FlowNode } from '../../../ast/flow-node.js';
import { createExecutorRegistry } from '../../../ports/create-executor-registry.js';
import type { HumanAdapter } from '../../../ports/human-adapter.js';
import type { IsolationScope } from '../../../ports/isolation-scope.js';
import type { LedgerStore } from '../../../ports/ledger-store.js';
import type { LessonStore } from '../../../ports/lesson-store.js';
import type { RuntimeDriverContext } from '../../../ports/runtime-driver-context.js';
import type { RuntimeExecutorRegistry } from '../../../ports/runtime-executor-registry.js';
import type { TopologyStore } from '../../../ports/topology-store.js';
import { ScopeLockManager } from '../../locks/scope-lock-manager.js';
import { StepContinuationQueue } from '../../locks/step-continuation-queue.js';
import { createMemoizedRunnerResolver } from '../../pools/internal/create-memoized-runner-resolver.js';
import { PoolManager } from '../../pools/pool-manager.js';
import { ServiceSessionRegistry } from '../../services/service-session-registry.js';
import type { FlowExecutionContext } from '../flow-execution-context.js';
import type { FlowRunOptions } from '../run-flow.js';
import { resolveFlowRuntimeStores } from './resolve-flow-runtime-stores.js';

/**
 * Resolved runtime drivers, stores, and lifecycle managers for a standalone `runFlow` invocation (`SPEC.md` §3.1 & §3.9).
 *
 * @template TIn     Validated flow input payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 */
export interface PreparedStandaloneFlowRunParams<TIn = unknown, THandle = unknown> {
  /** Resolved flow run identifier. */
  readonly runId: string;

  /** Resolved enclosing lane identifier. */
  readonly laneId: string;

  /** Resolved work item deduplication key. */
  readonly itemKey: string;

  /** Unwrapped flow AST node. */
  readonly flowNode: FlowNode<TIn, THandle, string>;

  /** Composite runtime executor registry. */
  readonly registry: RuntimeExecutorRegistry;

  /** Explicit environment variable map. */
  readonly env: Readonly<Record<string, string | undefined>>;

  /** Instantiated ledger store driver. */
  readonly ledgerStore: LedgerStore;

  /** Instantiated isolation scope driver. */
  readonly scopeDriver: IsolationScope<THandle>;

  /** Optional instantiated topology store driver. */
  readonly topologyStore: TopologyStore | undefined;

  /** Optional instantiated lesson store driver. */
  readonly lessonStore: LessonStore | undefined;

  /** Instantiated human channel adapters keyed by `human.id`. */
  readonly humanAdaptersById: ReadonlyMap<string, HumanAdapter>;

  /** Scope lock manager for the standalone flow run. */
  readonly lockManager: ScopeLockManager;

  /** Step continuation queue for the standalone flow run. */
  readonly continuationQueue: StepContinuationQueue;

  /** Capacity pool manager for the standalone flow run. */
  readonly poolManager: PoolManager;

  /** Service daemon session registry for the standalone flow run. */
  readonly serviceRegistry: ServiceSessionRegistry;

  /** Abort controller forwarding cancellation to the active step. */
  readonly activeStepAbortController: AbortController;
}

/**
 * Unwraps flow and ledger builders, merges `options.registry`, and resolves all required stores and scope drivers for `runFlow` (`SPEC.md` §3.1 & §3.9).
 *
 * @template TIn     Validated flow input payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {MaybeBuilder<FlowNode<TIn, THandle, string>>} flow    - Passive `FlowNode` or fluent `FlowBuilder`.
 * @param {FlowRunOptions}                               options - Standalone flow execution options.
 *
 * @returns {PreparedStandaloneFlowRunParams<TIn, THandle>} Prepared drivers, stores, and lifecycle managers.
 *
 * @throws {Error} If any required ledger, scope, topology, lesson, or human adapter factory is missing from `options.registry`.
 */
export function prepareStandaloneFlowRun<TIn = unknown, THandle = unknown>(
  flow: MaybeBuilder<FlowNode<TIn, THandle, string>>,
  options: FlowRunOptions,
): PreparedStandaloneFlowRunParams<TIn, THandle> {
  const flowNode: FlowNode<TIn, THandle, string> = 'toAST' in flow ? flow.toAST() : flow;
  const ledgerNode: LedgerStoreASTNode =
    'toAST' in options.ledger ? options.ledger.toAST() : options.ledger;
  const registry = createExecutorRegistry(options.registry);
  const runId = options.runId ?? 'standalone-flow-run';
  const laneId = options.laneId ?? 'standalone-lane';
  const itemKey = options.itemKey ?? runId;
  const env: Readonly<Record<string, string | undefined>> = options.env ?? Object.freeze({});
  const drvCtx: RuntimeDriverContext = {
    registry,
    resolveEnv: (v) => (typeof v === 'string' ? v : env[v.key]),
    getRunner: createMemoizedRunnerResolver(
      registry,
      `flow '${flowNode.id}', runId '${runId}'`,
    ),
  };
  const ledgerFactory = registry.ledgers[ledgerNode.type];
  if (ledgerFactory === undefined) {
    throw new Error(
      `No LedgerStore registered for '${ledgerNode.type}' in flow '${flowNode.id}' (runId '${runId}').`,
    );
  }
  const scopeFactory = registry.scopes[flowNode.scope.type];
  if (scopeFactory === undefined) {
    throw new Error(
      `No IsolationScope registered for '${flowNode.scope.type}' in flow '${flowNode.id}' (runId '${runId}').`,
    );
  }
  const ledgerStore = ledgerFactory(ledgerNode as never, drvCtx);
  const resolvedStores = resolveFlowRuntimeStores({
    flows: [flowNode as FlowNode<unknown, unknown>],
    registry,
    drvCtx,
    contextLabel: `flow '${flowNode.id}' (runId '${runId}')`,
  });
  const scopeDriver = scopeFactory(flowNode.scope as never, drvCtx) as IsolationScope<THandle>;
  return {
    runId,
    laneId,
    itemKey,
    flowNode,
    registry,
    env,
    ledgerStore,
    scopeDriver,
    topologyStore: resolvedStores.topologyStore,
    lessonStore: resolvedStores.lessonStore,
    humanAdaptersById: resolvedStores.humanAdaptersById,
    lockManager: new ScopeLockManager(),
    continuationQueue: new StepContinuationQueue(),
    poolManager: new PoolManager(),
    serviceRegistry: new ServiceSessionRegistry(),
    activeStepAbortController: new AbortController(),
  };
}

/**
 * Attaches an external `AbortSignal` to `activeStepAbortController`, returning the registered listener for `finally` cleanup (`Rule 5.3`).
 *
 * @param {AbortSignal | undefined} signal                    - Optional external cancellation signal.
 * @param {AbortController}         activeStepAbortController - Step abort controller to trigger on cancellation.
 *
 * @returns {(() => void) | undefined} Registered abort listener callback, or `undefined` if already aborted or absent.
 */
export function bindExternalAbortSignal(
  signal: AbortSignal | undefined,
  activeStepAbortController: AbortController,
): (() => void) | undefined {
  if (signal === undefined) {
    return undefined;
  }
  if (signal.aborted) {
    activeStepAbortController.abort(signal.reason);
    return undefined;
  }
  const onExternalAbort = (): void => {
    activeStepAbortController.abort(signal.reason);
  };
  signal.addEventListener('abort', onExternalAbort, { once: true });
  return onExternalAbort;
}

/**
 * Assembles the `FlowExecutionContext` state object for a prepared standalone flow run (`SPEC.md` §3.1 & §3.9).
 *
 * @template TIn     Validated flow input payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {PreparedStandaloneFlowRunParams<TIn, THandle>} prepared    - Prepared flow stores and drivers.
 * @param {TIn}                                           input       - Initial flow input payload.
 * @param {THandle}                                       scopeHandle - Acquired root isolation scope handle.
 *
 * @returns {FlowExecutionContext<TIn, THandle>} Mutable flow execution context ready for `executeFlow`.
 */
export function createStandaloneFlowExecutionContext<TIn = unknown, THandle = unknown>(
  prepared: PreparedStandaloneFlowRunParams<TIn, THandle>,
  input: TIn,
  scopeHandle: THandle,
): FlowExecutionContext<TIn, THandle> {
  return {
    runId: prepared.runId,
    laneId: prepared.laneId,
    itemKey: prepared.itemKey,
    flow: prepared.flowNode,
    currentInput: input,
    scopeHandle,
    scopeDriver: prepared.scopeDriver as never,
    registry: prepared.registry,
    env: prepared.env,
    ledgerStore: prepared.ledgerStore,
    topologyStore: prepared.topologyStore,
    lessonStore: prepared.lessonStore,
    lockManager: prepared.lockManager,
    continuationQueue: prepared.continuationQueue,
    poolManager: prepared.poolManager,
    serviceRegistry: prepared.serviceRegistry,
    humanAdaptersById: prepared.humanAdaptersById,
    prefixGroups: undefined,
    wirePrefixesByGroupId: new Map(),
    completedStepOutputs: new Map(),
    stepBaseCheckpointsByStepId: new Map(),
    observedRunEffects: [],
    activeStepId: null,
    activeStepExecId: null,
    activeReplacementExecutable: undefined,
    resumeContinuationStack: undefined,
    activeStepAbortController: prepared.activeStepAbortController,
    pendingRewindToStepId: undefined,
    retryConfig: undefined,
  };
}
