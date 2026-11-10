import type { z } from '@paraharness/core';
import type { GithubCreateOrUpdatePrOptions } from '../github-create-or-update-pr-options.js';

/**
 * Checks whether `value` is a Zod schema exposing a callable `.parse()` method.
 *
 * @param {unknown} value - Candidate schema object to inspect.
 *
 * @returns {value is z.ZodTypeAny} `true` when `value` exposes a `.parse` function.
 */
function isZodSchema(value: unknown): value is z.ZodTypeAny {
  return (
    typeof value === 'object' &&
    value !== null &&
    'parse' in value &&
    typeof value.parse === 'function'
  );
}

/**
 * Validates `id`, `options.repo`, and optional boundary schemas passed to `createGithubCreateOrUpdatePrBuilder`.
 *
 * Ensures the step identifier is a non-empty string, the repository slug follows `'owner/repo'` format,
 * and any provided `inputSchema` or `outputSchema` is a valid Zod schema.
 *
 * @param {string}                                         id      - Unique step node identifier.
 * @param {GithubCreateOrUpdatePrOptions<unknown, unknown>} options - Pull-request step builder options.
 *
 * @returns {void}
 *
 * @throws {Error} If `id` is empty, `options.repo` is not a valid `'owner/repo'` slug, or `inputSchema`/`outputSchema` is invalid.
 */
export function assertValidGithubPrBuilderOptions(
  id: string,
  options: GithubCreateOrUpdatePrOptions<unknown, unknown>,
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
  if (options.inputSchema !== undefined && !isZodSchema(options.inputSchema)) {
    throw new Error(
      `Invalid inputSchema in github.createOrUpdatePr '${id}': expected a Zod schema with a .parse() method.`,
    );
  }
  if (options.outputSchema !== undefined && !isZodSchema(options.outputSchema)) {
    throw new Error(
      `Invalid outputSchema in github.createOrUpdatePr '${id}': expected a Zod schema with a .parse() method.`,
    );
  }
}
