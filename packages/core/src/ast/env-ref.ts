/**
 * Symbolic reference to an environment variable or secret resolved lazily at leaf runtime execution.
 *
 * Constructed via `P.env(key)` so sensitive credentials are never evaluated at AST compilation
 * time or persisted as plaintext in `LedgerStore`.
 */
export interface EnvRef {
  /** Discriminant identifying an opaque environment variable reference. */
  readonly type: 'harness:env-ref';
  /** Environment variable name to resolve from the runtime environment map. */
  readonly key: string;
}
