# `@paraharness/gemini`

Google Gemini `/v1beta/models/{model}:generateContent` `ModelDriver` and passive AST builders for ParaHarness.

- **Full API Reference:** [https://paraharness.github.io/paraharness/modules/_paraharness_gemini.html](https://paraharness.github.io/paraharness/modules/_paraharness_gemini.html)

## Installation

```bash
pnpm add @paraharness/gemini @paraharness/core zod
```

## Overview

Supports Gemini API key seats and CLI/ADC seats with native JSON-schema structured outputs (`responseMimeType: 'application/json'` and `responseJsonSchema`), `thinkingConfig` reasoning effort mapping, cryptographic `thoughtSignature` preservation across `thought` and `functionCall` parts, strict `user`/`model` alternation, and `shared-prefix-only` / `clone-transcript` fork preparation.

## Usage

```ts
import { P } from '@paraharness/core';
import { gemini, geminiExecutors } from '@paraharness/gemini';

const geminiSeat = gemini.account('gemini-main').apiKey(P.env('GEMINI_API_KEY'));
const geminiPro = gemini
  .model('gemini-pro', { id: 'gemini-2.5-pro', effort: 'high' })
  .accountPool(P.pool('gemini-seats').items(geminiSeat).strategy('round-robin'));
```

## Key Exports

| Export | Description |
| :--- | :--- |
| `gemini.account(id)`, `gemini.cliAccount(id)` | Fluent builders for `GeminiAccountSeatNode` (`type: 'gemini:account-seat'`) |
| `gemini.model(alias, opts)` | Fluent builder for `GeminiModelNode` (`type: 'gemini:model'`) |
| `geminiExecutors` | Runtime executor registration for `RuntimeExecutorRegistry.models['gemini:model']` |
| `GeminiModelDriver` | Google Gemini `generateContent` `ModelDriver` implementation |

## License

[MIT](./LICENSE) © Tornike Tsomaia
