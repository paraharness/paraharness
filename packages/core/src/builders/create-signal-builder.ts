import { z } from 'zod';
import type { SignalNode } from '../ast/signal-node.js';
import { assertNonEmptyIdentifier, deepFreeze } from './internal/deep-freeze.js';
import type { SignalPayloadBuilder as ConfigurableSignalBuilder } from './signal-payload-builder.js';

/**
 * Creates a copy-on-write immutable `ConfigurableSignalBuilder` for `H.signal(id)`.
 *
 * Defaults the signal payload schema to `z.unknown()` when `schema` is omitted and
 * returns a frozen builder supporting `.payload(nextSchema)` and `.toAST()`.
 *
 * @template TPayload Signal payload type.
 *
 * @param {string}                                     id       - Unique signal identifier.
 * @param {z.ZodType<TPayload, z.ZodTypeDef, unknown>} [schema] - Optional initial Zod payload schema (defaults to `z.unknown()`).
 *
 * @returns {ConfigurableSignalBuilder<TPayload>} Frozen signal builder instance.
 */
export function createSignalBuilder<TPayload = unknown>(
  id: string,
  schema?: z.ZodType<TPayload, z.ZodTypeDef, unknown>,
): ConfigurableSignalBuilder<TPayload> {
  assertNonEmptyIdentifier('H.signal', id);
  const resolvedSchema = (schema ?? z.unknown()) as z.ZodType<TPayload, z.ZodTypeDef, unknown>;
  const compiledNode: SignalNode<TPayload> = deepFreeze<SignalNode<TPayload>>({
    type: 'harness:signal',
    id,
    schema: resolvedSchema,
  });

  return Object.freeze<ConfigurableSignalBuilder<TPayload>>({
    type: 'harness:signal',
    id,
    schema: resolvedSchema,
    payload<TNext>(
      nextSchema: z.ZodType<TNext, z.ZodTypeDef, unknown>,
    ): ConfigurableSignalBuilder<TNext> {
      return createSignalBuilder<TNext>(id, nextSchema);
    },
    toAST(): SignalNode<TPayload> {
      return compiledNode;
    },
  });
}
