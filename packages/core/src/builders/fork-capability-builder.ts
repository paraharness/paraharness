import type { z } from 'zod';
import type { AstBuilder } from '../ast/ast-builder.js';
import type { ForkCapabilityNode } from '../ast/fork-capability-node.js';
import type { ForkModelRoutingBuilder } from './fork-model-routing-builder.js';

/**
 * Fluent sub-builder for a downward child fork capability (`$cap.fork(toolName, childExecutable, $f => ...)`).
 *
 * Configures transcript sharing (`historyMode`), request validation (`requestSchema`),
 * child input projection (`mapInput`), and conditional model routing (`modelRouting`).
 *
 * @template TParentIn Parent actor input payload type.
 * @template TReq      Validated fork tool request payload type.
 * @template TChildIn  Child executable input payload type.
 * @template TChildOut Child executable output payload type.
 * @template THandle   Runtime handle type of the active `BranchableScope`.
 */
export interface ForkCapabilityBuilder<
  TParentIn = unknown,
  TReq = unknown,
  TChildIn = unknown,
  TChildOut = unknown,
  THandle = unknown,
> extends AstBuilder<ForkCapabilityNode<TParentIn, TReq, TChildIn, TChildOut, THandle>> {
  /**
   * Configures the transcript history sharing mode (`'shared-prefix-only'` or `'clone-transcript'`).
   *
   * Defaults to `'shared-prefix-only'`; `'clone-transcript'` requires `toolsMode: 'union'` when toolsets differ.
   *
   * @param {'shared-prefix-only' | 'clone-transcript'} mode - Transcript sharing mode.
   *
   * @returns {ForkCapabilityBuilder<TParentIn, TReq, TChildIn, TChildOut, THandle>} New immutable fork builder.
   */
  historyMode(
    mode: 'shared-prefix-only' | 'clone-transcript',
  ): ForkCapabilityBuilder<TParentIn, TReq, TChildIn, TChildOut, THandle>;

  /**
   * Binds the Zod validation schema for the parent agent's fork tool call arguments.
   *
   * Resets any previously bound `mapInput` or `modelRouting` callbacks when the request type changes.
   *
   * @template TNewReq Validated fork request payload type.
   *
   * @param {z.ZodType<TNewReq, z.ZodTypeDef, unknown>} schema - Zod schema for the fork request.
   *
   * @returns {ForkCapabilityBuilder<TParentIn, TNewReq, TChildIn, TChildOut, THandle>} New immutable fork builder.
   */
  requestSchema<TNewReq>(
    schema: z.ZodType<TNewReq, z.ZodTypeDef, unknown>,
  ): ForkCapabilityBuilder<TParentIn, TNewReq, TChildIn, TChildOut, THandle>;

  /**
   * Binds the synchronous mapper projecting `(parentInput, req)` into the child executable's input `TChildIn`.
   *
   * Invoked before branching the isolation scope and starting the child executable.
   *
   * @param {(parentInput: TParentIn, req: TReq) => TChildIn} mapper - Child input projection callback.
   *
   * @returns {ForkCapabilityBuilder<TParentIn, TReq, TChildIn, TChildOut, THandle>} New immutable fork builder.
   */
  mapInput(
    mapper: (parentInput: TParentIn, req: TReq) => TChildIn,
  ): ForkCapabilityBuilder<TParentIn, TReq, TChildIn, TChildOut, THandle>;

  /**
   * Configures conditional model routing for the forked child session.
   *
   * Invokes `configure` with a `ForkModelRoutingBuilder` and attaches the resulting routing config.
   *
   * @param {($m: ForkModelRoutingBuilder<TParentIn, TReq>) => ForkModelRoutingBuilder<TParentIn, TReq>} configure - Model routing configurator callback.
   *
   * @returns {ForkCapabilityBuilder<TParentIn, TReq, TChildIn, TChildOut, THandle>} New immutable fork builder.
   */
  modelRouting(
    configure: (
      $m: ForkModelRoutingBuilder<TParentIn, TReq>,
    ) => ForkModelRoutingBuilder<TParentIn, TReq>,
  ): ForkCapabilityBuilder<TParentIn, TReq, TChildIn, TChildOut, THandle>;
}
