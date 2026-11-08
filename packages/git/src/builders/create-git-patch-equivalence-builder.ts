import {
  z,
  type CrossVerifierBuilder,
  type GitPatchEquivalenceNode,
  type GitScopeReceipt,
  type GitWorktreeHandle,
} from '@paraharness/core';

/**
 * Creates a `CrossVerifierBuilder` for normalized patch equivalence clustering (`git.patchEquivalence`).
 *
 * Exposes `.id`, `.reportSchema`, and `.toAST()` producing a passive `GitPatchEquivalenceNode`
 * that groups surviving speculative branches with equivalent normalized diffs into equivalence classes.
 *
 * @param {string} [id='git-patch-equivalence'] - Optional unique identifier for the cross-verifier node.
 *
 * @returns {CrossVerifierBuilder<GitWorktreeHandle, GitScopeReceipt, Record<string, unknown>, GitPatchEquivalenceNode>} Immutable cross-verifier builder.
 */
export function createGitPatchEquivalenceBuilder(
  id = 'git-patch-equivalence',
): CrossVerifierBuilder<
  GitWorktreeHandle,
  GitScopeReceipt,
  Record<string, unknown>,
  GitPatchEquivalenceNode
> {
  const reportSchema: z.ZodType<Record<string, unknown>> = z
    .object({
      equivalenceGroupIndex: z.number(),
      equivalentBranchIndices: z.array(z.number()),
      normalizedPatchDigest: z.string(),
    })
    .passthrough();
  return Object.freeze<
    CrossVerifierBuilder<
      GitWorktreeHandle,
      GitScopeReceipt,
      Record<string, unknown>,
      GitPatchEquivalenceNode
    >
  >({
    id,
    reportSchema,
    toAST(): GitPatchEquivalenceNode {
      return Object.freeze<GitPatchEquivalenceNode>({
        type: 'git:patch-equivalence',
        id,
        reportSchema,
      });
    },
  });
}
