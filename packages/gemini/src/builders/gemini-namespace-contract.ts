import type { GeminiAccountSeatBuilder } from './gemini-account-seat-builder.js';
import type { GeminiModelBuilder } from './gemini-model-builder.js';
import type { GeminiModelOptions } from './gemini-model-options.js';

/**
 * Builder namespace contract exported as `gemini` by `@metaharness/gemini`.
 *
 * Provides entrypoints for declaring passive `GeminiAccountSeatNode` and `GeminiModelNode`
 * AST descriptors without import-time or declaration-time side effects.
 */
export interface GeminiNamespace {
  /**
   * Declares a Google Gemini API key or CLI/ADC account seat (`type: 'gemini:account-seat'`).
   *
   * Supports `.apiKey(envRef)` for API key seats and `.configDir(path)` for CLI/ADC seats.
   *
   * @param {string} id - Unique identifier for the Gemini account seat.
   *
   * @returns {GeminiAccountSeatBuilder} Fluent builder for the Gemini account seat.
   *
   * @throws {Error} If `id` is an empty or whitespace-only string.
   */
  account(id: string): GeminiAccountSeatBuilder;

  /**
   * Declares a Google Gemini CLI/ADC subscription seat (`type: 'gemini:account-seat'`).
   *
   * Alias for `account(id)` supporting `.configDir(path)` and `.apiKey(envRef)`.
   *
   * @param {string} id - Unique identifier for the Gemini CLI seat.
   *
   * @returns {GeminiAccountSeatBuilder} Fluent builder for the Gemini account seat.
   *
   * @throws {Error} If `id` is an empty or whitespace-only string.
   */
  cliAccount(id: string): GeminiAccountSeatBuilder;

  /**
   * Declares a Google Gemini model configuration (`type: 'gemini:model'`, `vendor: 'google'`).
   *
   * Supports `.pool(pool)` / `.accountPool(pool)` and `.effort(level)` before compiling to `GeminiModelNode`.
   *
   * @param {string}             alias   - Logical model alias (such as `'pro'` or `'flash'`).
   * @param {GeminiModelOptions} options - Gemini model identifier and optional thinking effort.
   *
   * @returns {GeminiModelBuilder} Fluent builder for the Gemini model node.
   *
   * @throws {Error} If `alias` or `options.id` is an empty or whitespace-only string.
   */
  model(alias: string, options: GeminiModelOptions): GeminiModelBuilder;
}
