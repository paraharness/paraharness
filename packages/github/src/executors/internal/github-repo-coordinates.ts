/**
 * Parsed GitHub repository owner and repository name coordinates.
 *
 * Produced by `parseGithubRepoSlug` from an `"owner/repo"` repository slug.
 */
export interface GithubRepoCoordinates {
  /** Repository owner or organization login. */
  readonly owner: string;
  /** Repository name within the owner namespace. */
  readonly repo: string;
}
