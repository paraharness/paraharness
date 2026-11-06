import type { BaseCrossVerifierASTNode } from '../base/base-cross-verifier-ast-node.js';
import type { GitScopeReceipt } from './git-scope-receipt.js';
import type { GitWorktreeHandle } from './git-worktree-handle.js';

/**
 * Passive AST node comparing patch equivalence across speculative worktree candidates (`git.patchEquivalence`).
 *
 * Computes normalized patch diffs across surviving tournament branches and groups byte- or AST-equivalent
 * patches into equivalence classes for the speculative arbiter.
 *
 * @template TCrossReport Validated cross-verification report type.
 */
export interface GitPatchEquivalenceNode<TCrossReport = Record<string, unknown>>
  extends BaseCrossVerifierASTNode<
    'git:patch-equivalence',
    GitWorktreeHandle,
    GitScopeReceipt,
    TCrossReport
  > {}
