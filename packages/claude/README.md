# @paraharness/claude

Anthropic Claude model driver and declarative `claude.*` builders for [Paraharness](https://github.com/paraharness/paraharness). This package connects `P.agent` actors and `P.pool` seat pools to the Anthropic `/v1/messages` API and Claude CLI OAuth subscription seats (`~/.claude-*`), handling ephemeral KV-cache breakpoint injection, cryptographic `thinking` block signature preservation, native JSON-schema structured outputs, and warm-prefix downward fork preparation.

## Installation

With npm:

```bash
npm install @paraharness/claude @paraharness/core zod
```

With yarn:

```bash
yarn add @paraharness/claude @paraharness/core zod
```

With pnpm:

```bash
pnpm add @paraharness/claude @paraharness/core zod
```

## Usage

```ts
import { P, z } from '@paraharness/core';
import { createExecutorRegistry } from '@paraharness/core/runtime';
import { claude, claudeExecutors } from '@paraharness/claude';

const seatA = claude.cliAccount('seat-a').configDir('~/.claude-seat-a');
const apiFallback = claude.cliAccount('api-fallback').apiKey(P.env('ANTHROPIC_API_KEY'));

const claudeSeats = P.pool('claude-seats')
  .items(seatA)
  .strategy('soonest-reset')
  .fallback(apiFallback);

const opus = claude
  .model('opus', { id: 'claude-opus-4-6', effort: 'high' })
  .accountPool(claudeSeats);

const reviewer = P.agent('reviewer')
  .model(opus)
  .instructions('Audit the pull request diff and report any security or correctness regressions.')
  .input(z.object({ diff: z.string() }))
  .output(
    z.object({
      approved: z.boolean(),
      findings: z.array(z.string()),
    }),
  );

const registry = createExecutorRegistry(claudeExecutors);
```

## Documentation

See the [`@paraharness/claude` API Reference](https://paraharness.github.io/paraharness/modules/_paraharness_claude.html) for full type and builder specifications.

## License

[MIT](./LICENSE) © Tornike Tsomaia
