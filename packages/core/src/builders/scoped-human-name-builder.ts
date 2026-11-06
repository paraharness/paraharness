import type { z } from 'zod';
import type { ScopedHumanTargetBuilder } from './scoped-human-target-builder.js';

/**
 * Intermediate fluent builder returned by `human.withName(alias)` before binding `.output(responseSchema)`.
 *
 * Requires `.output(responseSchema)` to complete a typed `ScopedHumanTargetBuilder<TResponse>`
 * for budget approvals or human decision gates.
 */
export interface ScopedHumanNameBuilder {
  /**
   * Binds the Zod output validation schema for this aliased human decision target.
   *
   * Validates that the underlying `HumanNode` channel is `'bidirectional'` before constructing the target.
   *
   * @template TResponse Validated human decision response type.
   *
   * @param {z.ZodType<TResponse, z.ZodTypeDef, unknown>} responseSchema - Zod schema validating the human's response.
   *
   * @returns {ScopedHumanTargetBuilder<TResponse>} Fluent builder compiling to `ScopedHumanTargetNode<TResponse>`.
   *
   * @throws {Error} If the underlying `HumanNode` channel is not `'bidirectional'`.
   */
  output<TResponse>(
    responseSchema: z.ZodType<TResponse, z.ZodTypeDef, unknown>,
  ): ScopedHumanTargetBuilder<TResponse>;
}

export type { ScopedHumanNameBuilder as ScopedHumanAliasBuilder };
