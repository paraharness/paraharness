# @paraharness/github

GitHub Issues tracker adapter, HMAC-SHA256 webhook event stream source, and idempotent pull-request step executor for [Paraharness](https://github.com/paraharness/paraharness). This package connects `P.lane` work queues to GitHub Issues, streams verified repository webhook events into `P.stream` signal pipelines, and publishes or updates pull requests inside `P.flow`.

## Installation

With npm:

```bash
npm install @paraharness/github @paraharness/core zod
```

With yarn:

```bash
yarn add @paraharness/github @paraharness/core zod
```

With pnpm:

```bash
pnpm add @paraharness/github @paraharness/core zod
```

## Usage

```ts
import { P, z } from '@paraharness/core';
import { createExecutorRegistry } from '@paraharness/core/runtime';
import { github, githubExecutors } from '@paraharness/github';

const TaskInput = z.object({
  id: z.string(),
  title: z.string(),
  summary: z.string(),
});

const prMergedSignal = P.signal('pr-merged', z.object({ ref: z.string() }));

const issueTracker = github.issues({
  repo: 'acme/platform',
  token: P.env('GITHUB_TOKEN'),
  labels: ['agent-ready'],
});

const mergeStream = P.stream('github-merge-events')
  .source(
    github.webhookStream({
      repo: 'acme/platform',
      port: 3000,
      path: '/webhooks/github',
      secret: P.env('GITHUB_WEBHOOK_SECRET'),
      events: ['pull_request.closed'],
    }),
  )
  .filter((ev) => ev.pull_request.merged === true)
  .emitSignal(prMergedSignal, (ev) => ({
    ref: ev.pull_request.head.ref,
  }));

const publishPr = github.createOrUpdatePr('publish-pr', {
  repo: 'acme/platform',
  token: P.env('GITHUB_TOKEN'),
  branch: (item: z.infer<typeof TaskInput>) => `feat/${item.id}`,
  title: (item: z.infer<typeof TaskInput>) => item.title,
  body: (item: z.infer<typeof TaskInput>) => item.summary,
});

const registry = createExecutorRegistry(githubExecutors);
```

## Documentation

See the [`@paraharness/github` API Reference](https://paraharness.github.io/paraharness/modules/_paraharness_github.html) for full type and builder specifications.

## License

[MIT](./LICENSE) © Tornike Tsomaia
