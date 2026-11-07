import {
  extractAST,
  z,
  type CrossVerifierBuilder,
  type GitPublicSurfaceCrossTesterNode,
  type GitScopeReceipt,
  type GitWorktreeHandle,
} from '@harness-dsl/core';
import type { GitPublicSurfaceCrossTesterOptions } from './git-public-surface-cross-tester-options.js';

/**
 * Creates a `CrossVerifierBuilder` for AST-gated public-boundary cross-testing (`git.publicSurfaceCrossTester`).
 *
 * Exposes `.id`, `.reportSchema`, and `.toAST()` producing a passive `GitPublicSurfaceCrossTesterNode`
 * that transplants boundary-only tests across surviving speculative candidate branches.
 *
 * @param {GitPublicSurfaceCrossTesterOptions} options - Runner pool and filesystem partition map configuration.
 *
 * @returns {CrossVerifierBuilder<GitWorktreeHandle, GitScopeReceipt, Record<string, unknown>, GitPublicSurfaceCrossTesterNode>} Immutable cross-verifier builder.
 */
export function createGitPublicSurfaceCrossTesterBuilder(
  options: GitPublicSurfaceCrossTesterOptions,
): CrossVerifierBuilder<
  GitWorktreeHandle,
  GitScopeReceipt,
  Record<string, unknown>,
  GitPublicSurfaceCrossTesterNode
> {
  const id = options.id ?? 'git-public-surface-cross-tester';
  const reportSchema: z.ZodType<Record<string, unknown>> = z
    .object({
      passedCrossTests: z.number(),
      failedCrossTests: z.number(),
      crossTestDeficits: z.array(z.string()),
      transplantedTestFiles: z.array(z.string()),
    })
    .passthrough();
  return Object.freeze<
    CrossVerifierBuilder<
      GitWorktreeHandle,
      GitScopeReceipt,
      Record<string, unknown>,
      GitPublicSurfaceCrossTesterNode
    >
  >({
    id,
    reportSchema,
    toAST(): GitPublicSurfaceCrossTesterNode {
      return Object.freeze<GitPublicSurfaceCrossTesterNode>({
        type: 'git:public-surface-cross-tester',
        id,
        reportSchema,
        runner: extractAST(options.runner),
        partitionMap: extractAST(options.partitionMap),
      });
    },
  });
}
