import type { ClaudeAccountSeatBuilder } from './claude-account-seat-builder.js';
import type { ClaudeModelBuilder } from './claude-model-builder.js';
import type { ClaudeModelOptions } from './claude-model-options.js';

/**
 * Builder namespace contract exported as `claude` by `@harness-dsl/claude`.
 *
 * Provides entrypoints for declaring passive `ClaudeAccountSeatNode` and `ClaudeModelNode`
 * AST descriptors without import-time or declaration-time side effects.
 */
export interface ClaudeNamespace {
  /**
   * Declares a Claude CLI subscription or API fallback seat (`type: 'claude:account-seat'`).
   *
   * Supports `.configDir(path)` for OAuth credential extraction and `.apiKey(envRef)` for API key fallback.
   *
   * @param {string} id - Unique identifier for the Claude account seat.
   *
   * @returns {ClaudeAccountSeatBuilder} Fluent builder for the Claude account seat.
   *
   * @throws {Error} If `id` is empty or whitespace-only.
   */
  cliAccount(id: string): ClaudeAccountSeatBuilder;

  /**
   * Declares a Claude account seat (`type: 'claude:account-seat'`).
   *
   * Alias for `cliAccount(id)` supporting both `.apiKey(envRef)` and `.configDir(path)` configurations.
   *
   * @param {string} id - Unique identifier for the Claude account seat.
   *
   * @returns {ClaudeAccountSeatBuilder} Fluent builder for the Claude account seat.
   *
   * @throws {Error} If `id` is empty or whitespace-only.
   */
  account(id: string): ClaudeAccountSeatBuilder;

  /**
   * Declares an Anthropic Claude model configuration (`type: 'claude:model'`, `vendor: 'anthropic'`).
   *
   * Supports `.accountPool(pool)` / `.pool(pool)` and `.effort(level)` before compiling to `ClaudeModelNode`.
   *
   * @param {string}             alias   - Logical model alias (such as `'sonnet'` or `'opus'`).
   * @param {ClaudeModelOptions} options - Anthropic model identifier and optional thinking effort.
   *
   * @returns {ClaudeModelBuilder} Fluent builder for the Claude model node.
   *
   * @throws {Error} If `alias` or `options.id` is empty or whitespace-only.
   */
  model(alias: string, options: ClaudeModelOptions): ClaudeModelBuilder;
}
