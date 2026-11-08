import type { AgentNode } from '../ast/agent-node.js';
import type { LoopActStepConfig } from '../ast/loop-node.js';

/**
 * Builder descriptor interface for the `.act(stepId, actor)` step inside `P.loop(id)`.
 *
 * Pairs the literal action step identifier `TActStepId` with the write-capable `AgentNode`
 * executed on each refinement iteration.
 *
 * @template TIn        Loop input payload type.
 * @template TOut       Loop output payload type.
 * @template THandle    Runtime handle type of the active isolation scope.
 * @template TActStepId Literal string type of the action step identifier.
 */
export interface LoopActConfigBuilder<
  TIn = unknown,
  TOut = unknown,
  THandle = unknown,
  TActStepId extends string = string,
> {
  /** Literal action step identifier. */
  readonly stepId: TActStepId;
  /** Write-capable action agent AST node. */
  readonly actor: AgentNode<TIn, TOut, THandle>;

  /**
   * Compiles and returns the frozen `LoopActStepConfig` record.
   *
   * Returns an immutable action step configuration binding `stepId` and `actor`.
   *
   * @returns {LoopActStepConfig<TIn, TOut, THandle, TActStepId>} Frozen loop action step configuration.
   */
  toAST(): LoopActStepConfig<TIn, TOut, THandle, TActStepId>;
}
