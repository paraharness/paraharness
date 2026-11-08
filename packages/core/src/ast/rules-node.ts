import type { GlobalRule, ScopedRule } from '../schemas/core-rules.schema.js';
import type { SourceValue } from './ast-foundation.types.js';
import type { ScopedRuleNode } from './scoped-rule-node.types.js';

/**
 * Passive AST node representing a rule registry (`M.rules(id)`) combining always-on global rules and conditional scoped rules.
 *
 * Pins `globalRules` in the static system prompt (or Turn-0 context when absent from `prefixGroup`)
 * and dynamically evaluates `scopedRules` against active partitions and tool effects.
 */
export interface RulesNode {
  /** Discriminant identifying a rules registry AST node. */
  readonly type: 'harness:rules';
  /** Unique identifier of the rules registry. */
  readonly id: string;
  /** Ordered list of inline or source-backed global rules pinned in the system prompt. */
  readonly globalRules: readonly SourceValue<GlobalRule | readonly GlobalRule[]>[];
  /** Ordered list of inline `ScopedRuleNode` definitions or source-backed scoped rule collections. */
  readonly scopedRules: ReadonlyArray<
    ScopedRuleNode | SourceValue<ScopedRule | readonly ScopedRule[]>
  >;
}
