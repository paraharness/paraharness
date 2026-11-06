import type { z } from 'zod';
import type { InternalZodDef } from './internal-zod-def.js';
import type { UnwrappedZodField } from './unwrapped-zod-field.js';

/**
 * Extracts the internal `InternalZodDef` descriptor from a `z.ZodTypeAny` instance.
 *
 * Casts `schema._def` to the read-only `InternalZodDef` structural interface for
 * deterministic type-name and modifier inspection.
 *
 * @param {z.ZodTypeAny} schema - Zod schema to inspect.
 *
 * @returns {InternalZodDef} Internal Zod definition object.
 */
export function getZodDef(schema: z.ZodTypeAny): InternalZodDef {
  return schema._def as InternalZodDef;
}

/**
 * Peels a single outer wrapper modifier from `current` when `def` is a transparent wrapper type.
 *
 * Handles `ZodReadonly`, `ZodCatch`, `ZodBranded`, `ZodEffects`, and `ZodPipeline` wrappers
 * by returning their inner or output schema, or `undefined` when `def` is not a transparent wrapper.
 *
 * @param {InternalZodDef} def - Internal Zod definition of the current schema layer.
 *
 * @returns {z.ZodTypeAny | undefined} Unwrapped child schema or `undefined` when at a core type.
 */
function unwrapTransparentLayer(def: InternalZodDef): z.ZodTypeAny | undefined {
  const typeName = def.typeName;
  if (
    (typeName === 'ZodReadonly' || typeName === 'ZodCatch' || typeName === 'ZodBranded') &&
    def.innerType !== undefined
  ) {
    return def.innerType;
  }
  if (typeName === 'ZodEffects' && def.schema !== undefined) return def.schema;
  if (typeName === 'ZodPipeline' && def.out !== undefined) return def.out;
  return undefined;
}

/**
 * Unwraps wrapper modifiers (`ZodOptional`, `ZodDefault`, `ZodNullable`, `ZodReadonly`, `ZodEffects`, `ZodBranded`, `ZodCatch`, `ZodPipeline`) from a field schema.
 *
 * Iteratively strips outer modifier layers while accumulating `isOptional`, `hasDefault`,
 * `defaultValue`, `isNullable`, and the outermost `.describe(...)` string.
 *
 * @param {z.ZodTypeAny} schema - Field or root Zod schema to unwrap.
 *
 * @returns {UnwrappedZodField} Unwrapped inner schema and modifier flags.
 */
export function unwrapZodModifiers(schema: z.ZodTypeAny): UnwrappedZodField {
  let current: z.ZodTypeAny = schema;
  let isOptional = false;
  let hasDefault = false;
  let defaultValue: unknown = undefined;
  let isNullable = false;
  let description: string | undefined = schema.description;
  while (true) {
    const def = getZodDef(current);
    if (description === undefined && def.description !== undefined) description = def.description;
    if (def.typeName === 'ZodOptional' && def.innerType !== undefined) {
      isOptional = true;
      current = def.innerType;
    } else if (def.typeName === 'ZodDefault' && def.innerType !== undefined) {
      isOptional = true;
      hasDefault = true;
      if (typeof def.defaultValue === 'function') defaultValue = def.defaultValue();
      current = def.innerType;
    } else if (def.typeName === 'ZodNullable' && def.innerType !== undefined) {
      isNullable = true;
      current = def.innerType;
    } else {
      const next = unwrapTransparentLayer(def);
      if (next === undefined) break;
      current = next;
    }
  }
  return { innerSchema: current, isOptional, hasDefault, defaultValue, isNullable, description };
}

/**
 * Recursively sorts all plain-object property keys in alphabetical order across a JSON Schema tree.
 *
 * Ensures canonical key ordering for deterministic wire serialization and KV cache prefix stability.
 *
 * @template T JSON Schema value or nested container type.
 *
 * @param {T} value - Input JSON Schema value to canonicalize.
 *
 * @returns {T} Canonicalized JSON Schema value with alphabetically sorted object keys.
 */
export function sortJsonSchemaKeysCanonical<T>(value: T): T {
  if (typeof value !== 'object' || value === null) return value;
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) out.push(sortJsonSchemaKeysCanonical(item));
    return out as T;
  }
  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    sorted[key] = sortJsonSchemaKeysCanonical(record[key]);
  }
  return sorted as T;
}
