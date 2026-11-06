import type { AbortHookASTNode, StepASTNode } from '../../ast/domain-ast.types.js';
import type { FlowExecutionContext } from './flow-execution-context.js';

/**
 * Parameters for promoting a `.replaceWith(replacementActor, mapInput)` handler on a flow step (`SPEC.md` §3.6 & §3.9).
 *
 * Supplies the active `FlowExecutionContext`, the aborted `stepExecId`, the replacement executable,
 * the projected replacement input, and optional `abortHook`.
 *
 * @template TIn     Validated flow input payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 */
export interface ReplaceWithPromotionParams<TIn = unknown, THandle = unknown> {
  /** Active flow execution context. */
  readonly flowCtx: FlowExecutionContext<TIn, THandle>;
  /** Step execution identifier of the interrupted step being replaced. */
  readonly stepExecId: string;
  /** Logical step identifier in `flow.nodes`. */
  readonly stepId: string;
  /** Base scope checkpoint captured at the start of the interrupted step. */
  readonly baseScopeCheckpoint: string | undefined;
  /** Replacement executable AST node to promote and run. */
  readonly replacementExecutable: StepASTNode<unknown, unknown, THandle>;
  /** Projected replacement input produced by `handler.mapReplacementInput(...)`. */
  readonly replacementInput: TIn;
  /** Optional abort hook AST node executed before replacement step start. */
  readonly abortHook?: AbortHookASTNode<THandle>;
}
