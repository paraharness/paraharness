import type { MaybeBuilder } from '../../ast/ast-foundation.types.js';
import type {
  IsolationScopeASTNode,
  RunnerPoolASTNode,
  StepASTNode,
} from '../../ast/domain-ast.types.js';
import type {
  ExtractStepInput,
  ExtractStepOutput,
} from '../../builders/flow-extraction.types.js';
import type { BranchableScope } from '../../ports/branchable-scope.js';
import type { CheckpointableScope } from '../../ports/checkpointable-scope.js';
import type { ContinuationFrame } from '../../ports/continuation-frame.types.js';
import { createExecutorRegistry } from '../../ports/create-executor-registry.js';
import type { IsolationScope } from '../../ports/isolation-scope.js';
import type { RunnerDriver } from '../../ports/runner-driver.js';
import type { RuntimeExecutorRegistry } from '../../ports/runtime-executor-registry.js';
import type { RuntimeExecutorRegistrySlice } from '../../ports/runtime-executor-registry-slice.js';
import type { ServiceSession } from '../../ports/service-session.js';
import type { StepExecutionContext } from '../../ports/step-execution-context.js';
import type { ToolEffect } from '../../ports/tool-effect.js';
import type { WireFrameRecord } from '../../ports/wire-frame-record.js';
import { executeStepNode } from './execute-step-node.js';
import { createEphemeralStepLedgerStore } from './internal/create-ephemeral-step-ledger-store.js';

/**
 * Configuration options passed to `runStep(node, input, options)` for standalone single-step execution (`SPEC.md` §3.1).
 *
 * Accepts a composite `RuntimeExecutorRegistry`, a single adapter `RuntimeExecutorRegistrySlice`, or an array of slices,
 * and fills sensible defaults for `runId`, `stepExecId`, `env`, `activePartitions`, `activeLeases`, `observedEffects`,
 * `resolveEnv`, `getRunner`, and `recordEffects`.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 */
export interface StepRunOptions<THandle = unknown> {
  /** Executor registry, single adapter slice, or array of adapter slices used to dispatch the step and its tools/models. */
  readonly registry:
    | Partial<RuntimeExecutorRegistry>
    | RuntimeExecutorRegistrySlice
    | readonly RuntimeExecutorRegistrySlice[];

  /** Optional explicit environment variable map for resolving symbolic `P.env(key)` references (defaults to `{}`). */
  readonly env?: Readonly<Record<string, string | undefined>>;

  /** Optional active isolation scope handle passed to the step and its mounted tools. */
  readonly scopeHandle?: THandle;

  /** Optional passive AST node of the active isolation scope. */
  readonly scopeNode?: IsolationScopeASTNode<
    THandle,
    Record<string, unknown>,
    Record<string, unknown>
  >;

  /** Optional active isolation scope runtime driver instance. */
  readonly scope?:
    | IsolationScope<THandle, Record<string, unknown>>
    | CheckpointableScope<THandle, Record<string, unknown>>
    | BranchableScope<THandle, Record<string, unknown>, Record<string, unknown>>;

  /** Optional run identifier (defaults to `'standalone-run'`). */
  readonly runId?: string;

  /** Optional step execution identifier (defaults to `'standalone-step-1'`). */
  readonly stepExecId?: string;

  /** Optional active partition identifiers (derived from `node.extractPartitions(input)` when omitted). */
  readonly activePartitions?: readonly string[];

  /** Optional cancellation signal for aborting in-flight step operations. */
  readonly signal?: AbortSignal;

  /** Optional map of surviving speculative candidate branch indices to their live scope handles. */
  readonly candidateHandles?: ReadonlyMap<number, THandle>;

  /** Optional map of active background daemon service sessions keyed by service ID. */
  readonly activeServiceSessions?: ReadonlyMap<string, ServiceSession<THandle>>;

  /** Optional pre-seeded wire transcript frames inherited from a parent or aborted attempt. */
  readonly seededHistory?: readonly WireFrameRecord[];

