import type { z } from 'zod';

/**
 * Internal definition shape exposed on `schema._def` across standard Zod schema types.
 *
 * Provides typed read-only access to Zod's internal `_def` properties without unsafe `any`
 * casts during recursive JSON Schema conversion.
 */
export interface InternalZodDef {
  /** Zod internal type discriminant (such as `'ZodObject'`, `'ZodString'`, or `'ZodUnion'`). */
  readonly typeName?: string;
  /** Optional human-readable description attached via `.describe(...)`. */
  readonly description?: string;
  /** Inner wrapped schema for `ZodOptional`, `ZodDefault`, `ZodNullable`, `ZodReadonly`, `ZodCatch`, and `ZodBranded`. */
  readonly innerType?: z.ZodTypeAny;
  /** Underlying input schema for `ZodEffects`. */
  readonly schema?: z.ZodTypeAny;
  /** Target output schema for `ZodPipeline`. */
  readonly out?: z.ZodTypeAny;
  /** Thunk returning the configured default value for `ZodDefault`. */
  readonly defaultValue?: () => unknown;
  /** Literal constant value for `ZodLiteral`. */
  readonly value?: unknown;
  /** Allowed enum values array (`ZodEnum`) or enum object (`ZodNativeEnum`). */
  readonly values?: readonly unknown[] | Record<string, string | number>;
  /** Element schema for `ZodArray`. */
  readonly type?: z.ZodTypeAny;
  /** Ordered tuple element schemas for `ZodTuple`. */
  readonly items?: readonly z.ZodTypeAny[];
  /** Optional variadic rest element schema for `ZodTuple`. */
  readonly rest?: z.ZodTypeAny | null;
  /** Value schema for `ZodRecord`. */
  readonly valueType?: z.ZodTypeAny;
  /** Thunk returning the property schema dictionary for `ZodObject`. */
  readonly shape?: () => Record<string, z.ZodTypeAny>;
  /** Unknown key handling mode (`'passthrough' | 'strict' | 'strip'`) for `ZodObject`. */
  readonly unknownKeys?: 'passthrough' | 'strict' | 'strip';
  /** Member option schemas for `ZodUnion` and `ZodDiscriminatedUnion`. */
  readonly options?: readonly z.ZodTypeAny[];
  /** Discriminator property name for `ZodDiscriminatedUnion`. */
  readonly discriminator?: string;
  /** Left-hand operand schema for `ZodIntersection`. */
  readonly left?: z.ZodTypeAny;
  /** Right-hand operand schema for `ZodIntersection`. */
  readonly right?: z.ZodTypeAny;
}
