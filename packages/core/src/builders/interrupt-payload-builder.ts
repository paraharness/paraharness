import type { z } from 'zod';
import type { InterruptBuilder } from '../ast/interrupt-builder.js';

/**
 * Fluent builder returned by `P.interrupt(id)` with `.payload(schema)` configuration and direct AST property access.
 *
 * Extends `InterruptBuilder<TPayload>` so the builder can be passed directly wherever an
 * `InterruptNode<TPayload>` or `AstBuilder<InterruptNode<TPayload>>` is expected.
 *
 * @template TPayload Interrupt payload type validated by `schema`.
 */
export interface InterruptPayloadBuilder<TPayload = unknown>
  extends InterruptBuilder<TPayload> {
  /** Discriminant identifying an interrupt AST node. */
  readonly type: 'harness:interrupt';

  /**
   * Binds a Zod payload schema to the interrupt and returns a new immutable `InterruptPayloadBuilder<TNext>`.
   *
   * Replaces the default `z.unknown()` payload schema while preserving the interrupt's `id`.
   *
   * @template TNext New interrupt payload output type inferred from `schema`.
   *
   * @param {z.ZodType<TNext>} schema - Zod schema validating interrupt payloads.
   *
   * @returns {InterruptPayloadBuilder<TNext>} New immutable interrupt builder instance.
   */
  payload<TNext>(
    schema: z.ZodType<TNext>,
  ): InterruptPayloadBuilder<TNext>;
}
