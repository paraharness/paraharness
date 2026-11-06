import type { ClaudeNamespace } from './claude-namespace-contract.js';
import { createClaudeAccountSeatBuilder } from './create-claude-account-seat-builder.js';
import { createClaudeModelBuilder } from './create-claude-model-builder.js';

/** Frozen `claude` builder namespace for constructing passive Anthropic AST nodes. */
export const claude: ClaudeNamespace = Object.freeze<ClaudeNamespace>({
  cliAccount: (id) => createClaudeAccountSeatBuilder(id),
  account: (id) => createClaudeAccountSeatBuilder(id),
  model: (alias, options) => createClaudeModelBuilder(alias, options),
});
