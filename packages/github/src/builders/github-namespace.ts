import { createGithubCreateOrUpdatePrBuilder } from './create-github-create-or-update-pr-builder.js';
import { createGithubIssuesBuilder } from './create-github-issues-builder.js';
import { createGithubWebhookStreamBuilder } from './create-github-webhook-stream-builder.js';
import type { GithubNamespace } from './github-namespace-contract.js';

/** Frozen `@paraharness/github` DSL namespace singleton (`github.issues`, `github.webhookStream`, `github.createOrUpdatePr`). */
export const github: GithubNamespace = Object.freeze<GithubNamespace>({
  issues: createGithubIssuesBuilder,
  webhookStream: createGithubWebhookStreamBuilder,
  createOrUpdatePr: createGithubCreateOrUpdatePrBuilder,
});
