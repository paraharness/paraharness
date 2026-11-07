import type { GithubRepoCoordinates } from './github-repo-coordinates.js';

/**
 * Splits a `"owner/repo"` repository slug into validated `owner` and `repo` segments.
 *
 * Throws an actionable error if `repoSlug` does not contain non-empty `owner` and `repo` parts.
 *
 * @param {string} repoSlug - Repository slug in `"owner/repo"` format.
 *
 * @returns {GithubRepoCoordinates} Parsed repository owner and name.
 *
 * @throws {Error} If `repoSlug` does not contain a `'/'` separator with non-empty segments.
 */
export function parseGithubRepoSlug(repoSlug: string): GithubRepoCoordinates {
  const slashIndex = repoSlug.indexOf('/');
  if (slashIndex <= 0 || slashIndex >= repoSlug.length - 1) {
    throw new Error(
      `Invalid GitHub repository slug '${repoSlug}': expected '<owner>/<repo>' format.`,
    );
  }
  return Object.freeze<GithubRepoCoordinates>({
    owner: repoSlug.slice(0, slashIndex),
    repo: repoSlug.slice(slashIndex + 1),
  });
}
