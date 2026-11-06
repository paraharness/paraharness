import type { RecalledLoopLessonRecord } from '../../ports/loop-continuation-frame.js';
import type { TopologyPartitionState } from '../../ports/topology-partition-state.js';
import type { InRunGroundingDiffRecord } from './in-run-grounding-diff-record.js';
import type { SkillCatalogEntryRecord } from './skill-catalog-entry-record.js';

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
