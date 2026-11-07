import type { z } from 'zod';
import type { MaybeBuilder } from '../ast/ast-foundation.types.js';
import type { HumanChannelASTNode } from '../ast/domain-ast.types.js';
import { extractAST } from '../ast/extract-ast.js';
import type { HumanNode } from '../ast/human-node.js';
import type { ScopedHumanTargetNode } from '../ast/scoped-human-target-node.js';
import type { CreateHumanBuilderState as CreateHumanBuilderOptions } from './create-human-builder-state.js';
import type { HumanBuilder } from './human-builder.js';
import { assertNonEmptyIdentifier, deepFreeze } from './internal/deep-freeze.js';
import { validateBidirectionalHumanChannel } from './internal/validate-agent-and-human-capabilities.js';
import type { ScopedHumanNameBuilder as ScopedHumanAliasBuilder } from './scoped-human-name-builder.js';
import type { ScopedHumanTargetBuilder } from './scoped-human-target-builder.js';

/**
 * Creates a fluent `HumanBuilder` for `H.human(id)`.
 *
 * Tracks the channel interaction mode (`'bidirectional' | 'notify-only'`) and validates
 * that `.withName(alias).output(schema)` is only called on bidirectional channels.
 *
 * @template TMode Interaction mode (`'bidirectional' | 'notify-only'`).
 *
 * @param {string}                           id        - Unique identifier of the human authority role.
 * @param {CreateHumanBuilderOptions<TMode>} [options] - Optional internal copy-on-write state.
 *
 * @returns {HumanBuilder<TMode>} Frozen `HumanBuilder` instance.
 */
export function createHumanBuilder<
  TMode extends 'bidirectional' | 'notify-only' = 'bidirectional' | 'notify-only',
>(id: string, options?: CreateHumanBuilderOptions<TMode>): HumanBuilder<TMode> {
  assertNonEmptyIdentifier('H.human', id);
  const compileNode = (): HumanNode<TMode> => {
    if (options?.channel === undefined) {
      throw new Error(`Human '${id}' is missing required .notify(channel) configuration.`);
    }
    return deepFreeze<HumanNode<TMode>>({
      type: 'harness:human',
      id,
      keepAliveSeconds: options.keepAliveSeconds,
      channel: options.channel,
    });
  };

  return Object.freeze<HumanBuilder<TMode>>({
    id,
    keepAliveSeconds(seconds: number): HumanBuilder<TMode> {
      return createHumanBuilder<TMode>(id, {
        ...options,
        keepAliveSeconds: seconds,
      });
    },
    notify<TNextMode extends 'bidirectional' | 'notify-only'>(
      channel: MaybeBuilder<HumanChannelASTNode<TNextMode>>,
    ): HumanBuilder<TNextMode> {
      return createHumanBuilder<TNextMode>(id, {
        keepAliveSeconds: options?.keepAliveSeconds,
        channel: extractAST(channel),
      });
    },
    withName(alias: string): ScopedHumanAliasBuilder {
      assertNonEmptyIdentifier('H.human.withName', alias);
      return Object.freeze<ScopedHumanAliasBuilder>({
        output<TResponse>(
          responseSchema: z.ZodType<TResponse>,
        ): ScopedHumanTargetBuilder<TResponse> {
          const bidirectionalHuman = validateBidirectionalHumanChannel(
            compileNode(),
            'H.human.withName().output()',
          );
          const scopedNode: ScopedHumanTargetNode<TResponse> = deepFreeze<
            ScopedHumanTargetNode<TResponse>
          >({
            type: 'harness:scoped-human',
            human: bidirectionalHuman,
            alias,
            outputSchema: responseSchema,
          });
          return Object.freeze<ScopedHumanTargetBuilder<TResponse>>({
            human: bidirectionalHuman,
            alias,
            outputSchema: responseSchema,
            toAST(): ScopedHumanTargetNode<TResponse> {
              return scopedNode;
            },
          });
        },
      });
    },
    toAST(): HumanNode<TMode> {
      return compileNode();
    },
  });
}
