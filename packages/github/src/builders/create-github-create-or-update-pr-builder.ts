import { z, type BivariantCallback, type GithubCreateOrUpdatePrNode } from '@harness-dsl/core';
import type { GithubCreateOrUpdatePrBuilder } from './github-create-or-update-pr-builder.js';
import type { GithubCreateOrUpdatePrOptions } from './github-create-or-update-pr-options.js';

/**
 * Creates an immutable fluent `GithubCreateOrUpdatePrBuilder` (`github.createOrUpdatePr`).
 *
 * Initializes default `z.unknown()` boundary schemas when omitted and supports fluent
 * `.input(schema)` and `.output(schema)` overrides prior to `.toAST()` compilation.
 *
 * @template TIn     Validated step input payload type.
 * @template TOut    Validated step output payload type.
 * @template THandle Runtime handle type of the enclosing isolation scope.
 *
 * @param {string}                              id      - Unique step node identifier.
 * @param {GithubCreateOrUpdatePrOptions<TIn>}  options - Repository, token, and PR field projections.
 *
 * @returns {GithubCreateOrUpdatePrBuilder<TIn, TOut, THandle>} Immutable pull-request step builder.
 */
export function createGithubCreateOrUpdatePrBuilder<
  TIn = unknown,
  TOut = unknown,
  THandle = unknown,
>(
  id: string,
  options: GithubCreateOrUpdatePrOptions<TIn>,
): GithubCreateOrUpdatePrBuilder<TIn, TOut, THandle> {
  if (typeof id !== 'string' || id.trim().length === 0) {
    throw new Error('Invalid step id in github.createOrUpdatePr: id must be a non-empty string.');
  }
  if (typeof options.repo !== 'string' || options.repo.trim().length === 0 || !options.repo.includes('/')) {
    throw new Error(
      `Invalid repo '${String(options.repo)}' in github.createOrUpdatePr '${id}': expected 'owner/repo'.`,
    );
  }
  const currentInputSchema = (options.inputSchema ?? z.unknown()) as z.ZodType<TIn>;
  const currentOutputSchema = (options.outputSchema ?? z.unknown()) as z.ZodType<TOut>;
  const untypedBranch: BivariantCallback<[input: unknown], string> = options.branch;
  const untypedBaseBranch: BivariantCallback<[input: unknown], string> | undefined = options.baseBranch;
  const untypedTitle: BivariantCallback<[input: unknown], string> = options.title;
  const untypedBody: BivariantCallback<[input: unknown], string> = options.body;

  return Object.freeze<GithubCreateOrUpdatePrBuilder<TIn, TOut, THandle>>({
    id,
    input<TNextIn>(
      schema: z.ZodType<TNextIn>,
    ): GithubCreateOrUpdatePrBuilder<TNextIn, TOut, THandle> {
      return createGithubCreateOrUpdatePrBuilder<TNextIn, TOut, THandle>(id, {
        repo: options.repo,
        token: options.token,
        branch: untypedBranch,
        baseBranch: untypedBaseBranch,
        title: untypedTitle,
        body: untypedBody,
        inputSchema: schema,
        outputSchema: currentOutputSchema,
      });
    },
    output<TNextOut>(
      schema: z.ZodType<TNextOut>,
    ): GithubCreateOrUpdatePrBuilder<TIn, TNextOut, THandle> {
      return createGithubCreateOrUpdatePrBuilder<TIn, TNextOut, THandle>(id, {
        repo: options.repo,
        token: options.token,
        branch: options.branch,
        baseBranch: options.baseBranch,
        title: options.title,
        body: options.body,
        inputSchema: currentInputSchema,
        outputSchema: schema,
      });
    },
    toAST(): GithubCreateOrUpdatePrNode<TIn, TOut, THandle> {
      return Object.freeze<GithubCreateOrUpdatePrNode<TIn, TOut, THandle>>({
        type: 'github:create-or-update-pr',
        id,
        repo: options.repo,
        token: options.token,
        branch: options.branch,
        baseBranch: options.baseBranch,
        title: options.title,
        body: options.body,
        inputSchema: currentInputSchema,
        outputSchema: currentOutputSchema,
      });
    },
  });
}
