import type { InlineScopedRuleNode } from './inline-scoped-rule-node.js';
import type { SourcedScopedRuleNode } from './sourced-scoped-rule-node.js';

/**
 * Passive AST node representing a partition- or effect-scoped rule (`H.scopedRule(...)`).
 */
export type ScopedRuleNode = InlineScopedRuleNode | SourcedScopedRuleNode;
