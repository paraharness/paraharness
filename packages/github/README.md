# `@paraharness/github`

GitHub Issues tracker adapter, HMAC-SHA256 webhook event stream source, and idempotent pull-request step executor for ParaHarness.

- **Full API Reference:** [https://paraharness.github.io/paraharness/modules/_paraharness_github.html](https://paraharness.github.io/paraharness/modules/_paraharness_github.html)

## Installation

```bash
pnpm add @paraharness/github @paraharness/core zod
```

## Usage

```ts
import { P } from '@paraharness/core';
import { github, githubExecutors } from '@paraharness/github';

const issueTracker = github.issues({
  repo: 'acme/platform',
  token: P.env('GITHUB_TOKEN'),
  labels: ['agent-ready'],
});

const webhookStream = github.webhookStream({
  repo: 'acme/platform',
  port: 3000,
  path: '/webhooks/github',
  secret: P.env('GITHUB_WEBHOOK_SECRET'),
  events: ['pull_request', 'issue_comment'],
});

const publishPr = github.createOrUpdatePr('publish-pr', {
  repo: 'acme/platform',
  token: P.env('GITHUB_TOKEN'),
  branch: (item: { id: string }) => `feat/${item.id}`,
  title: (item: { title: string }) => item.title,
  body: (item: { summary: string }) => item.summary,
});
```

## Key Exports

| Export | Description |
| :--- | :--- |
| `github.issues(opts)` | Builds `GithubIssuesTrackerNode` (`type: 'github:issues'`) for `P.lane.tracker()` |
| `github.webhookStream(opts)` | Builds `GithubWebhookStreamNode` (`type: 'github:webhook-stream'`) for `P.stream.source()` |
| `github.createOrUpdatePr(id, opts)` | Builds idempotent PR creation/update step (`type: 'github:create-or-update-pr'`) |
| `githubExecutors`, `createGithubExecutors` | Runtime tracker, stream source, and step registrations for all `github:*` AST nodes |

## License

[MIT](./LICENSE) © Tornike Tsomaia
