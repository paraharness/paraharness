import { z } from 'zod';
import type { InterruptNode } from '../ast/interrupt-node.js';
import { assertNonEmptyIdentifier, deepFreeze } from './internal/deep-freeze.js';
import type { ConfigurableInterruptBuilder } from './interrupt-payload-builder.js';

/**
 * Creates a copy-on-write immutable `ConfigurableInterruptBuilder` for `H.interrupt(id)`.
 *
 * Defaults the interrupt payload schema to `z.unknown()` when `schema` is omitted and
 * returns a frozen builder supporting `.payload(nextSchema)` and `.toAST()`.
 *
 * @template TPayload Interrupt payload type.
 *
 * @param {string}                                     id       - Unique interrupt identifier.
 * @param {z.ZodType<TPayload, z.ZodTypeDef, unknown>} [schema] - Optional initial Zod payload schema (defaults to `z.unknown()`).
 *
 * @returns {ConfigurableInterruptBuilder<TPayload>} Frozen interrupt builder instance.
 */
export function createInterruptBuilder<TPayload = unknown>(
  id: string,
  schema?: z.ZodType<TPayload, z.ZodTypeDef, unknown>,
): ConfigurableInterruptBuilder<TPayload> {
  assertNonEmptyIdentifier('H.interrupt', id);
  const resolvedSchema = (schema ?? z.unknown()) as z.ZodType<TPayload, z.ZodTypeDef, unknown>;
  const compiledNode: InterruptNode<TPayload> = deepFreeze<InterruptNode<TPayload>>({
    type: 'harness:interrupt',
    id,
    schema: resolvedSchema,
  });

  return Object.freeze<ConfigurableInterruptBuilder<TPayload>>({
    type: 'harness:interrupt',
    id,
    schema: resolvedSchema,
    payload<TNext>(
      nextSchema: z.ZodType<TNext, z.ZodTypeDef, unknown>,
    ): ConfigurableInterruptBuilder<TNext> {
      return createInterruptBuilder<TNext>(id, nextSchema);
    },
    toAST(): InterruptNode<TPayload> {
      return compiledNode;
    },
  });
}
