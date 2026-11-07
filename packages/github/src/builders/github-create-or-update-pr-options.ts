import type { BivariantCallback, EnvRef, z } from '@harness-dsl/core';

/**
 * Configuration options for the GitHub pull-request step builder (`github.createOrUpdatePr`).
 *
 * Binds the target repository, API token, synchronous input-to-PR field projections,
 * and optional initial input/output Zod validation schemas.
 *
 * @template TIn Step input payload type projected into pull request fields.
 */
export interface GithubCreateOrUpdatePrOptions<TIn = unknown> {
  /** GitHub repository slug in `owner/repo` format. */
  readonly repo: string;
  /** GitHub API token or symbolic `H.env(...)` reference. */
  readonly token: string | EnvRef;
  /** Synchronous projection deriving the source feature branch name from `TIn`. */
  readonly branch: BivariantCallback<[input: TIn], string>;
  /** Optional synchronous projection deriving the target base branch name from `TIn`. */
  readonly baseBranch?: BivariantCallback<[input: TIn], string>;
  /** Synchronous projection deriving the pull request title from `TIn`. */
  readonly title: BivariantCallback<[input: TIn], string>;
  /** Synchronous projection deriving the pull request markdown body from `TIn`. */
  readonly body: BivariantCallback<[input: TIn], string>;
  /** Optional Zod schema validating the step input payload. */
  readonly inputSchema?: z.ZodType<TIn>;
  /** Optional Zod schema validating the step output payload. */
  readonly outputSchema?: z.ZodTypeAny;
}
