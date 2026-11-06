import type {
  GithubCreateOrUpdatePrNode,
  GithubIssuesTrackerNode,
  GithubWebhookStreamNode,
  RuntimeDriverContext,
  RuntimeExecutorRegistrySlice,
  StepExecutionContext,
} from '@harness-dsl/core';
import { defaultGithubHttpTransport } from './default-github-http-transport.constants.js';
import type { GithubHttpTransport } from './github-http-transport.js';
import type { GithubIssueRecord } from './github-issue-record.js';
import { GithubIssuesTrackerAdapter } from './github-issues-tracker.js';
import { GithubWebhookStreamSource } from './github-webhook-stream.js';
import { executeGithubPrStepWithTransport } from './internal/execute-github-pr-with-transport.js';

/**
 * Creates a `RuntimeExecutorRegistrySlice` registering all `@harness-dsl/github` runtime executors.
 *
 * Binds `trackers['github:issues']`, `streamSources['github:webhook-stream']`, and
 * `steps['github:create-or-update-pr']` using the supplied `transport`.
 *
 * @param {GithubHttpTransport} [transport=defaultGithubHttpTransport] - HTTP transport used for GitHub REST calls.
 *
 * @returns {RuntimeExecutorRegistrySlice} Frozen executor registry slice for `@harness-dsl/github`.
 */
export function createGithubExecutors(
  transport: GithubHttpTransport = defaultGithubHttpTransport,
): RuntimeExecutorRegistrySlice {
  return Object.freeze<RuntimeExecutorRegistrySlice>({
    trackers: Object.freeze({
      'github:issues': (
        node: GithubIssuesTrackerNode<unknown, string>,
        ctx: RuntimeDriverContext,
      ): GithubIssuesTrackerAdapter<string> =>
        new GithubIssuesTrackerAdapter(
          node as GithubIssuesTrackerNode<GithubIssueRecord, string>,
          ctx,
          transport,
        ),
    }),
    streamSources: Object.freeze({
      'github:webhook-stream': (
        node: GithubWebhookStreamNode<unknown>,
        ctx: RuntimeDriverContext,
      ): GithubWebhookStreamSource<unknown> => new GithubWebhookStreamSource(node, ctx),
    }),
    steps: Object.freeze({
      'github:create-or-update-pr': (
        node: GithubCreateOrUpdatePrNode<unknown, unknown, unknown>,
        input: unknown,
        ctx: StepExecutionContext<unknown>,
      ): Promise<unknown> =>
        executeGithubPrStepWithTransport(node, input, {
          ctx,
          transport,
        }),
    }),
  });
}
