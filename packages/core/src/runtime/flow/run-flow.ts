import type { MaybeBuilder } from '../../ast/ast-foundation.types.js';
import type { LedgerStoreASTNode } from '../../ast/domain-ast.types.js';
import type { FlowNode } from '../../ast/flow-node.js';
import type { RuntimeExecutorRegistry } from '../../ports/runtime-executor-registry.js';
import type { RuntimeExecutorRegistrySlice } from '../../ports/runtime-executor-registry-slice.js';
import { executeFlow } from './execute-flow.js';
import type { FlowRunResult } from './flow-run-result.js';
import {
  bindExternalAbortSignal,
  createStandaloneFlowExecutionContext,
  prepareStandaloneFlowRun,
} from './internal/prepare-standalone-flow-run.js';

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
 * and guarantees abort-listener removal, daemon quiescence, and `scopeDriver.release(scopeHandle)` in `finally` (`Rule 5.3`).
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
  const prepared = prepareStandaloneFlowRun(flow, options);
  let onExternalAbort: (() => void) | undefined;
  let scopeHandle: THandle | undefined;
  let scopeAcquired = false;
  try {
    onExternalAbort = bindExternalAbortSignal(
      options.signal,
      prepared.activeStepAbortController,
    );
    scopeHandle = await prepared.scopeDriver.acquireRoot(prepared.runId);
    scopeAcquired = true;
    const flowCtx = createStandaloneFlowExecutionContext(prepared, input, scopeHandle);
    try {
      const res = await executeFlow(flowCtx);
      if (res.exitState !== 'SUSPENDED') {
        await prepared.ledgerStore.recordRunTerminalReceipt(
          prepared.runId,
          prepared.itemKey,
          res.exitState,
          JSON.stringify(res.scopeReceipt),
        );
      }
      return res;
    } catch (err) {
      await prepared.ledgerStore.recordRunTerminalReceipt(
        prepared.runId,
        prepared.itemKey,
        'errored',
      );
      if (prepared.topologyStore !== undefined) {
        await prepared.topologyStore.discardRunOverlay(prepared.runId);
      }
      throw err;
    }
  } finally {
    if (onExternalAbort !== undefined && options.signal !== undefined) {
      options.signal.removeEventListener('abort', onExternalAbort);
    }
    prepared.poolManager.releaseRunSeats(prepared.runId);
    await prepared.serviceRegistry.quiesceScopeServices();
    if (scopeAcquired) {
      await prepared.scopeDriver.release(scopeHandle as THandle);
    }
  }
}
