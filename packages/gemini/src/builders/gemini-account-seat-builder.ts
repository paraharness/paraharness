import type { AstBuilder, EnvRef, GeminiAccountSeatNode } from '@paraharness/core';

/**
 * Fluent builder for constructing a passive `GeminiAccountSeatNode` (`type: 'gemini:account-seat'`).
 *
 * Configures either a Google Gemini API key seat resolved late via `P.env(key)` or a CLI/ADC
 * seat backed by `configDir` without import-time I/O.
 */
export interface GeminiAccountSeatBuilder extends AstBuilder<GeminiAccountSeatNode> {
  /** Unique identifier of the Gemini account seat within capacity pools. */
  readonly id: string;

  /**
   * Binds a filesystem path to a Gemini CLI/ADC configuration directory containing OAuth credentials.
   *
   * Returns a new immutable builder instance with `configDir` set while leaving the receiver unchanged.
   *
   * @param {string} path - Path to the Gemini CLI/ADC directory (such as `'~/.gemini-a'`).
   *
   * @returns {GeminiAccountSeatBuilder} New immutable account seat builder with `configDir` configured.
   *
   * @throws {Error} If `path` is an empty or whitespace-only string.
   */
  configDir(path: string): GeminiAccountSeatBuilder;

  /**
   * Binds a literal API key or symbolic `P.env(key)` reference for Gemini API authentication.
   *
   * Returns a new immutable builder instance that resolves the key only at leaf turn invocation time.
   *
   * @param {string | EnvRef} envOrKey - Symbolic `EnvRef` or literal API key string.
   *
   * @returns {GeminiAccountSeatBuilder} New immutable account seat builder with `apiKey` configured.
   *
   * @throws {Error} If `envOrKey` is an empty or whitespace-only string.
   */
  apiKey(envOrKey: string | EnvRef): GeminiAccountSeatBuilder;

  /**
   * Compiles the builder configuration into a deeply frozen passive `GeminiAccountSeatNode` AST node.
   *
   * Preserves a monomorphic property shape with `type: 'gemini:account-seat'` and zero runtime methods.
   *
   * @returns {GeminiAccountSeatNode} Frozen passive AST node representing the Gemini account seat.
   */
  toAST(): GeminiAccountSeatNode;
}
