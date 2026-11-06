import type { BivariantCallback } from '../ast-foundation.types.js';
import type { BaseDomainStepASTNode } from '../base/base-domain-step-ast-node.js';
import type { EnvRef } from '../env-ref.js';
import type { NodeRunnerNode } from './node-runner-node.js';

/**
 * Passive AST node representing a one-shot local OS subprocess command (`local.command`).
 *
 * Participates in `StepASTNode` and can be projected into a `LocalCommandCheckNode` (`.asCheck()`)
 * or a post-flight-diffed `LocalCommandToolNode` (`.asTool()`).
 *
 * @template TIn     Validated command input type.
 * @template TOut    Validated command output type.
 * @template THandle Isolation scope handle type.
 */
export interface LocalCommandNode<TIn = unknown, TOut = unknown, THandle = unknown>
  extends BaseDomainStepASTNode<'node:command', TIn, TOut, THandle> {
  /** Runner pool governing subprocess slot concurrency. */
  readonly runner: NodeRunnerNode;
  /** Static argument vector or pure mapper deriving `argv` from `TIn`. */
  readonly argv: readonly string[] | BivariantCallback<[input: TIn], readonly string[]>;
  /** Standard input mode (`'closed'` or synchronous payload mapper). */
  readonly stdinMode: 'closed' | BivariantCallback<[input: TIn], string | Uint8Array>;
  /** Optional environment variables or symbolic `EnvRef` bindings injected into the subprocess. */
  readonly env?: Readonly<Record<string, string | EnvRef>>;
  /** Optional execution timeout in minutes. */
  readonly timeoutMinutes?: number;
  /** Optional idempotency guard that skips execution when `preCheckCmd` returns `true`. */
  readonly unrepeatable?: {
    /** Pre-check command evaluated prior to running the main command. */
    readonly preCheckCmd: LocalCommandNode<unknown, boolean, THandle>;
    /** Deduplication key or mapper identifying the unrepeatable operation. */
    readonly key: string | BivariantCallback<[input: TIn], string>;
  };
}
