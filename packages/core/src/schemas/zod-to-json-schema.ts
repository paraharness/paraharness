import type { z } from 'zod';
import { deepFreeze } from '../builders/internal/deep-freeze.js';
import { convertZodDefToJsonSchema } from './internal/convert-zod-def.js';

/**
 * Converts a Zod schema (`z.ZodTypeAny`) into a deeply frozen JSON Schema object for LLM structured outputs and wire tool declarations.
 *
 * Supports primitives, literals, enums, arrays, tuples, records, nested objects with `.optional()` and `.default()`,
 * discriminated and standard unions, intersections, and nullable modifiers.
 *
 * @param {z.ZodTypeAny} schema - Input Zod schema to convert.
 *
 * @returns {Readonly<Record<string, unknown>>} Deeply frozen JSON Schema representation of `schema`.
 */
export function zodToJsonSchema(schema: z.ZodTypeAny): Readonly<Record<string, unknown>> {
  const jsonSchema = convertZodDefToJsonSchema(schema);
  return deepFreeze(jsonSchema);
}
