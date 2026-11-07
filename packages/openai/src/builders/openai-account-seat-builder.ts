import type { AstBuilder, EnvRef, OpenAiAccountSeatNode } from '@harness-dsl/core';

/**
 * Fluent builder for constructing a passive `OpenAiAccountSeatNode` (`type: 'openai:account-seat'`).
 *
 * Configures either an OpenAI API key seat resolved late via `H.env(key)` or a Codex CLI
 * subscription seat backed by `configDir` without import-time I/O.
 */
export interface OpenAiAccountSeatBuilder extends AstBuilder<OpenAiAccountSeatNode> {
  /** Unique identifier of the OpenAI account seat within capacity pools. */
  readonly id: string;

  /**
   * Binds a filesystem path to a Codex CLI configuration directory containing OAuth credentials.
   *
   * Returns a new immutable builder instance with `configDir` set while leaving the receiver unchanged.
   *
   * @param {string} path - Path to the Codex CLI directory (such as `'~/.codex-a'`).
   *
   * @returns {OpenAiAccountSeatBuilder} New immutable account seat builder with `configDir` configured.
   *
   * @throws {Error} If `path` is an empty or whitespace-only string.
   */
  configDir(path: string): OpenAiAccountSeatBuilder;

  /**
   * Binds a literal API key or symbolic `H.env(key)` reference for OpenAI Responses API authentication.
   *
   * Returns a new immutable builder instance that resolves the key only at leaf turn invocation time.
   *
   * @param {string | EnvRef} envOrKey - Symbolic `EnvRef` or literal API key string.
   *
   * @returns {OpenAiAccountSeatBuilder} New immutable account seat builder with `apiKey` configured.
   *
   * @throws {Error} If `envOrKey` is an empty or whitespace-only string.
   */
  apiKey(envOrKey: string | EnvRef): OpenAiAccountSeatBuilder;

  /**
   * Compiles the builder configuration into a deeply frozen passive `OpenAiAccountSeatNode` AST node.
   *
   * Preserves a monomorphic property shape with `type: 'openai:account-seat'` and zero runtime methods.
   *
   * @returns {OpenAiAccountSeatNode} Frozen passive AST node representing the OpenAI account seat.
   */
  toAST(): OpenAiAccountSeatNode;
}
