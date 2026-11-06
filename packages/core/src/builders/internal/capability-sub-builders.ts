import type { z } from 'zod';
import type { ForkCapabilityNode } from '../../ast/fork-capability-node.js';
import type { ForkCapabilityBuilder } from '../fork-capability-builder.js';
import type { ForkModelRoutingBuilder } from '../fork-model-routing-builder.js';
import { createForkModelRoutingFromState } from './create-fork-model-routing-from-state.js';
import { deepFreeze } from './deep-freeze.js';
import type { ForkCapabilityBuilderState } from './fork-capability-builder-state.js';

export { createForkModelRoutingFromState };

/**
 * Creates a copy-on-write immutable `ForkCapabilityBuilder` from an internal state snapshot.
 *
 * Enforces that both `.requestSchema(schema)` and `.mapInput(fn)` are bound before
 * `.toAST()` compiles the `ForkCapabilityNode`.
 *
 * @template TParentIn Parent actor input payload type.
 * @template TReq      Fork request payload type.
 * @template TChildIn  Child executable input payload type.
 * @template TChildOut Child executable output payload type.
 * @template THandle   Isolation scope handle type.
 *
 * @param {ForkCapabilityBuilderState<TParentIn, TReq, TChildIn, TChildOut, THandle>} state - Current fork state.
 *
 * @returns {ForkCapabilityBuilder<TParentIn, TReq, TChildIn, TChildOut, THandle>} Frozen fork capability builder.
 */
export function createForkCapabilityFromState<
  TParentIn = unknown,
  TReq = unknown,
  TChildIn = unknown,
  TChildOut = unknown,
  THandle = unknown,
>(
  state: ForkCapabilityBuilderState<TParentIn, TReq, TChildIn, TChildOut, THandle>,
): ForkCapabilityBuilder<TParentIn, TReq, TChildIn, TChildOut, THandle> {
  return Object.freeze<ForkCapabilityBuilder<TParentIn, TReq, TChildIn, TChildOut, THandle>>({
    historyMode(
      mode: 'shared-prefix-only' | 'clone-transcript',
    ): ForkCapabilityBuilder<TParentIn, TReq, TChildIn, TChildOut, THandle> {
      return createForkCapabilityFromState({ ...state, historyMode: mode });
    },
    requestSchema<TNewReq>(
      schema: z.ZodType<TNewReq, z.ZodTypeDef, unknown>,
    ): ForkCapabilityBuilder<TParentIn, TNewReq, TChildIn, TChildOut, THandle> {
      return createForkCapabilityFromState<TParentIn, TNewReq, TChildIn, TChildOut, THandle>({
        toolName: state.toolName,
        childExecutable: state.childExecutable,
        historyMode: state.historyMode,
        requestSchema: schema,
        mapInput: undefined,
        modelRouting: undefined,
      });
    },
    mapInput(
      mapper: (parentInput: TParentIn, req: TReq) => TChildIn,
    ): ForkCapabilityBuilder<TParentIn, TReq, TChildIn, TChildOut, THandle> {
      return createForkCapabilityFromState({ ...state, mapInput: mapper });
    },
    modelRouting(
      configure: (
        $m: ForkModelRoutingBuilder<TParentIn, TReq>,
      ) => ForkModelRoutingBuilder<TParentIn, TReq>,
    ): ForkCapabilityBuilder<TParentIn, TReq, TChildIn, TChildOut, THandle> {
      const configured = configure(
        createForkModelRoutingFromState<TParentIn, TReq>({
          inheritParentEffort: undefined,
          otherwisePool: undefined,
        }),
      ).toAST();
      return createForkCapabilityFromState({ ...state, modelRouting: configured });
    },
    toAST(): ForkCapabilityNode<TParentIn, TReq, TChildIn, TChildOut, THandle> {
      if (state.requestSchema === undefined || state.mapInput === undefined) {
        throw new Error(
          `Fork capability '${state.toolName}' requires both .requestSchema(schema) and .mapInput(fn).`,
        );
      }
      return deepFreeze<ForkCapabilityNode<TParentIn, TReq, TChildIn, TChildOut, THandle>>({
        type: 'harness:fork-capability',
        toolName: state.toolName,
        childExecutable: state.childExecutable,
        historyMode: state.historyMode,
        requestSchema: state.requestSchema,
        mapInput: state.mapInput,
        modelRouting: state.modelRouting,
      });
    },
  });
}
