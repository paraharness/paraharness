import type { MaybeBuilder } from '../../ast/ast-foundation.types.js';
import type { LedgerStoreASTNode } from '../../ast/domain-ast.types.js';
import type { FlowNode } from '../../ast/flow-node.js';
import { createExecutorRegistry } from '../../ports/create-executor-registry.js';
import type { IsolationScope } from '../../ports/isolation-scope.js';
import type { RunnerDriver } from '../../ports/runner-driver.js';
import type { RuntimeDriverContext } from '../../ports/runtime-driver-context.js';
import type { RuntimeExecutorRegistry } from '../../ports/runtime-executor-registry.js';
import type { RuntimeExecutorRegistrySlice } from '../../ports/runtime-executor-registry-slice.js';
import { ScopeLockManager } from '../locks/scope-lock-manager.js';
import { StepContinuationQueue } from '../locks/step-continuation-queue.js';
import { PoolManager } from '../pools/pool-manager.js';
import { ServiceSessionRegistry } from '../services/service-session-registry.js';
import { executeFlow } from './execute-flow.js';
import type { FlowExecutionContext } from './flow-execution-context.js';
import type { FlowRunResult } from './flow-run-result.js';
import { resolveFlowRuntimeStores } from './internal/resolve-flow-runtime-stores.js';

/**
 * Configuration options passed to `runFlow(flow, input, options)` for standalone single-flow execution (`SPEC.md` §3.1 & §3.9).
 *
 * Requires an explicit `registry` and durable `ledger` descriptor (`LedgerStoreASTNode`) while automatically
 * resolving scope drivers, topology stores, lesson stores, human channels, and capacity pools from the flow AST.
 */
export interface FlowRunOptions {
  /** Executor registry, single adapter slice, or array of adapter slices used to resolve stores, scopes, and steps. */
  readonly registry:
    | Partial<RuntimeExecutorRegistry>
    | RuntimeExecutorRegistrySlice
    | readonly RuntimeExecutorRegistrySlice[];

  /** Backing ledger store AST node or builder (`sqlite.ledger(...)` or `postgres.ledger(...)`). */
  readonly ledger: MaybeBuilder<LedgerStoreASTNode>;

  /** Optional explicit environment variable map for resolving symbolic `P.env(key)` references (defaults to `{}`). */
  readonly env?: Readonly<Record<string, string | undefined>>;

  /** Optional flow run identifier (defaults to `'standalone-flow-run'`). */
  readonly runId?: string;

  /** Optional enclosing lane identifier (defaults to `'standalone-lane'`). */
  readonly laneId?: string;

  /** Optional work item deduplication key (defaults to `runId`). */
  readonly itemKey?: string;

  /** Optional cancellation signal for aborting the flow execution. */
  readonly signal?: AbortSignal;
}

/**
 * Executes a standalone `FlowNode` or `FlowBuilder` (`P.flow`) with automatic store resolution and deterministic `try / finally` scope and daemon cleanup (`SPEC.md` §3.1 & §3.9).
 *
 * Unwraps `MaybeBuilder` inputs, merges `options.registry`, resolves `LedgerStore`, `IsolationScope`, `TopologyStore`,
 * `LessonStore`, and `HumanAdapter` instances from the flow AST, acquires the root scope handle, runs `executeFlow`,
 * and guarantees daemon quiescence and `scopeDriver.release(scopeHandle)` in `finally` (`Rule 5.3`).
 *
 * @template TIn     Validated flow input payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {MaybeBuilder<FlowNode<TIn, THandle, string>>} flow    - Passive `FlowNode` or fluent `FlowBuilder`.
 * @param {TIn}                                          input   - Initial flow input payload.
 * @param {FlowRunOptions}                               options - Standalone flow execution options.
 *
 * @returns {Promise<FlowRunResult>} Terminal or suspended flow run receipt and step outputs.
 *
 * @throws {Error} If any required store, scope, runner, or step executor is missing from `options.registry`.
 */
export async function runFlow<TIn = unknown, THandle = unknown>(
  flow: MaybeBuilder<FlowNode<TIn, THandle, string>>,
  input: TIn,
  options: FlowRunOptions,
): Promise<FlowRunResult> {
  const flowNode: FlowNode<TIn, THandle, string> = 'toAST' in flow ? flow.toAST() : flow;
  const ledgerNode: LedgerStoreASTNode =
    'toAST' in options.ledger ? options.ledger.toAST() : options.ledger;
  const registry = createExecutorRegistry(options.registry);
  const runId = options.runId ?? 'standalone-flow-run';
  const laneId = options.laneId ?? 'standalone-lane';
  const itemKey = options.itemKey ?? runId;
  const env: Readonly<Record<string, string | undefined>> = options.env ?? Object.freeze({});
  const memoizedRunners = new Map<string, RunnerDriver>();
  const drvCtx: RuntimeDriverContext = {
    registry,
    resolveEnv: (v) => (typeof v === 'string' ? v : env[v.key]),
    getRunner: (rNode) => {
      const existing = memoizedRunners.get(rNode.id);
      if (existing !== undefined) {
        return existing;
      }
      const factory = registry.runners[rNode.type];
      if (factory === undefined) {
        throw new Error(
          `No RunnerDriver registered for '${rNode.type}' (runner id '${rNode.id}', flow '${flowNode.id}', runId '${runId}').`,
        );
      }
      const drv = factory(rNode as never);
      memoizedRunners.set(rNode.id, drv);
      return drv;
    },
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
  const lockManager = new ScopeLockManager();
  const continuationQueue = new StepContinuationQueue();
  const poolManager = new PoolManager();
  const serviceRegistry = new ServiceSessionRegistry();
  const activeStepAbortController = new AbortController();
  let onExternalAbort: (() => void) | undefined;
  if (options.signal !== undefined) {
    if (options.signal.aborted) {
      activeStepAbortController.abort(options.signal.reason);
    } else {
      onExternalAbort = (): void => {
        activeStepAbortController.abort(options.signal?.reason);
      };
      options.signal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }
  const scopeHandle = await scopeDriver.acquireRoot(runId);
  try {
    const flowCtx: FlowExecutionContext<TIn, THandle> = {
      runId,
      laneId,
      itemKey,
      flow: flowNode,
      currentInput: input,
      scopeHandle,
      scopeDriver: scopeDriver as never,
      registry,
      env,
      ledgerStore,
      topologyStore: resolvedStores.topologyStore,
      lessonStore: resolvedStores.lessonStore,
      lockManager,
      continuationQueue,
      poolManager,
      serviceRegistry,
      humanAdaptersById: resolvedStores.humanAdaptersById,
      prefixGroups: undefined,
      wirePrefixesByGroupId: new Map(),
      completedStepOutputs: new Map(),
      stepBaseCheckpointsByStepId: new Map(),
      observedRunEffects: [],
      activeStepId: null,
      activeStepExecId: null,
      activeReplacementExecutable: undefined,
      resumeContinuationStack: undefined,
      activeStepAbortController,
      pendingRewindToStepId: undefined,
      retryConfig: undefined,
    };
    return await executeFlow(flowCtx);
  } finally {
    if (onExternalAbort !== undefined && options.signal !== undefined) {
      options.signal.removeEventListener('abort', onExternalAbort);
    }
    poolManager.releaseRunSeats(runId);
    await serviceRegistry.quiesceScopeServices();
    await scopeDriver.release(scopeHandle);
  }
}
