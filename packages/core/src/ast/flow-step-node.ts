import type { StepASTNode } from './domain-ast.types.js';
import type { FlowStepInputMapper } from './flow-step-input-mapper.types.js';
import type { InterruptHandlerNode } from './interrupt-handler-node.types.js';

/**
 * Passive AST node representing a single sequential step inside a `FlowNode` (`.step(id, step, $s => ...)`).
 *
 * Wraps an underlying `StepASTNode` with its flow-scoped identifier, optional `inputFrom`
 * projector, and step-specific `.onInterrupt(...)` handlers.
 *
 * @template TIn     Step input payload type.
 * @template TOut    Step output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 * @template TStepId Literal step identifier string.
 */
export interface FlowStepNode<
  TIn = unknown,
  TOut = unknown,
  THandle = unknown,
  TStepId extends string = string,
> {
  /** Discriminant identifying a flow step AST node. */
  readonly type: 'harness:flow-step';
  /** Unique literal identifier of the step within the enclosing flow. */
  readonly id: TStepId;
  /** Underlying step AST node (`AgentNode`, `LoopNode`, `CommandNode`, or `DomainStepASTNode`). */
  readonly step: StepASTNode<unknown, TOut, THandle>;
  /** Optional synchronous input projector mapping `(flowInput, priorSteps, scopeReceipt)` to `TIn`. */
  readonly inputFrom?: FlowStepInputMapper<TIn>;
  /** Step-level interrupt handlers overriding or supplementing actor-level handlers. */
  readonly onInterruptHandlers: readonly InterruptHandlerNode<unknown, unknown, THandle>[];
}
