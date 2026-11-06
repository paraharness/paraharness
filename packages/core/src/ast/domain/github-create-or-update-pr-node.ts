import type { BivariantCallback } from '../ast-foundation.types.js';
import type { BaseDomainStepASTNode } from '../base/base-domain-step-ast-node.js';
import type { EnvRef } from '../env-ref.js';

/**
 * Passive AST node creating or updating a GitHub pull request (`github.createOrUpdatePr`).
 *
 * Idempotently opens a new pull request or updates an existing open pull request for `branch`
 * against `baseBranch` in `repo`.
 *
 * @template TIn     Validated step input type.
 * @template TOut    Validated step output type.
 * @template THandle Isolation scope handle type.
 */
export interface GithubCreateOrUpdatePrNode<
  TIn = unknown,
  TOut = unknown,
  THandle = unknown,
> extends BaseDomainStepASTNode<'github:create-or-update-pr', TIn, TOut, THandle> {
  /** GitHub repository slug in `owner/repo` format. */
  readonly repo: string;
  /** GitHub API token or symbolic `EnvRef`. */
  readonly token: string | EnvRef;
  /** Pure projection deriving the head branch name from `TIn`. */
  readonly branch: BivariantCallback<[input: TIn], string>;
  /** Optional pure projection deriving the target base branch name from `TIn`. */
  readonly baseBranch?: BivariantCallback<[input: TIn], string>;
  /** Pure projection deriving the pull request title from `TIn`. */
  readonly title: BivariantCallback<[input: TIn], string>;
  /** Pure projection deriving the pull request body from `TIn`. */
  readonly body: BivariantCallback<[input: TIn], string>;
}
