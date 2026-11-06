import type { SourceValue } from '../ast/ast-foundation.types.js';
import type { ScopedRuleNode } from '../ast/scoped-rule-node.js';
import type { GlobalRule, ScopedRule } from '../schemas/core-rules.schema.js';

/**
 * Optional copy-on-write state for `createRulesBuilder`.
 *
 * Stores the accumulated `globalRules` and `scopedRules` arrays across immutable
 * builder transitions.
 */
export interface CreateRulesBuilderState {
  /** Accumulated global rule sources. */
  readonly globalRules?: readonly SourceValue<GlobalRule | readonly GlobalRule[]>[];
  /** Accumulated scoped rule nodes or sources. */
  readonly scopedRules?: ReadonlyArray<
    ScopedRuleNode | SourceValue<ScopedRule | readonly ScopedRule[]>
  >;
}

export type { CreateRulesBuilderState as CreateRulesBuilderOptions };