  /** Optional continuation frame stack used when resuming a suspended or interrupted step. */
  readonly resumeContinuationStack?: readonly ContinuationFrame[];
}

/**
 * Executes a single passive `StepASTNode` or fluent step builder (`P.agent`, `P.loop`, `P.command`, or domain step) without manual `StepExecutionContext` boilerplate (`SPEC.md` §3.1).
 *
 * Unwraps `MaybeBuilder`, merges `options.registry` via `createExecutorRegistry`, derives `activePartitions`
 * from `node.extractPartitions` when omitted, memoizes `RunnerDriver` instances per `runnerNode.id`, and
 * delegates to `executeStepNode`.
 *
 * @template TStep   Passive `StepASTNode` type invoked by `runStep`.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {MaybeBuilder<TStep>}     node    - Passive step AST node or fluent builder.
 * @param {ExtractStepInput<TStep>} input   - Raw or pre-validated step input payload.
 * @param {StepRunOptions<THandle>} options - Standalone step execution options.
 *
 * @returns {Promise<ExtractStepOutput<TStep>>} Schema-validated step output payload.
 *
 * @throws {Error} If no `StepExecutor` or `RunnerDriver` is registered for the invoked node types.
 */
export async function runStep<TStep extends StepASTNode = StepASTNode, THandle = unknown>(
  node: MaybeBuilder<TStep>,
  input: ExtractStepInput<TStep>,
  options: StepRunOptions<THandle>,
): Promise<ExtractStepOutput<TStep>> {
  const stepNode: TStep = 'toAST' in node ? node.toAST() : node;
  const registry = createExecutorRegistry(options.registry);
  const runId = options.runId ?? 'standalone-run';
  const stepExecId = options.stepExecId ?? 'standalone-step-1';
  const env = options.env ?? {};
  const activePartitions =
    options.activePartitions ??
    ((stepNode.type === 'harness:agent' ||
      stepNode.type === 'harness:loop' ||
      stepNode.type === 'harness:command') &&
    stepNode.extractPartitions !== undefined
      ? stepNode.extractPartitions(stepNode.inputSchema.parse(input))
      : Object.freeze([]));
  const observedEffects: ToolEffect[] = [];
  const memoizedRunners = new Map<string, RunnerDriver>();
  const baseCtx: StepExecutionContext<THandle> = {
    runId,
    stepExecId,
    scopeHandle: options.scopeHandle as THandle,
    scopeNode: options.scopeNode,
    scope: options.scope,
    candidateHandles: options.candidateHandles,
    activeServiceSessions: options.activeServiceSessions,
    activePartitions,
    activeLeases: Object.freeze([]),
    observedEffects,
    signal: options.signal,
    seededHistory: options.seededHistory,
    resumeContinuationStack: options.resumeContinuationStack,
    registry,
    resolveEnv: (value) => (typeof value === 'string' ? value : env[value.key]),
    getRunner: (rNode: RunnerPoolASTNode) => {
      const existing = memoizedRunners.get(rNode.id);
      if (existing !== undefined) {
        return existing;
      }
      const factory = registry.runners[rNode.type];
      if (factory === undefined) {
        throw new Error(
          `No RunnerDriver registered for '${rNode.type}' (runner id '${rNode.id}', runId '${runId}').`,
        );
      }
      const drv = factory(rNode as never);
      memoizedRunners.set(rNode.id, drv);
      return drv;
    },
    recordEffects: (effects: readonly ToolEffect[]) => {
      for (const eff of effects) {
        observedEffects.push(eff);
      }
    },
  };
  const ctx: StepExecutionContext<THandle> = Object.freeze(
    Object.assign({}, baseCtx, {
      _runtime: {
        ledgerStore: createEphemeralStepLedgerStore(options.seededHistory),
      },
    }),
  );
  return executeStepNode(stepNode, input, ctx) as Promise<ExtractStepOutput<TStep>>;
}
