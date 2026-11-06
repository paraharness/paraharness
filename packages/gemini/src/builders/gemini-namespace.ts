import { createGeminiAccountSeatBuilder } from './create-gemini-account-seat-builder.js';
import { createGeminiModelBuilder } from './create-gemini-model-builder.js';
import type { GeminiNamespace } from './gemini-namespace-contract.js';

/** Frozen `gemini` builder namespace for constructing passive Google Gemini AST nodes. */
export const gemini: GeminiNamespace = Object.freeze<GeminiNamespace>({
  account: (id) => createGeminiAccountSeatBuilder(id),
  cliAccount: (id) => createGeminiAccountSeatBuilder(id),
  model: (alias, options) => createGeminiModelBuilder(alias, options),
});
