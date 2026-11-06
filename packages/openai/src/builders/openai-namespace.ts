import { createOpenAiAccountSeatBuilder } from './create-openai-account-seat-builder.js';
import { createOpenAiModelBuilder } from './create-openai-model-builder.js';
import type { OpenAiNamespace } from './openai-namespace-contract.js';

/** Frozen `openai` builder namespace for constructing passive OpenAI AST nodes. */
export const openai: OpenAiNamespace = Object.freeze<OpenAiNamespace>({
  account: (id) => createOpenAiAccountSeatBuilder(id),
  cliAccount: (id) => createOpenAiAccountSeatBuilder(id),
  model: (alias, options) => createOpenAiModelBuilder(alias, options),
});
