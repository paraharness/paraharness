import {
  extractAST,
  z,
  type LocalCommandNode,
  type MaybeBuilder,
} from '@harness-dsl/core';

/**
 * Normalizes a typed pre-check command builder or node into `LocalCommandNode<unknown, boolean, THandle>`.
 *
 * Wraps the input schema and argument/stdin mappers so `LocalCommandUnrepeatableConfig` stores
 * the pre-check command without type assertions.
 *
 * @template TPreIn  Pre-check command input payload type.
 * @template THandle Isolation scope handle type.
 *
 * @param {MaybeBuilder<LocalCommandNode<TPreIn, boolean, THandle>>} preCheckCmd - Pre-check command node or builder.
 *
 * @returns {LocalCommandNode<unknown, boolean, THandle>} Normalized passive pre-check command node.
 */
export function normalizeUnrepeatablePreCheckNode<TPreIn, THandle>(
  preCheckCmd: MaybeBuilder<LocalCommandNode<TPreIn, boolean, THandle>>,
): LocalCommandNode<unknown, boolean, THandle> {
  const rawNode = extractAST(preCheckCmd);
  const rawArgv = rawNode.argv;
  const rawStdin = rawNode.stdinMode;
  return Object.freeze<LocalCommandNode<unknown, boolean, THandle>>({
    type: 'node:command',
    id: rawNode.id,
    inputSchema: z.unknown(),
    outputSchema: rawNode.outputSchema,
    runner: rawNode.runner,
    argv:
      typeof rawArgv === 'function'
        ? (input: unknown): readonly string[] => rawArgv(rawNode.inputSchema.parse(input))
        : rawArgv,
    stdinMode:
      rawStdin === 'closed'
        ? 'closed'
        : (input: unknown): string | Uint8Array => rawStdin(rawNode.inputSchema.parse(input)),
    env: rawNode.env,
    timeoutMinutes: rawNode.timeoutMinutes,
    unrepeatable: undefined,
  });
}
