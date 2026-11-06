import type { z } from 'zod';
import type { CompiledWirePrefix, WireToolSchema } from './compiled-wire-prefix.js';
import type { WireFrameRecord } from './wire-frame-record.js';

/**
 * Request parameters passed to `ModelDriver.invokeTurn()`.
 *
 * Encapsulates the target provider model identifier, account seat credentials, reasoning effort,
 * tool calling mode, pinned wire prefix, conversation transcript, and structured output schema.
 */
export interface ModelTurnRequest {
  /** Provider model identifier (such as `'claude-sonnet-4-6'`). */
  readonly modelId: string;
  /** Optional resolved account seat configuration or credentials. */
  readonly accountConfig?: unknown;
  /** Optional reasoning effort level (`'low' | 'medium' | 'high'`). */
  readonly effort?: 'low' | 'medium' | 'high';
  /** Tool calling mode (`'auto'` during normal turns, `'none'` during epistemic flush turns). */
  readonly toolChoice?: 'auto' | 'none';
  /** Optional pinned `CompiledWirePrefix` for the actor's prefix group. */
  readonly wirePrefix?: CompiledWirePrefix;
  /** Optional canonical `roleKey` selecting `wirePrefix.wireToolSchemasByRoleKey[roleKey]`. */
  readonly roleKey?: string;
  /** Ordered conversation transcript frames leading up to this turn. */
  readonly history: readonly WireFrameRecord[];
  /** Explicit wire tool schemas used when the actor is not bound to a `CompiledWirePrefix`. */
  readonly wireToolSchemas?: readonly WireToolSchema[];
  /** Optional Zod schema enforced on structured-output completion or flush turns. */
  readonly outputSchema?: z.ZodTypeAny;
  /** Optional abort signal cancelling the in-flight HTTP request. */
  readonly signal?: AbortSignal;
}
