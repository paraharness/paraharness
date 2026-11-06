import type { z } from 'zod';

/**
 * Result of unwrapping optional, default, readonly, branded, and effect modifiers from a Zod schema.
 *
 * Captures the innermost core Zod schema alongside accumulated optionality, nullability,
 * default-value, and description metadata required during JSON Schema serialization.
 */
export interface UnwrappedZodField {
  /** Underlying core Zod schema after stripping wrapper modifiers. */
  readonly innerSchema: z.ZodTypeAny;
  /** True when the field is optional (`ZodOptional` or `ZodDefault`). */
  readonly isOptional: boolean;
  /** True when the field declares a `.default(...)` value. */
  readonly hasDefault: boolean;
  /** Default value returned by `.default(...)` when `hasDefault` is `true`. */
  readonly defaultValue: unknown;
  /** True when the field is wrapped in `.nullable()`. */
  readonly isNullable: boolean;
  /** Optional description attached to the outer or inner schema via `.describe(...)`. */
  readonly description: string | undefined;
}
