import type { AgentNode } from '../../ast/agent-node.js';
import type { InlineSkillNode } from '../../ast/inline-skill-node.js';
import type { PrefixGroupNode } from '../../ast/prefix-group-node.js';
import type { CompiledWirePrefix } from '../../ports/compiled-wire-prefix.js';
import type { RecalledLoopLessonRecord } from '../../ports/loop-continuation-frame.js';
import type { ResolutionContext } from '../../ports/resolution-context.js';
import type { RuntimeExecutorRegistry } from '../../ports/runtime-executor-registry.js';
import type { TopologyPartitionState } from '../../ports/topology-partition-state.js';

/**
 * In-run grounding diff entry computed when an actor mutates a `.sharedGrounding()` source mid-run.
 *
 * Injected into `[ROLE_AND_SCOPE_CONTEXT]` and `[TOPOLOGY_SYNC]` frames so byte 0 of `systemPromptText`
 * remains immutable throughout the run (`SPEC.md` §1.2 Invariant 6 & §3.2.1).
 */
export interface InRunGroundingDiffRecord {
  /** Identifier of the mutated grounding source. */
  readonly sourceId: string;
  /** SHA-256 digest captured at run start in `CompiledWirePrefix.groundingSnapshots`. */
  readonly previousDigest: string;
  /** Updated SHA-256 digest observed in the active isolation scope. */
  readonly currentDigest: string;
  /** Updated full text content loaded from the active isolation scope. */
  readonly updatedText: string;
}

/**
 * Parameters for computing in-run grounding diffs against a pinned `CompiledWirePrefix`.
 *
 * Supplies the prefix group AST node, pinned compiled prefix, active scope handle, registry,
 * and base resolution context.
 */
export interface InRunGroundingDiffParams {
  /** Passive prefix group AST node declaring `.sharedGrounding()`. */
  readonly prefixGroup: PrefixGroupNode;
  /** Run-start pinned `CompiledWirePrefix` containing `groundingSnapshots`. */
  readonly compiledPrefix: CompiledWirePrefix;
  /** Active isolation scope handle (`GitWorktreeHandle` or test scope handle). */
  readonly scopeHandle: unknown;
  /** Runtime executor registry resolving `SourceASTNode` descriptors. */
  readonly registry: RuntimeExecutorRegistry;
  /** Base resolution context for the active run and step. */
  readonly resolutionContext: ResolutionContext;
}

/**
 * Catalog entry describing a mounted skill in the Turn-0 `[ROLE_AND_SCOPE_CONTEXT]` frame.
 *
 * Pairs the skill identifier and description with whether its `.when.partitions` predicate
 * matches the current task's `activePartitions`.
 */
export interface SkillCatalogEntryRecord {
  /** Unique identifier of the mounted skill. */
  readonly skillId: string;
  /** Short catalog description of when to pull the skill via `activateSkill`. */
  readonly description: string;
  /** True when the skill's `.when.partitions` predicate intersects `activePartitions`. */
  readonly highlighted: boolean;
}

/**
 * Parameters for constructing the Turn-0 `[ROLE_AND_SCOPE_CONTEXT]` user message frame.
 *
 * Consolidates role identity, active partitions, actor-specific grounding and instructions,
 * mounted skill catalog, live topology partition contracts, in-run grounding diffs, scoped rules,
 * and recalled empirical lessons.
 */
export interface RoleAndScopeContextFrameParams {
  /** Logical identifier of the active agent. */
  readonly agentId: string;
  /** Canonical order-independent `roleKey` of the active agent. */
  readonly roleKey: string;
  /** Active logical partitions extracted for the current step. */
  readonly activePartitions: readonly string[];
  /** Resolved actor-specific `.grounding()` text blocks. */
  readonly actorGroundingTexts?: readonly string[];
  /** Resolved actor-specific `.instructions()` text blocks. */
  readonly actorInstructionTexts?: readonly string[];
  /** Catalog of mounted skills discoverable via `activateSkill`. */
  readonly skillCatalog?: readonly SkillCatalogEntryRecord[];
  /** Live topology partition contracts and epochs loaded from `TopologyStore.getPartitions(runId)`. */
  readonly topologyPartitions?: readonly TopologyPartitionState[];
  /** In-run diffs for any `.sharedGrounding()` files modified within the current run. */
  readonly updatedGroundingDiffs?: readonly InRunGroundingDiffRecord[];
  /** Directives from scoped rules whose `.when.partitions` matched `activePartitions`. */
  readonly scopedRuleDirectives?: ReadonlyArray<{ readonly id: string; readonly directive: string }>;
  /** Empirical lessons recalled and scored for the current task and partitions. */
  readonly recalledLessons?: readonly RecalledLoopLessonRecord[];
}

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
  /** Optional reference to grounding diff parameters type for property reachability. */
  readonly diffTemplate?: InRunGroundingDiffParams;
  /** Optional reference to grounding diff record type for property reachability. */
  readonly diffRecordTemplate?: InRunGroundingDiffRecord;
  /** Optional reference to role context frame parameters for property reachability. */
  readonly contextFrameTemplate?: RoleAndScopeContextFrameParams;
}
