import type { EnvRef } from '@harness-dsl/core';

/**
 * Configuration options for the GitHub Issues tracker builder (`github.issues`).
 *
 * Specifies the target `owner/repo` slug, authentication token or symbolic `EnvRef`,
 * and optional issue label filters applied when polling open issues.
 */
export interface GithubIssuesOptions {
  /** GitHub repository slug in `owner/repo` format. */
  readonly repo: string;
  /** GitHub API personal access token or symbolic `H.env(...)` reference. */
  readonly token: string | EnvRef;
  /** Optional list of issue label names used to filter polled issues. */
  readonly labels?: readonly string[];
}
