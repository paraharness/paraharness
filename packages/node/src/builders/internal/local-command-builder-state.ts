import type {
  BivariantCallback,
  EnvRef,
  LocalCommandUnrepeatableConfig,
  NodeRunnerNode,
  z,
} from '@metaharness/core';

/**
 * Immutable internal state snapshot backing `LocalCommandBuilder`.
 *
 * Captures all fluent builder properties prior to compiling `LocalCommandNode` in `.toAST()`.
 *
 * @template TIn     Validated command input payload type.
 * @template TOut    Validated command output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 */
export interface LocalCommandBuilderState<TIn = unknown, TOut = unknown, THandle = unknown> {
  /** Unique identifier of the command. */
  readonly id: string;
  /** Bound runner pool AST node. */
  readonly runner: NodeRunnerNode;
  /** Static argument vector or input-to-argv mapper. */
  readonly argv?: readonly string[] | BivariantCallback<[input: TIn], readonly string[]>;
  /** Standard input mode or mapper. */
  readonly stdinMode: 'closed' | BivariantCallback<[input: TIn], string | Uint8Array>;
  /** Optional environment variable map. */
  readonly env?: Readonly<Record<string, string | EnvRef>>;
  /** Optional timeout in minutes. */
  readonly timeoutMinutes?: number;
  /** Input validation schema. */
  readonly inputSchema: z.ZodType<TIn>;
  /** Whether `.input(schema)` was explicitly invoked by the caller. */
  readonly hasExplicitInputSchema: boolean;
  /** Output validation schema. */
  readonly outputSchema: z.ZodType<TOut>;
  /** Optional idempotency pre-check configuration. */
  readonly unrepeatable?: LocalCommandUnrepeatableConfig<TIn, THandle>;
}
