import type { z } from 'zod';
import type { AstBuilder } from './ast-builder.js';
import type { SignalNode } from './signal-node.js';

/**
 * Immutable fluent builder and property projection for `SignalNode`.
 *
 * Exposes `id`, `type`, and `schema` directly on the builder instance so downstream schemas and
 * builders can reference `signal.schema` with or without calling `.toAST()`.
 *
 * @template TPayload Validated output type of the signal payload schema.
 */
export interface SignalBuilder<TPayload = unknown> extends AstBuilder<SignalNode<TPayload>> {
  /** Discriminant identifying a core signal definition node. */
  readonly type: 'harness:signal';
  /** Unique logical identifier of the signal. */
  readonly id: string;
  /** Zod schema used to validate payloads emitted for this signal. */
  readonly schema: z.ZodType<TPayload, z.ZodTypeDef, unknown>;

  /**
   * Binds a new Zod payload schema to the signal definition, returning a strongly typed builder clone.
   *
   * Preserves the signal `id` while replacing `schema` on a newly frozen copy-on-write
   * `SignalBuilder<TNext>` instance.
   *
   * @template TNext Validated output type of `schema`.
   *
   * @param {z.ZodType<TNext, z.ZodTypeDef, unknown>} schema - Zod schema governing emitted signal payloads.
   *
   * @returns {SignalBuilder<TNext>} New immutable `SignalBuilder` typed to `TNext`.
   */
  payload<TNext>(schema: z.ZodType<TNext, z.ZodTypeDef, unknown>): SignalBuilder<TNext>;
}
