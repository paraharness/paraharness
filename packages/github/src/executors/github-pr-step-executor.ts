import type { GithubCreateOrUpdatePrNode, StepExecutionContext } from '@harness-dsl/core';
import { defaultGithubHttpTransport } from './default-github-http-transport.constants.js';
import { executeGithubPrStepWithTransport } from './internal/execute-github-pr-with-transport.js';

/**
 * Stateless domain step executor for `GithubCreateOrUpdatePrNode` (`github:create-or-update-pr`).
 *
 * Queries open pull requests for `head: <owner>:<branch(input)>` and idempotently updates
 * the existing pull request or opens a new pull request on `/repos/${node.repo}/pulls`.
 *
 * @template TIn     Validated step input payload type.
 * @template TOut    Validated step output payload type.
 * @template THandle Runtime handle type of the enclosing isolation scope.
 *
 * @param {GithubCreateOrUpdatePrNode<TIn, TOut, THandle>} node  - Passive pull-request step AST node.
 * @param {TIn}                                            input - Step input payload.
 * @param {StepExecutionContext<THandle>}                  ctx   - Active step execution context.
 *
 * @returns {Promise<TOut>} Validated pull-request step output.
 */
export function executeGithubCreateOrUpdatePrStep<
  TIn = unknown,
  TOut = unknown,
  THandle = unknown,
>(
  node: GithubCreateOrUpdatePrNode<TIn, TOut, THandle>,
  input: TIn,
  ctx: StepExecutionContext<THandle>,
): Promise<TOut> {
  return executeGithubPrStepWithTransport(node, input, {
    ctx,
    transport: defaultGithubHttpTransport,
  });
}
