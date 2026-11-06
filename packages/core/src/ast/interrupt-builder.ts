import type { z } from 'zod';
import type { AstBuilder } from './ast-builder.js';
import type { InterruptNode } from './interrupt-node.js';

/**
 * Immutable fluent builder and property projection for `InterruptNode`.
 *
 * Exposes `id`, `type`, and `schema` directly on the builder instance so adjudicator input
 * schemas and union schemas can reference `interrupt.schema` directly.
 *
 * @template TPayload Validated output type of the interrupt payload schema.
 */
export interface InterruptBuilder<TPayload = unknown> extends AstBuilder<InterruptNode<TPayload>> {
  /** Discriminant identifying a core interrupt definition node. */
  readonly type: 'harness:interrupt';
  /** Unique logical identifier of the interrupt. */
  readonly id: string;
  /** Zod schema used to validate payloads raised with this interrupt. */
  readonly schema: z.ZodType<TPayload, z.ZodTypeDef, unknown>;

  /**
   * Binds a new Zod payload schema to the interrupt definition, returning a strongly typed builder clone.
   *
   * Preserves the interrupt `id` while replacing `schema` on a newly frozen copy-on-write
   * `InterruptBuilder<TNext>` instance.
   *
   * @template TNext Validated output type of `schema`.
   *
   * @param {z.ZodType<TNext, z.ZodTypeDef, unknown>} schema - Zod schema governing raised interrupt payloads.
   *
   * @returns {InterruptBuilder<TNext>} New immutable `InterruptBuilder` typed to `TNext`.
   */
  payload<TNext>(schema: z.ZodType<TNext, z.ZodTypeDef, unknown>): InterruptBuilder<TNext>;
}
