import type { z } from 'zod';
import type { SignalBuilder } from '../ast/signal-builder.js';

/**
 * Fluent builder returned by `M.signal(id)` with `.payload(schema)` configuration and direct AST property access.
 *
 * Extends `SignalBuilder<TPayload>` so the builder can be passed directly wherever a
 * `SignalNode<TPayload>` or `AstBuilder<SignalNode<TPayload>>` is expected.
 *
 * @template TPayload Signal payload type validated by `schema`.
 */
export interface SignalPayloadBuilder<TPayload = unknown> extends SignalBuilder<TPayload> {
  /** Discriminant identifying a signal AST node. */
  readonly type: 'harness:signal';

  /**
   * Binds a Zod payload schema to the signal and returns a new immutable `SignalPayloadBuilder<TNext>`.
   *
   * Replaces the default `z.unknown()` payload schema while preserving the signal's `id`.
   *
   * @template TNext New signal payload output type inferred from `schema`.
   *
   * @param {z.ZodType<TNext>} schema - Zod schema validating signal payloads.
   *
   * @returns {SignalPayloadBuilder<TNext>} New immutable signal builder instance.
   */
  payload<TNext>(
    schema: z.ZodType<TNext>,
  ): SignalPayloadBuilder<TNext>;
}
