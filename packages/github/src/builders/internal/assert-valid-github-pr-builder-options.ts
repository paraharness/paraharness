import type { GithubCreateOrUpdatePrOptions } from '../github-create-or-update-pr-options.js';

/**
 * Validates `id` and `options.repo` passed to `createGithubCreateOrUpdatePrBuilder`.
 *
 * Ensures the step identifier is a non-empty string and the repository slug follows `'owner/repo'` format.
 *
 * @param {string}                               id      - Unique step node identifier.
 * @param {GithubCreateOrUpdatePrOptions<unknown>} options - Pull-request step builder options.
 *
 * @returns {void}
 *
 * @throws {Error} If `id` is empty or `options.repo` is not a valid `'owner/repo'` slug.
 */
export function assertValidGithubPrBuilderOptions(
  id: string,
  options: GithubCreateOrUpdatePrOptions<unknown>,
): void {
  if (typeof id !== 'string' || id.trim().length === 0) {
    throw new Error('Invalid step id in github.createOrUpdatePr: id must be a non-empty string.');
  }
  if (
    typeof options.repo !== 'string' ||
    options.repo.trim().length === 0 ||
    !options.repo.includes('/')
  ) {
    throw new Error(
      `Invalid repo '${String(options.repo)}' in github.createOrUpdatePr '${id}': expected 'owner/repo'.`,
    );
  }
}
