import type { GithubCreateOrUpdatePrNode, StepExecutionContext } from '@harness-dsl/core';
import { DEFAULT_GITHUB_BASE_BRANCH } from '../../builders/internal/github-builder-defaults.constants.js';
import type { GithubHttpTransport } from '../github-http-transport.js';
import {
  createGithubOctokitClient,
  parseGithubRepoSlug,
} from './create-github-octokit-client.js';
import { resolveRequiredGithubSecret } from './normalize-github-issue.js';

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
 * @param {object}                                         runtime - Execution context and HTTP transport.
 *
 * @returns {Promise<TOut>} Validated step output returned by the GitHub pulls endpoint.
 */
export async function executeGithubPrStepWithTransport<
  TIn = unknown,
  TOut = unknown,
  THandle = unknown,
>(
  node: GithubCreateOrUpdatePrNode<TIn, TOut, THandle>,
  input: TIn,
  runtime: {
    readonly ctx: StepExecutionContext<THandle>;
    readonly transport: GithubHttpTransport;
  },
): Promise<TOut> {
  const validatedInput = node.inputSchema.parse(input);
  const token = resolveRequiredGithubSecret(
    node.token,
    (val) => runtime.ctx.resolveEnv(val),
    `github:create-or-update-pr (${node.id})`,
  );
  const { owner, repo } = parseGithubRepoSlug(node.repo);
  const octokit = createGithubOctokitClient(token, runtime.transport);
  const headBranch = node.branch(validatedInput);
  const baseBranch =
    node.baseBranch !== undefined
      ? node.baseBranch(validatedInput)
      : DEFAULT_GITHUB_BASE_BRANCH;
  const title = node.title(validatedInput);
  const body = node.body(validatedInput);

  const existingPrsResponse = await octokit.rest.pulls.list({
    owner,
    repo,
    state: 'open',
    head: `${owner}:${headBranch}`,
  });
  const existingPrs = existingPrsResponse.data;
  const firstExisting = Array.isArray(existingPrs) ? existingPrs[0] : undefined;

  let rawResult: unknown;
  if (firstExisting !== undefined && typeof firstExisting.number === 'number') {
    const updated = await octokit.rest.pulls.update({
      owner,
      repo,
      pull_number: firstExisting.number,
      title,
      body,
      base: baseBranch,
    });
    rawResult = updated.data;
  } else {
    const created = await octokit.rest.pulls.create({
      owner,
      repo,
      title,
      body,
      head: headBranch,
      base: baseBranch,
    });
    rawResult = created.data;
  }
  return node.outputSchema.parse(rawResult);
}
