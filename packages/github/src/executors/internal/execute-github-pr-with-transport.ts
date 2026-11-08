import type { Octokit } from '@octokit/rest';
import type { GithubCreateOrUpdatePrNode, StepExecutionContext } from '@metaharness/core';
import { DEFAULT_GITHUB_BASE_BRANCH } from '../../builders/internal/github-builder-defaults.constants.js';
import type { GithubHttpTransport } from '../github-http-transport.js';
import { createGithubOctokitClient } from './create-github-octokit-client.js';
import type { GithubRepoCoordinates } from './github-repo-coordinates.js';
import { parseGithubRepoSlug } from './parse-github-repo-slug.js';
import { resolveRequiredGithubSecret } from './resolve-required-github-secret.js';

/**
 * Runtime execution parameters for `executeGithubPrWithTransport`.
 *
 * Bundles the active `StepExecutionContext` and pluggable `GithubHttpTransport`.
 *
 * @template THandle Runtime handle type of the enclosing isolation scope.
 */
export interface GithubPrExecutionRuntimeParams<THandle = unknown> {
  /** Active step execution context. */
  readonly ctx: StepExecutionContext<THandle>;
  /** Pluggable GitHub HTTP transport. */
  readonly transport: GithubHttpTransport;
}

/**
 * Parameters for creating or updating a GitHub pull request via `upsertGithubPullRequest`.
 *
 * Carries the authenticated `Octokit` client, repository coordinates, and projected PR fields.
 */
export interface UpsertGithubPullRequestParams {
  /** Authenticated `@octokit/rest` client instance. */
  readonly octokit: Octokit;
  /** Parsed repository owner and name coordinates. */
  readonly coordinates: GithubRepoCoordinates;
  /** Source feature branch name. */
  readonly headBranch: string;
  /** Target base branch name. */
  readonly baseBranch: string;
  /** Pull request title string. */
  readonly title: string;
  /** Pull request markdown body string. */
  readonly body: string;
}

/**
 * Queries open pull requests for `head: <owner>:<headBranch>` and updates or creates the PR.
 *
 * Updates the existing open pull request when found, or opens a new pull request against `baseBranch`.
 *
 * @param {UpsertGithubPullRequestParams} params - Octokit client, repo coordinates, and projected PR fields.
 *
 * @returns {Promise<unknown>} Raw pull request response payload returned by the GitHub REST API.
 */
async function upsertGithubPullRequest(params: UpsertGithubPullRequestParams): Promise<unknown> {
  const existingPrsResponse = await params.octokit.rest.pulls.list({
    owner: params.coordinates.owner,
    repo: params.coordinates.repo,
    state: 'open',
    head: `${params.coordinates.owner}:${params.headBranch}`,
  });
  const existingPrs = existingPrsResponse.data;
  const firstExisting = Array.isArray(existingPrs) ? existingPrs[0] : undefined;

  if (firstExisting !== undefined && typeof firstExisting.number === 'number') {
    const updated = await params.octokit.rest.pulls.update({
      owner: params.coordinates.owner,
      repo: params.coordinates.repo,
      pull_number: firstExisting.number,
      title: params.title,
      body: params.body,
      base: params.baseBranch,
    });
    return updated.data;
  }

  const created = await params.octokit.rest.pulls.create({
    owner: params.coordinates.owner,
    repo: params.coordinates.repo,
    title: params.title,
    body: params.body,
    head: params.headBranch,
    base: params.baseBranch,
  });
  return created.data;
}

/**
 * Executes a `GithubCreateOrUpdatePrNode` step via `@octokit/rest` (`pulls.list`, `pulls.update`, `pulls.create`).
 *
 * Queries open pull requests matching `head: <owner>:<branch>`, updates the existing pull request
 * if one is already open, or creates a new pull request against `baseBranch` otherwise.
 *
 * @template TIn     Validated step input payload type.
 * @template TOut    Validated step output payload type.
 * @template THandle Runtime handle type of the enclosing isolation scope.
 *
 * @param {GithubCreateOrUpdatePrNode<TIn, TOut, THandle>} node    - Passive pull-request step AST node.
 * @param {TIn}                                            input   - Validated step input payload.
 * @param {GithubPrExecutionRuntimeParams<THandle>}        runtime - Execution context and HTTP transport.
 *
 * @returns {Promise<TOut>} Validated step output returned by the GitHub pulls endpoint.
 *
 * @throws {Error} If input/output validation fails, token resolution fails, or repo slug is invalid.
 */
export async function executeGithubPrWithTransport<
  TIn = unknown,
  TOut = unknown,
  THandle = unknown,
>(
  node: GithubCreateOrUpdatePrNode<TIn, TOut, THandle>,
  input: TIn,
  runtime: GithubPrExecutionRuntimeParams<THandle>,
): Promise<TOut> {
  const validatedInput = node.inputSchema.parse(input);
  const token = resolveRequiredGithubSecret(
    node.token,
    (val) => runtime.ctx.resolveEnv(val),
    `github:create-or-update-pr (${node.id})`,
  );
  const coordinates = parseGithubRepoSlug(node.repo);
  const octokit = createGithubOctokitClient(token, runtime.transport);
  const rawResult = await upsertGithubPullRequest({
    octokit,
    coordinates,
    headBranch: node.branch(validatedInput),
    baseBranch:
      node.baseBranch !== undefined ? node.baseBranch(validatedInput) : DEFAULT_GITHUB_BASE_BRANCH,
    title: node.title(validatedInput),
    body: node.body(validatedInput),
  });
  return node.outputSchema.parse(rawResult);
}
