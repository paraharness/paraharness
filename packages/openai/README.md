# @paraharness/openai

OpenAI Responses API and Codex CLI model driver and declarative `openai.*` builders for [Paraharness](https://github.com/paraharness/paraharness). This package connects `P.agent` actors and `P.pool` seat pools to OpenAI API key accounts and Codex CLI subscription seats, supporting server-side `previous_response_id` branching on same-model forks, automatic cross-seat stripping of account-bound item IDs and encrypted reasoning tokens, and native JSON-schema structured outputs.

## Installation

With npm:

```bash
npm install @paraharness/openai @paraharness/core zod
```

With yarn:

```bash
yarn add @paraharness/openai @paraharness/core zod
```

With pnpm:

```bash
pnpm add @paraharness/openai @paraharness/core zod
```

## Usage

```ts
import { P, z } from '@paraharness/core';
import { createExecutorRegistry } from '@paraharness/core/runtime';
import { openai, openaiExecutors } from '@paraharness/openai';

const primarySeat = openai.account('openai-primary').apiKey(P.env('OPENAI_API_KEY'));
const cliSeat = openai.cliAccount('codex-cli').configDir('~/.codex-seat-a');

const openaiSeats = P.pool('openai-seats')
  .items(cliSeat)
  .strategy('least-used')
  .fallback(primarySeat);

const codexModel = openai
  .model('gpt-5-codex', { id: 'gpt-5-codex', effort: 'high' })
  .accountPool(openaiSeats);

const planner = P.agent('planner')
  .model(codexModel)
  .instructions('Break the architectural specification into ordered implementation tasks.')
  .input(z.object({ spec: z.string() }))
  .output(z.object({ tasks: z.array(z.string()) }));

const registry = createExecutorRegistry(openaiExecutors);
```

## Documentation

See the [`@paraharness/openai` API Reference](https://paraharness.github.io/paraharness/modules/_paraharness_openai.html) for full type and builder specifications.

## License

[MIT](./LICENSE) © Tornike Tsomaia
