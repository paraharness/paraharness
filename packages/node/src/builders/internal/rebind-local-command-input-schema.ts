import type { LocalCommandUnrepeatableConfig, z } from '@harness-dsl/core';
import type { LocalCommandBuilderState } from './local-command-builder-state.js';

/**
 * Re-wraps an existing `LocalCommandUnrepeatableConfig` when `.input(schema)` changes `TIn` to `TNewIn`.
 *
 * Preserves static deduplication keys and parses `TNewIn` through `prevSchema` before invoking a key mapper.
 *
 * @template TIn     Previous command input payload type.
 * @template TNewIn  New validated command input payload type.
 * @template THandle Isolation scope handle type.
 *
 * @param {LocalCommandUnrepeatableConfig<TIn, THandle> | undefined} prevUnrep  - Previous unrepeatable config.
 * @param {z.ZodType<TIn>}                                           prevSchema - Previous input schema.
 *
 * @returns {LocalCommandUnrepeatableConfig<TNewIn, THandle> | undefined} Rebound unrepeatable configuration.
 */
function rebindUnrepeatableConfig<TIn, TNewIn, THandle>(
  prevUnrep: LocalCommandUnrepeatableConfig<TIn, THandle> | undefined,
  prevSchema: z.ZodType<TIn>,
): LocalCommandUnrepeatableConfig<TNewIn, THandle> | undefined {
  if (prevUnrep === undefined) {
    return undefined;
  }
  const prevKey = prevUnrep.key;
  const reboundKey =
    typeof prevKey === 'function'
      ? (value: TNewIn): string => prevKey(prevSchema.parse(value))
      : prevKey;
  return Object.freeze<LocalCommandUnrepeatableConfig<TNewIn, THandle>>({
    preCheckCmd: prevUnrep.preCheckCmd,
    key: reboundKey,
  });
}

/**
 * Produces a new `LocalCommandBuilderState` rebound to `schema` (`TNewIn`).
 *
 * Adapts any previously registered `argv`, `stdinMode`, and `unrepeatable.key` callbacks to `TNewIn`
 * without losing type safety or mutating the prior builder state.
 *
 * @template TIn     Previous command input payload type.
 * @template TNewIn  New validated command input payload type.
 * @template TOut    Validated command output payload type.
 * @template THandle Isolation scope handle type.
 *
 * @param {LocalCommandBuilderState<TIn, TOut, THandle>} state  - Existing immutable builder state.
 * @param {z.ZodType<TNewIn>}                            schema - New Zod input validation schema.
 *
 * @returns {LocalCommandBuilderState<TNewIn, TOut, THandle>} Rebound immutable builder state.
 */
export function rebindLocalCommandInputSchema<TIn, TNewIn, TOut, THandle>(
  state: LocalCommandBuilderState<TIn, TOut, THandle>,
  schema: z.ZodType<TNewIn>,
): LocalCommandBuilderState<TNewIn, TOut, THandle> {
  const { inputSchema: prevSchema, argv: prevArgv, stdinMode: prevStdin, unrepeatable: prevUnrep } = state;
  const reboundArgv =
    typeof prevArgv === 'function'
      ? (value: TNewIn): readonly string[] => prevArgv(prevSchema.parse(value))
      : prevArgv;
  const reboundStdin =
    prevStdin === 'closed'
      ? 'closed'
      : (value: TNewIn): string | Uint8Array => prevStdin(prevSchema.parse(value));
  return Object.freeze<LocalCommandBuilderState<TNewIn, TOut, THandle>>({
    id: state.id,
    runner: state.runner,
    argv: reboundArgv,
    stdinMode: reboundStdin,
    env: state.env,
    timeoutMinutes: state.timeoutMinutes,
    inputSchema: schema,
    hasExplicitInputSchema: true,
    outputSchema: state.outputSchema,
    unrepeatable: rebindUnrepeatableConfig(prevUnrep, prevSchema),
  });
}
