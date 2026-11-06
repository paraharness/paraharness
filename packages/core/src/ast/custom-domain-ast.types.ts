import type { CustomDomainASTRegistry } from './custom-domain-ast-registry.js';

/**
 * Resolves custom domain AST node types registered under either exact category key `K`
 * or namespaced `${K}:${string}` keys inside `CustomDomainASTRegistry`.
 *
 * Supporting both exact keys (`scope`, `tool`, `guard`) and namespaced keys (`tool:stripe`,
 * `scope:netsuite`) allows multiple third-party domain packages to augment `CustomDomainASTRegistry`
 * simultaneously in the same compilation unit without TypeScript `TS2717` property type collisions.
 *
 * @template K Category key prefix to extract from `CustomDomainASTRegistry`.
 */
export type CustomDomainAST<K extends string> =
  | (K extends keyof CustomDomainASTRegistry ? CustomDomainASTRegistry[K] : never)
  | {
      [P in keyof CustomDomainASTRegistry]: P extends `${K}:${string}`
        ? CustomDomainASTRegistry[P]
        : never;
    }[keyof CustomDomainASTRegistry];
