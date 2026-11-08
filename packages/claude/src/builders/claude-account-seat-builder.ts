import type { AstBuilder, ClaudeAccountSeatNode, EnvRef } from '@metaharness/core';

/**
 * Fluent builder for constructing a passive `ClaudeAccountSeatNode` (`type: 'claude:account-seat'`).
 *
 * Configures either a Claude CLI subscription seat backed by an OAuth `configDir` or an API key
 * seat resolved late via `M.env(key)` at turn execution time without import-time I/O.
 */
export interface ClaudeAccountSeatBuilder extends AstBuilder<ClaudeAccountSeatNode> {
  /** Unique identifier of the Claude account seat within capacity pools. */
  readonly id: string;

  /**
   * Binds a filesystem path to a Claude CLI configuration directory containing OAuth credentials.
   *
   * Returns a new immutable builder instance with `configDir` set while leaving the receiver unchanged.
   *
   * @param {string} path - Path to the Claude CLI directory (such as `'~/.claude-a'`).
   *
   * @returns {ClaudeAccountSeatBuilder} New immutable account seat builder with `configDir` configured.
   *
   * @throws {Error} If `path` is empty or whitespace-only.
   */
  configDir(path: string): ClaudeAccountSeatBuilder;

  /**
   * Binds a literal API key or symbolic `M.env(key)` reference for Anthropic API authentication.
   *
   * Returns a new immutable builder instance that resolves the key only at leaf turn invocation time.
   *
   * @param {string | EnvRef} envOrKey - Symbolic `EnvRef` or literal API key string.
   *
   * @returns {ClaudeAccountSeatBuilder} New immutable account seat builder with `apiKey` configured.
   *
   * @throws {Error} If `envOrKey` is an empty or whitespace-only string.
   */
  apiKey(envOrKey: string | EnvRef): ClaudeAccountSeatBuilder;

  /**
   * Compiles the builder configuration into a deeply frozen passive `ClaudeAccountSeatNode` AST node.
   *
   * Preserves a monomorphic property shape with `type: 'claude:account-seat'` and zero runtime methods.
   *
   * @returns {ClaudeAccountSeatNode} Frozen passive AST node representing the Claude account seat.
   */
  toAST(): ClaudeAccountSeatNode;
}
