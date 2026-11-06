import type { MaybeBuilder } from '../ast/ast-foundation.types.js';
import type { StreamSourceASTNode } from '../ast/domain-ast.types.js';
import { extractAST } from '../ast/extract-ast.js';
import type { SignalNode } from '../ast/signal-node.js';
import type { StreamNode } from '../ast/stream-node.js';
import type { CreateStreamBuilderState as CreateStreamBuilderOptions } from './create-stream-builder-state.js';
import { assertNonEmptyIdentifier, deepFreeze } from './internal/deep-freeze.js';
import type { StreamBuilder } from './stream-builder.js';

/**
 * Creates a fluent `StreamBuilder` for `H.stream(id)`.
 *
 * Validates that `id` is non-empty and returns a copy-on-write immutable builder that
 * compiles into a deeply frozen `StreamNode`.
 *
 * @template TEvent   Inbound event type.
 * @template TPayload Outbound signal payload type.
 *
 * @param {string}                                       id        - Unique identifier of the stream.
 * @param {CreateStreamBuilderOptions<TEvent, TPayload>} [options] - Optional internal copy-on-write state.
 *
 * @returns {StreamBuilder<TEvent, TPayload>} Frozen `StreamBuilder` instance.
 */
export function createStreamBuilder<TEvent = unknown, TPayload = unknown>(
  id: string,
  options?: CreateStreamBuilderOptions<TEvent, TPayload>,
): StreamBuilder<TEvent, TPayload> {
  assertNonEmptyIdentifier('H.stream', id);
  return Object.freeze<StreamBuilder<TEvent, TPayload>>({
    id,
    source<TNextEvent>(
      streamSource: MaybeBuilder<StreamSourceASTNode<TNextEvent>>,
    ): StreamBuilder<TNextEvent, TPayload> {
      return createStreamBuilder<TNextEvent, TPayload>(id, {
        source: extractAST(streamSource),
        signal: options?.signal,
      });
    },
    filter(predicate: (event: TEvent) => boolean): StreamBuilder<TEvent, TPayload> {
      return createStreamBuilder<TEvent, TPayload>(id, {
        ...options,
        filterFn: predicate,
      });
    },
    emitSignal<TNextPayload>(
      signal: MaybeBuilder<SignalNode<TNextPayload>>,
      mapPayload: (event: TEvent) => TNextPayload,
    ): StreamBuilder<TEvent, TNextPayload> {
      return createStreamBuilder<TEvent, TNextPayload>(id, {
        source: options?.source,
        filterFn: options?.filterFn,
        signal: extractAST(signal),
        mapPayload,
      });
    },
    toAST(): StreamNode<TEvent, TPayload> {
      if (options?.source === undefined) {
        throw new Error(`Stream '${id}' is missing required .source(...) configuration.`);
      }
      if (options.signal === undefined || options.mapPayload === undefined) {
        throw new Error(
          `Stream '${id}' is missing required .emitSignal(signal, mapper) configuration.`,
        );
      }
      return deepFreeze<StreamNode<TEvent, TPayload>>({
        type: 'harness:stream',
        id,
        source: options.source,
        filterFn: options.filterFn,
        signal: options.signal,
        mapPayload: options.mapPayload,
      });
    },
  });
}
