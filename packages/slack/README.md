# `@paraharness/slack`

Slack Socket Mode interactive human approval / control-plane adapter and incoming webhook notification driver for ParaHarness.

- **Full API Reference:** [https://paraharness.github.io/paraharness/modules/_paraharness_slack.html](https://paraharness.github.io/paraharness/modules/_paraharness_slack.html)

## Installation

```bash
pnpm add @paraharness/slack @paraharness/core zod
```

## Usage

```ts
import { P } from '@paraharness/core';
import { slack, slackExecutors } from '@paraharness/slack';

const approverChannel = slack.bot({
  appToken: P.env('SLACK_APP_TOKEN'),
  botToken: P.env('SLACK_BOT_TOKEN'),
  channel: P.env('SLACK_CHANNEL_ID'),
});

const owner = P.human('engineering-owner')
  .keepAliveSeconds(300)
  .notify(approverChannel);

const alertWebhook = slack.webhook(P.env('SLACK_WEBHOOK_URL'));
```

## Key Exports

| Export | Description |
| :--- | :--- |
| `slack.bot(opts)` | Builds bidirectional `SlackApproverNode` (`type: 'slack:approver'`, `interactionMode: 'bidirectional'`) |
| `slack.webhook(url)` | Builds notify-only `SlackNotifierNode` (`type: 'slack:notifier'`, `interactionMode: 'notify-only'`) |
| `slackExecutors`, `createSlackExecutors` | Runtime `HumanAdapter` and `ControlPlaneAdapter` registrations for all `slack:*` AST nodes |

## License

[MIT](./LICENSE) © Tornike Tsomaia
