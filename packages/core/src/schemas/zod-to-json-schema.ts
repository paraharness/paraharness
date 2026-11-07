import { z } from 'zod';
import { deepFreeze } from '../builders/internal/deep-freeze.js';

/**
 * Converts a Zod schema (`z.ZodTypeAny`) into a deeply frozen JSON Schema object for LLM structured outputs and wire tool declarations.
 *
 * Delegates directly to Zod v4's native `z.toJSONSchema()` converter (preserving `.min()`, `.max()`, `.int()`, `.regex()`,
 * `minItems`, `.default()`, `.optional()`, unions, intersections, and descriptions) while stripping the top-level `$schema` URI.
 *
 * @param {z.ZodTypeAny} schema - Input Zod schema to convert.
 *
 * @returns {Readonly<Record<string, unknown>>} Deeply frozen JSON Schema representation of `schema`.
 */
export function zodToJsonSchema(schema: z.ZodTypeAny): Readonly<Record<string, unknown>> {
  const { $schema: _ignoredSchema, ...jsonSchema } = z.toJSONSchema(schema, {
    unrepresentable: 'any',
  });
  return deepFreeze(jsonSchema);
}
