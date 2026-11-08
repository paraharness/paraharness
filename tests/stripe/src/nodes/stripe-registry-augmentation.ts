import type { StripeMaxRefundGuardNode } from './stripe-max-refund-guard-node.js';
import type { StripeMaxRefundMatcherNode } from './stripe-max-refund-matcher-node.js';
import type { StripeReadToolNode } from './stripe-read-tool-node.js';

declare module '@paraharness/core' {
  /**
   * Augments `CustomDomainASTRegistry` with namespaced `@paraharness/stripe` domain AST nodes.
   *
   * Uses namespaced keys (`'tool:stripe'`, `'guard:stripe'`, `'effectMatcher:stripe'`) so
   * `@paraharness/stripe` and `@paraharness/netsuite` merge cleanly without `TS2717` collisions.
   */
  interface CustomDomainASTRegistry {
    /** Namespaced Stripe tool AST node entry. */
    readonly 'tool:stripe': StripeReadToolNode;
    /** Namespaced Stripe maximum refund policy guard AST node entry. */
    readonly 'guard:stripe': StripeMaxRefundGuardNode;
    /** Namespaced Stripe maximum refund lease effect matcher AST node entry. */
    readonly 'effectMatcher:stripe': StripeMaxRefundMatcherNode;
  }
}
