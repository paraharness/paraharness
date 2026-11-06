import type { SourceValue } from '../ast/ast-foundation.types.js';
import type { RulesNode } from '../ast/rules-node.js';

/**
 * Optional copy-on-write state for `createPrefixGroupBuilder`.
 *
 * Captures the tool schema caching mode, shared grounding sources, shared instruction
 * sources, and optional shared rules registry node.
 */
export interface CreatePrefixGroupBuilderState {
  /** Tool schema sharing mode. */
  readonly toolsMode?: 'role-scoped' | 'union';
  /** Shared grounding sources. */
  readonly sharedGrounding?: readonly SourceValue<string>[];
  /** Shared instruction sources. */
  readonly sharedInstructions?: readonly SourceValue<string>[];
  /** Optional shared rules registry node. */
  readonly sharedRules?: RulesNode;
}
