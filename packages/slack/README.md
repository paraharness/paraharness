# @paraharness/slack

Slack Socket Mode interactive human approval and control-plane adapter plus incoming webhook notification driver for [Paraharness](https://github.com/paraharness/paraharness). This package connects `P.human` authorities to bidirectional Slack channels for interactive escalations and budget approvals, and delivers outbound signal notifications via incoming webhooks.

## Installation

With npm:

```bash
npm install @paraharness/slack @paraharness/core zod
```

With yarn:

```bash
yarn add @paraharness/slack @paraharness/core zod
```

With pnpm:

```bash
pnpm add @paraharness/slack @paraharness/core zod
```

## Usage

```ts
import { P, z } from '@paraharness/core';
import { createExecutorRegistry } from '@paraharness/core/runtime';
import { slack, slackExecutors } from '@paraharness/slack';

const deployApprovedSignal = P.signal('deploy-approved', z.object({ release: z.string() }));

const slackBot = slack.bot({
  appToken: P.env('SLACK_APP_TOKEN'),
  botToken: P.env('SLACK_BOT_TOKEN'),
  channel: P.env('SLACK_CHANNEL_ID'),
});

const engineeringOwner = P.human('engineering-owner')
  .keepAliveSeconds(300)
  .notify(slackBot);

const releaseNotifier = P.human('release-alerts').notify(
  slack.webhook(P.env('SLACK_WEBHOOK_URL')),
);

const registry = createExecutorRegistry(slackExecutors);
```

## Documentation

See the [`@paraharness/slack` API Reference](https://paraharness.github.io/paraharness/modules/_paraharness_slack.html) for full type and builder specifications.

## License

[MIT](./LICENSE) © Tornike Tsomaia
