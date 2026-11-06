import type { AgentNode } from '../../ast/agent-node.js';
import type { InlineSkillNode } from '../../ast/inline-skill-node.js';
import type { PrefixGroupNode } from '../../ast/prefix-group-node.js';
import type { ResolutionContext } from '../../ports/resolution-context.js';
import type { RuntimeExecutorRegistry } from '../../ports/runtime-executor-registry.js';

/**
 * Parameters for compiling all `PrefixGroupNode` instances at the start of a flow run (`SPEC.md` §3.2.1).
 *
 * Supplies the prefix group AST nodes, participating agent AST nodes, pre-resolved inline skills,
 * runtime executor registry, and host-root resolution context.
 */
export interface CompileWirePrefixParams {
  /** Prefix group AST nodes to compile and pin in `LedgerStore.compiledPrefixesJson`. */
  readonly prefixGroups: readonly PrefixGroupNode[];
  /** All participating `AgentNode` definitions across the flow or harness. */
  readonly actors: readonly AgentNode<unknown, unknown, unknown>[];
  /** Optional pre-resolved skill nodes indexed by `actor.roleKey`. */
  readonly resolvedSkillsByRoleKey?: ReadonlyMap<string, readonly InlineSkillNode<unknown>[]>;
  /** Runtime executor registry used to resolve `.sharedGrounding()`, `.sharedInstructions()`, and `.sharedRules()`. */
  readonly registry: RuntimeExecutorRegistry;
  /** Host-root resolution context for the starting run. */
  readonly resolutionContext: ResolutionContext;
}
