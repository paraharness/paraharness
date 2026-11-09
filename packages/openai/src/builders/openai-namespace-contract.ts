import type { OpenAiAccountSeatBuilder } from './openai-account-seat-builder.js';
import type { OpenAiModelBuilder } from './openai-model-builder.js';
import type { OpenAiModelOptions } from './openai-model-options.js';

/**
 * Builder namespace contract exported as `openai` by `@paraharness/openai`.
 *
 * Provides entrypoints for declaring passive `OpenAiAccountSeatNode` and `OpenAiModelNode`
 * AST descriptors without import-time or declaration-time side effects.
 */
export interface OpenAiNamespace {
  /**
   * Declares an OpenAI API key or Codex CLI account seat (`type: 'openai:account-seat'`).
   *
   * Supports `.apiKey(envRef)` for API key seats and `.configDir(path)` for Codex CLI subscription seats.
   *
   * @param {string} id - Unique identifier for the OpenAI account seat.
   *
   * @returns {OpenAiAccountSeatBuilder} Fluent builder for the OpenAI account seat.
   *
   * @throws {Error} If `id` is an empty or whitespace-only string.
   */
  account(id: string): OpenAiAccountSeatBuilder;

  /**
   * Declares an OpenAI Codex CLI subscription seat (`type: 'openai:account-seat'`).
   *
   * Alias for `account(id)` supporting `.configDir(path)` and `.apiKey(envRef)`.
   *
   * @param {string} id - Unique identifier for the OpenAI Codex CLI seat.
   *
   * @returns {OpenAiAccountSeatBuilder} Fluent builder for the OpenAI account seat.
   *
   * @throws {Error} If `id` is an empty or whitespace-only string.
   */
  cliAccount(id: string): OpenAiAccountSeatBuilder;

  /**
   * Declares an OpenAI Responses API model configuration (`type: 'openai:model'`, `vendor: 'openai'`).
   *
   * Supports `.accountPool(pool)` / `.pool(pool)` and `.effort(level)` before compiling to `OpenAiModelNode`.
   *
   * @param {string}             alias     - Logical model alias (such as `'gpt5'` or `'gpt-5'`).
   * @param {OpenAiModelOptions} [options] - Optional OpenAI model identifier (`defaults to alias`) and reasoning effort.
   *
   * @returns {OpenAiModelBuilder} Fluent builder for the OpenAI model node.
   *
   * @throws {Error} If `alias` or `options.id` is an empty or whitespace-only string.
   */
  model(alias: string, options?: OpenAiModelOptions): OpenAiModelBuilder;
}
