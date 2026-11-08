# `@paraharness/claude`

Anthropic Claude `/v1/messages` `ModelDriver` and passive AST builders for ParaHarness.

- **Full API Reference:** [https://paraharness.github.io/paraharness/modules/_paraharness_claude.html](https://paraharness.github.io/paraharness/modules/_paraharness_claude.html)

## Installation

```bash
pnpm add @paraharness/claude @paraharness/core zod
```

## Overview

Supports both Claude CLI OAuth subscription seats (`~/.claude-*` `configDir`) and API key seats with run-sticky seat affinity, native JSON-schema structured outputs (`output_config.format`), cryptographic `thinking` signature preservation, `shared-prefix-only` and `clone-transcript` fork preparation, cross-model tombstone substitution, and ephemeral KV-cache breakpoint injection.

## Usage

```ts
import { P } from '@paraharness/core';
import { claude, claudeExecutors } from '@paraharness/claude';

const seatA = claude.cliAccount('seat-a').configDir('~/.claude-seat-a');
const apiFallback = claude.cliAccount('api-fallback').apiKey(P.env('ANTHROPIC_API_KEY'));

const accountPool = P.pool('claude-seats')
  .items(seatA)
  .strategy('soonest-reset')
  .fallback(apiFallback);

const opus = claude
  .model('opus', { id: 'claude-opus-4-6', effort: 'high' })
  .accountPool(accountPool);
```

## Key Exports

| Export | Description |
| :--- | :--- |
| `claude.cliAccount(id)` | Fluent builder for `ClaudeAccountSeatNode` (`type: 'claude:account-seat'`) |
| `claude.model(alias, opts)` | Fluent builder for `ClaudeModelNode` (`type: 'claude:model'`) |
| `claudeExecutors` | Runtime executor registration for `RuntimeExecutorRegistry.models['claude:model']` |
| `ClaudeModelDriver` | Anthropic `/v1/messages` `ModelDriver` implementation |

## License

[MIT](./LICENSE) © Tornike Tsomaia
