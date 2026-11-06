import type { z } from 'zod';

/**
 * Static wire tool schema descriptor declared by a lifecycle-bound `BaseServiceASTNode`.
 *
 * Registered in the actor's wire `tools` array from Turn 0 so skill activation never mutates
 * the provider KV prefix cache.
 */
export interface ServiceToolSchemaDescriptor {
  /** Wire-level tool name exposed for interacting with the service. */
  readonly name: string;
  /** Description of the interaction tool's purpose. */
  readonly description: string;
  /** Zod schema validating interaction tool arguments. */
  readonly inputSchema: z.ZodTypeAny;
}

/**
 * Domain-agnostic base AST node contract for lifecycle-bound background services (`ServiceASTNode`).
 *
 * Services are acquired via `RuntimeExecutorRegistry.services[node.type]` and automatically
 * quiesced at step boundaries, fork suspensions, and tournament park barriers.
 *
 * @template TType   String-literal discriminant of the service node.
 * @template THandle Isolation scope handle type associated with the service.
 */
export interface BaseServiceASTNode<TType extends string = string, THandle = unknown> {
  /** Unique string-literal discriminant of the service node. */
  readonly type: TType;
  /** Logical identifier of the service definition. */
  readonly id: string;
  /** Lifecycle scope governing when the service daemon is started and stopped. */
  readonly lifecycle: 'scope' | 'fork' | 'skill';
  /** Up-front tool schema descriptors for all interaction tools exposed by this service. */
  readonly toolSchemas: readonly ServiceToolSchemaDescriptor[];
  /** Phantom type brand binding the service to its compatible scope handle type. */
  readonly __handleBrand?: THandle;
}
