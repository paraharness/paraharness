import type { GithubCreateOrUpdatePrNode, StepExecutionContext } from '@harness-dsl/core';
import { DEFAULT_GITHUB_BASE_BRANCH } from '../../builders/internal/github-builder-defaults.constants.js';
import type { GithubHttpTransport } from '../github-http-transport.js';
import { resolveRequiredGithubSecret } from './normalize-github-issue.js';

/**
 * Executes a `GithubCreateOrUpdatePrNode` step against a provided `GithubHttpTransport`.
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
  const owner = node.repo.split('/')[0] ?? '';
  const headBranch = node.branch(validatedInput);
  const baseBranch =
    node.baseBranch !== undefined
      ? node.baseBranch(validatedInput)
      : DEFAULT_GITHUB_BASE_BRANCH;
  const title = node.title(validatedInput);
  const body = node.body(validatedInput);

  const queryPath = `/repos/${node.repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${headBranch}`)}`;
  const existingPrs = await runtime.transport.request<readonly Readonly<Record<string, unknown>>[]>(
    'GET',
    queryPath,
    { token },
  );
  const firstExisting = Array.isArray(existingPrs) ? existingPrs[0] : undefined;

  let rawResult: unknown;
  if (firstExisting !== undefined && typeof firstExisting['number'] === 'number') {
    const prNumber = firstExisting['number'];
    rawResult = await runtime.transport.request(
      'PATCH',
      `/repos/${node.repo}/pulls/${prNumber}`,
      {
        token,
        body: { title, body, base: baseBranch },
      },
    );
  } else {
    rawResult = await runtime.transport.request('POST', `/repos/${node.repo}/pulls`, {
      token,
      body: { title, body, head: headBranch, base: baseBranch },
    });
  }
  return node.outputSchema.parse(rawResult);
}
