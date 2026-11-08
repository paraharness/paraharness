# `@paraharness/openai`

OpenAI Responses API and Codex CLI `ModelDriver` and passive AST builders for ParaHarness.

- **Full API Reference:** [https://paraharness.github.io/paraharness/modules/_paraharness_openai.html](https://paraharness.github.io/paraharness/modules/_paraharness_openai.html)

## Installation

```bash
pnpm add @paraharness/openai @paraharness/core zod
```

## Overview

Supports OpenAI API key seats and Codex CLI seats with server-side `previous_response_id` branching on same-model `clone-transcript` forks, automatic cross-seat and cross-model stripping of account-bound `previous_response_id`, `rs_*`/`fc_*`/`msg_*` item IDs, and `encrypted_content`, native JSON-schema structured outputs (`text.format`), and per-`callId` tombstone substitution.

## Usage

```ts
import { P } from '@paraharness/core';
import { openai, openaiExecutors } from '@paraharness/openai';

const primarySeat = openai.account('openai-primary').apiKey(P.env('OPENAI_API_KEY'));
const codexModel = openai
  .model('gpt-5-codex', { id: 'gpt-5-codex', effort: 'high' })
  .accountPool(P.pool('openai-seats').items(primarySeat).strategy('least-used'));
```

## Key Exports

| Export | Description |
| :--- | :--- |
| `openai.account(id)`, `openai.cliAccount(id)` | Fluent builders for `OpenAiAccountSeatNode` (`type: 'openai:account-seat'`) |
| `openai.model(alias, opts)` | Fluent builder for `OpenAiModelNode` (`type: 'openai:model'`) |
| `openaiExecutors` | Runtime executor registration for `RuntimeExecutorRegistry.models['openai:model']` |
| `OpenAiModelDriver` | OpenAI Responses API `ModelDriver` implementation |

## License

[MIT](./LICENSE) © Tornike Tsomaia
