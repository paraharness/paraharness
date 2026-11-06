/**
 * Open declaration-mergeable registry for custom third-party domain adapter AST nodes.
 *
 * When unaugmented, `CustomDomainAST<K>` evaluates to `never` (preserving 100% literal `TUnion['type']` keys).
 * Peer packages (such as `@harness-dsl/stripe` and `@harness-dsl/netsuite`) augment this interface
 * via `declare module '@harness-dsl/core' { interface CustomDomainASTRegistry { ... } }`.
 */
export interface CustomDomainASTRegistry {}
