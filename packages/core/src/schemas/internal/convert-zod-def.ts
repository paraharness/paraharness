import type { z } from 'zod';
import type { InternalZodDef } from './internal-zod-def.js';
import { getZodDef, unwrapZodModifiers } from './unwrap-zod-field.js';

/**
 * Converts a `ZodObject` shape dictionary into JSON Schema `properties`, `required`, and `additionalProperties` fields.
 *
 * Sorts object property keys lexicographically so generated JSON Schemas remain deterministic
 * across V8 object key insertion orders.
 *
 * @param {InternalZodDef} def - Internal definition of a `ZodObject` schema.
 *
 * @returns {Record<string, unknown>} JSON Schema object descriptor.
 */
export function convertObjectShape(def: InternalZodDef): Record<string, unknown> {
  const shapeRecord = typeof def.shape === 'function' ? def.shape() : {};
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  const sortedKeys = Object.keys(shapeRecord).sort();
  for (const key of sortedKeys) {
    const fieldSchema = shapeRecord[key];
    if (fieldSchema === undefined) continue;
    const unwrapped = unwrapZodModifiers(fieldSchema);
    properties[key] = convertZodDefToJsonSchema(fieldSchema);
    if (!unwrapped.isOptional) required.push(key);
  }
  const result: Record<string, unknown> = {
    type: 'object',
    properties,
    additionalProperties: def.unknownKeys === 'passthrough',
  };
  if (required.length > 0) result.required = required;
  return result;
}

/**
 * Converts composite Zod definitions (`ZodArray`, `ZodTuple`, `ZodRecord`, `ZodObject`, `ZodUnion`, `ZodDiscriminatedUnion`, `ZodIntersection`) into JSON Schema.
 *
 * Recursively converts nested element, option, property, and operand schemas while preserving
 * tuple `prefixItems` and discriminated union `discriminator` metadata.
 *
 * @param {InternalZodDef} def - Unwrapped composite internal Zod definition.
 *
 * @returns {Record<string, unknown>} JSON Schema representation of the composite type.
 */
function convertCompositeTypeName(def: InternalZodDef): Record<string, unknown> {
  switch (def.typeName) {
    case 'ZodArray':
      return { type: 'array', items: def.type !== undefined ? convertZodDefToJsonSchema(def.type) : {} };
    case 'ZodTuple': {
      const prefixItems: Record<string, unknown>[] = [];
      for (const item of def.items ?? []) prefixItems.push(convertZodDefToJsonSchema(item));
      const items = def.rest !== undefined && def.rest !== null ? convertZodDefToJsonSchema(def.rest) : false;
      return { type: 'array', prefixItems, items };
    }
    case 'ZodRecord':
      return { type: 'object', additionalProperties: def.valueType !== undefined ? convertZodDefToJsonSchema(def.valueType) : {} };
    case 'ZodObject':
      return convertObjectShape(def);
    case 'ZodUnion':
    case 'ZodDiscriminatedUnion': {
      const anyOf: Record<string, unknown>[] = [];
      for (const option of def.options ?? []) anyOf.push(convertZodDefToJsonSchema(option));
      const unionResult: Record<string, unknown> = { anyOf };
      if (def.typeName === 'ZodDiscriminatedUnion' && def.discriminator !== undefined) {
        unionResult.discriminator = { propertyName: def.discriminator };
      }
      return unionResult;
    }
    case 'ZodIntersection':
      return {
        allOf: [
          def.left !== undefined ? convertZodDefToJsonSchema(def.left) : {},
          def.right !== undefined ? convertZodDefToJsonSchema(def.right) : {},
        ],
      };
    default:
      return {};
  }
}

/**
 * Converts an unwrapped core `InternalZodDef` into its baseline JSON Schema representation.
 *
 * Handles primitive scalar, literal, enum, and `ZodNever` types directly and delegates
 * collection, object, union, and intersection types to `convertCompositeTypeName`.
 *
 * @param {InternalZodDef} def - Unwrapped internal Zod definition.
 *
 * @returns {Record<string, unknown>} Baseline JSON Schema object before modifier decoration.
 */
function convertCoreTypeName(def: InternalZodDef): Record<string, unknown> {
  switch (def.typeName) {
    case 'ZodString':
      return { type: 'string' };
    case 'ZodNumber':
      return { type: 'number' };
    case 'ZodBigInt':
      return { type: 'integer' };
    case 'ZodBoolean':
      return { type: 'boolean' };
    case 'ZodNull':
      return { type: 'null' };
    case 'ZodDate':
      return { type: 'string', format: 'date-time' };
    case 'ZodLiteral':
      return { const: def.value, type: typeof def.value };
    case 'ZodEnum':
      return { type: 'string', enum: Array.isArray(def.values) ? [...def.values] : [] };
    case 'ZodNativeEnum': {
      const rawValues = def.values !== undefined && !Array.isArray(def.values) ? Object.values(def.values) : [];
      return { enum: rawValues };
    }
    case 'ZodNever':
      return { not: {} };
    default:
      return convertCompositeTypeName(def);
  }
}

/**
 * Recursively converts any `z.ZodTypeAny` schema (including modifiers) into a plain JSON Schema object.
 *
 * Unwraps outer modifiers via `unwrapZodModifiers`, converts the core definition, and attaches
 * nullable `anyOf`, `default`, and `description` attributes when present.
 *
 * @param {z.ZodTypeAny} schema - Input Zod schema to convert.
 *
 * @returns {Record<string, unknown>} Plain JSON Schema object.
 */
export function convertZodDefToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const unwrapped = unwrapZodModifiers(schema);
  const coreSchema = convertCoreTypeName(getZodDef(unwrapped.innerSchema));
  const finalSchema: Record<string, unknown> = unwrapped.isNullable
    ? { anyOf: [coreSchema, { type: 'null' }] }
    : { ...coreSchema };
  if (unwrapped.hasDefault) finalSchema.default = unwrapped.defaultValue;
  if (unwrapped.description !== undefined) finalSchema.description = unwrapped.description;
  return finalSchema;
}
