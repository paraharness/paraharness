import type { z } from 'zod';

/**
 * Passive AST node representing a synchronous upward interrupt raised by an actor or policy guard.
 *
 * Raising an interrupt halts the active step or tool batch and transfers control to the nearest
 * enclosing `.onInterrupt()` or `.onChildInterrupt()` edge.
 *
 * @template TPayload Validated output type of the interrupt payload schema.
 */
export interface InterruptNode<TPayload = unknown> {
  /** Discriminant identifying a core interrupt definition node. */
  readonly type: 'harness:interrupt';
  /** Unique logical identifier of the interrupt. */
  readonly id: string;
  /** Zod schema used to validate payloads raised with this interrupt. */
  readonly schema: z.ZodType<TPayload, z.ZodTypeDef, unknown>;
}
