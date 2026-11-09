# @paraharness/gemini

Google Gemini `generateContent` model driver and declarative `gemini.*` builders for [Paraharness](https://github.com/paraharness/paraharness). This package connects `P.agent` actors and `P.pool` seat pools to Gemini API key accounts and CLI/ADC credentials, managing `thinkingConfig` reasoning effort mapping, cryptographic `thoughtSignature` preservation across thought and tool-call parts, strict `user`/`model` turn alternation, and native JSON-schema structured outputs.

## Installation

With npm:

```bash
npm install @paraharness/gemini @paraharness/core zod
```

With yarn:

```bash
yarn add @paraharness/gemini @paraharness/core zod
```

With pnpm:

```bash
pnpm add @paraharness/gemini @paraharness/core zod
```

## Usage

```ts
import { P, z } from '@paraharness/core';
import { createExecutorRegistry } from '@paraharness/core/runtime';
import { gemini, geminiExecutors } from '@paraharness/gemini';

const geminiSeat = gemini.account('gemini-main').apiKey(P.env('GEMINI_API_KEY'));
const geminiPool = P.pool('gemini-seats').items(geminiSeat).strategy('round-robin');

const geminiPro = gemini
  .model('gemini-pro', { id: 'gemini-2.5-pro', effort: 'high' })
  .accountPool(geminiPool);

const synthesizer = P.agent('synthesizer')
  .model(geminiPro)
  .instructions('Synthesize the repository findings into a structured diagnostic report.')
  .input(z.object({ notes: z.string() }))
  .output(z.object({ summary: z.string(), rootCauses: z.array(z.string()) }));

const registry = createExecutorRegistry(geminiExecutors);
```

## Documentation

See the [`@paraharness/gemini` API Reference](https://paraharness.github.io/paraharness/modules/_paraharness_gemini.html) for full type and builder specifications.

## License

[MIT](./LICENSE) © Tornike Tsomaia
