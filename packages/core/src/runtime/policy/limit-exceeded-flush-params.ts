import type { ModelASTNode } from '../../ast/domain-ast.types.js';
import type { PolicyLimitExceededConfig } from '../../ast/policy-node.js';
import type { AgentContinuationFrame } from '../../ports/agent-continuation-frame.js';
import type { CompiledWirePrefix } from '../../ports/compiled-wire-prefix.js';
import type { ContinuationFrame } from '../../ports/continuation-frame.types.js';
import type { LedgerStore } from '../../ports/ledger-store.js';
import type { ModelDriver } from '../../ports/model-driver.js';
import type { PendingToolBatch } from '../../ports/pending-tool-batch.js';
import type { StepExecutionContext } from '../../ports/step-execution-context.js';
import type { TopologyStore } from '../../ports/topology-store.js';
import type { StepContinuationQueue } from '../locks/step-continuation-queue.js';
import type { ServiceSessionRegistry } from '../services/service-session-registry.js';

/**
 * Optional step-promotion configuration executed in Step 4 of the `.onLimitExceeded()` sequence (`SPEC.md` §3.5).
 *
 * Supplies the replacement executable identifier, new step execution ID, initial continuation stack,
 * and mapper projecting `(stepInput, flushedPayload, abortMeta)` into the promoted step's input.
 */
export interface LimitExceededReplacementConfig {
  /** Identifier of the promoted replacement executable (`replacementExecutable.id`). */
  readonly replacementExecutableId: string;
  /** Logical step ID in the flow for `recordStepStart`. */
  readonly stepId: string;
  /** Newly allocated `stepExecId` for the promoted replacement step. */
  readonly replacementStepExecId: string;
  /** Initial `ContinuationFrame[]` stack for the replacement step. */
  readonly replacementInitialStack?: readonly ContinuationFrame[];
  /** Optional base scope checkpoint for the replacement step. */
  readonly baseScopeCheckpoint?: string;
  /** Mapper computing the promoted input from `(originalInput, flushedPayload, abortMeta)`. */
  readonly mapReplacementInput: (
    originalInput: unknown,
    flushedPayload: unknown,
    abortMeta: Record<string, unknown>,
  ) => unknown;
}

/**
 * Parameters for executing the 4-step crash-safe `.onLimitExceeded()` sequence (`SPEC.md` §3.5).
 *
 * Consolidates the active `AgentContinuationFrame`, `PendingToolBatch`, `PolicyLimitExceededConfig`,
 * `ModelDriver`, `LedgerStore`, `TopologyStore`, `ServiceSessionRegistry`, and optional `.replaceWith()` promotion.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 */
export interface LimitExceededFlushParams<THandle = unknown> {
  /** Active `AgentContinuationFrame` being flushed and aborted. */
  readonly agentFrame: AgentContinuationFrame;
  /** Outer continuation frames (`loop-frame`, etc.) prefixing `agentFrame` in `LedgerStore`. */
  readonly outerFrames?: readonly ContinuationFrame[];
  /** Optional unfinished `PendingToolBatch` whose `remainingCalls` must be synthesized as `[Aborted: Limit Exceeded]`. */
  readonly pendingToolBatch?: PendingToolBatch;
  /** Policy `.onLimitExceeded()` configuration specifying `flushInterrupt` and optional `abortHook`. */
  readonly limitConfig: PolicyLimitExceededConfig<THandle>;
  /** Active `ModelASTNode` used for the `toolChoice: 'none'` flush turn. */
  readonly modelNode: ModelASTNode;
  /** Active `ModelDriver` instance. */
  readonly modelDriver: ModelDriver;
  /** Optional pinned `CompiledWirePrefix` for the actor. */
  readonly wirePrefix?: CompiledWirePrefix;
  /** Durable `LedgerStore` persisting wire frames, continuation stacks, and step transitions. */
  readonly ledgerStore: LedgerStore;
  /** Optional `StepContinuationQueue` serializing `updateContinuationStack` writes. */
  readonly continuationQueue?: StepContinuationQueue;
  /** Optional `TopologyStore` whose step-scoped overlay is reset in Step 3. */
  readonly topologyStore?: TopologyStore;
  /** Optional `ServiceSessionRegistry` quiesced in Step 3. */
  readonly serviceRegistry?: ServiceSessionRegistry;
  /** Optional base scope checkpoint restored when no `abortHook` is configured. */
  readonly baseScopeCheckpoint?: string;
  /** Diagnostic reason explaining which quantitative limit or quota tripwire tripped. */
  readonly tripReason: string;
  /** Step execution context providing `runId`, `stepExecId`, `scopeHandle`, `scope`, and `registry`. */
  readonly ctx: StepExecutionContext<THandle>;
  /** Optional `.replaceWith()` promotion configuration executed in Step 4. */
  readonly replacementPromotion?: LimitExceededReplacementConfig;
}
