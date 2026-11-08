import type { SourceValue } from './ast-foundation.types.js';
import type { RulesNode } from './rules-node.js';

/**
 * Passive AST node representing a shared KV-cache prompt prefix group (`M.prefixGroup(id)`).
 *
 * Pins shared grounding files, shared instructions, and global rules in declaration order so all participating
 * actors transmit a byte-identical wire `system` prompt alongside role-scoped or union wire `tools`.
 */
export interface PrefixGroupNode {
  /** Discriminant identifying a prefix group AST node. */
  readonly type: 'harness:prefix-group';
  /** Unique identifier of the prefix group. */
  readonly id: string;
  /** Tool schema sharing mode (`'role-scoped'` per `roleKey` or `'union'` across all bound actors). */
  readonly toolsMode: 'role-scoped' | 'union';
  /** Ordered list of shared grounding sources pinned at the top of the system prompt. */
  readonly sharedGrounding: readonly SourceValue<string>[];
  /** Ordered list of shared epistemic posture or instruction sources pinned in the system prompt. */
  readonly sharedInstructions: readonly SourceValue<string>[];
  /** Optional `RulesNode` whose `globalRules` are pinned in the shared system prompt. */
  readonly sharedRules?: RulesNode;
}
