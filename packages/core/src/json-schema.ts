import { z } from 'zod';

export function zodToJsonSchema(schema: z.ZodTypeAny): Readonly<Record<string, unknown>> {
  if (schema instanceof z.ZodOptional) {
    return zodToJsonSchema(schema.unwrap());
  }

  if (schema instanceof z.ZodDefault) {
    const inner = zodToJsonSchema(schema.removeDefault());
    return {
      ...inner,
      default: schema._def.defaultValue(),
    };
  }

  if (schema instanceof z.ZodNullable) {
    const inner = zodToJsonSchema(schema.unwrap());
    return {
      ...inner,
      nullable: true,
    };
  }

  if (schema instanceof z.ZodObject) {
    const shape: z.ZodRawShape = schema.shape;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (const key of Object.keys(shape)) {
      const fieldSchema = shape[key];
      if (!fieldSchema) continue;
      properties[key] = zodToJsonSchema(fieldSchema);
      if (!fieldSchema.isOptional()) {
        required.push(key);
      }
    }

    return {
      type: 'object',
      properties,
      required,
      additionalProperties: false,
    };
  }

  if (schema instanceof z.ZodString) {
    const result: Record<string, unknown> = { type: 'string' };
    for (const check of schema._def.checks) {
      if (check.kind === 'min') result.minLength = check.value;
      else if (check.kind === 'max') result.maxLength = check.value;
    }
    return result;
  }

  if (schema instanceof z.ZodNumber) {
    const result: Record<string, unknown> = { type: 'number' };
    for (const check of schema._def.checks) {
      if (check.kind === 'min') result.minimum = check.value;
      else if (check.kind === 'max') result.maximum = check.value;
    }
    return result;
  }

  if (schema instanceof z.ZodBoolean) {
    return { type: 'boolean' };
  }

  if (schema instanceof z.ZodArray) {
    const result: Record<string, unknown> = {
      type: 'array',
      items: zodToJsonSchema(schema.element),
    };
    if (schema._def.minLength !== null) {
      result.minItems = schema._def.minLength.value;
    }
    if (schema._def.maxLength !== null) {
      result.maxItems = schema._def.maxLength.value;
    }
    return result;
  }

  if (schema instanceof z.ZodEnum) {
    return {
      type: 'string',
      enum: [...schema.options],
    };
  }

  if (schema instanceof z.ZodLiteral) {
    const val: unknown = schema.value;
    const valType = typeof val;
    if (valType === 'string' || valType === 'number' || valType === 'boolean') {
      return {
        type: valType,
        const: val,
        enum: [val],
      };
    }
    return { const: val };
  }

  if (schema instanceof z.ZodUnion) {
    const options = schema.options.map((opt: z.ZodTypeAny) => zodToJsonSchema(opt));
    return { anyOf: options };
  }

  if (schema instanceof z.ZodDiscriminatedUnion) {
    const options = schema.options.map((opt: z.ZodTypeAny) => zodToJsonSchema(opt));
    return {
      discriminator: { propertyName: schema.discriminator },
      oneOf: options,
      anyOf: options,
    };
  }

  if (schema instanceof z.ZodRecord) {
    return {
      type: 'object',
      additionalProperties: zodToJsonSchema(schema.valueSchema),
    };
  }

  if (schema instanceof z.ZodUnknown || schema instanceof z.ZodAny) {
    return {};
  }

  return {};
}
