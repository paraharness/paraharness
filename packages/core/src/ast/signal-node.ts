import type { z } from 'zod';

/**
 * Passive AST node representing an asynchronous signal routed across streams, lanes, and stores.
 *
 * Signals notify external channels, trigger topology overlay commits, schedule ledger compaction,
 * or rewind active lane runs without unwinding in-flight execution call stacks unless bound to `.rewindTo()`.
 *
 * @template TPayload Validated output type of the signal payload schema.
 */
export interface SignalNode<TPayload = unknown> {
  /** Discriminant identifying a core signal definition node. */
  readonly type: 'harness:signal';
  /** Unique logical identifier of the signal. */
  readonly id: string;
  /** Zod schema used to validate payloads emitted for this signal. */
  readonly schema: z.ZodType<TPayload, z.ZodTypeDef, unknown>;
}
