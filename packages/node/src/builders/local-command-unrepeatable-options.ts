import type { BivariantCallback } from '@harness-dsl/core';

/**
 * Options for configuring an idempotency guard on `local.command().unrepeatable(preCheckCmd, options)`.
 *
 * Supplies a static deduplication key or a synchronous mapper extracting the deduplication key from the command input.
 *
 * @template TIn Validated command input payload type.
 */
export interface LocalCommandUnrepeatableOptions<TIn = unknown> {
  /** Static deduplication key or synchronous mapper deriving the key from `TIn`. */
  readonly key: string | BivariantCallback<[input: TIn], string>;
}
