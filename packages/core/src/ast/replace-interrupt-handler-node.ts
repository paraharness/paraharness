import type { UniversalStepTelemetry } from '../ports/universal-step-telemetry.js';
import type { BivariantCallback } from './ast-foundation.types.js';
import type { ASTNode } from './ast-node.js';
import type { AbortHookASTNode, StepASTNode } from './domain-ast.types.js';
import type { InterruptNode } from './interrupt-node.js';

/**
 * Interrupt handler variant (`mode: 'replace'`) that aborts the current step, runs cleanup hooks, and promotes to a replacement executable.
 *
 * Rewinds or resets the isolation scope via `abortHook` (or scope checkpointing) before starting `replacementExecutable`.
 *
 * @template TIn      Flow or actor input payload type.
 * @template TPayload Interrupt payload type.
 * @template THandle  Runtime handle type of the active isolation scope.
 */
export interface ReplaceInterruptHandlerNode<
  TIn = unknown,
  TPayload = unknown,
  THandle = unknown,
> extends ASTNode {
  /** Discriminant identifying an interrupt handler AST node. */
  readonly type: 'harness:interrupt-handler';
  /** Step replacement and promotion handler mode. */
  readonly mode: 'replace';
  /** Target `InterruptNode` intercepted by this handler. */
  readonly interrupt: InterruptNode<TPayload>;
  /** Optional abort hook executed to snapshot and reset the isolation scope before starting `replacementExecutable`. */
  readonly abortHook?: AbortHookASTNode<THandle, Record<string, unknown>>;
  /** Replacement step executable started after the interrupted step is cleaned up. */
  readonly replacementExecutable: StepASTNode<unknown, unknown, THandle>;
  /** Synchronous mapper projecting `(input, payload, telemetry)` into the replacement executable's input. */
  readonly mapReplacementInput: BivariantCallback<
    [
      input: TIn,
      payload: TPayload,
      telemetry: UniversalStepTelemetry<Record<string, unknown>, Record<string, unknown>>,
    ],
    unknown
  >;
}
