/**
 * Open declaration-mergeable registry for custom third-party domain adapter AST nodes.
 *
 * When unaugmented, `CustomDomainAST<K>` evaluates to `never` (preserving 100% literal `TUnion['type']` keys).
 * Peer packages (such as `@paraharness/stripe` and `@paraharness/netsuite`) augment this interface
 * via `declare module '@paraharness/core' { interface CustomDomainASTRegistry { ... } }`.
 */
export interface CustomDomainASTRegistry {}
