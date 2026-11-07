import type { RoleAndScopeContextFrameParams } from '../role-and-scope-context-frame-params.js';

/**
 * Formats the structured Turn-0 `[ROLE_AND_SCOPE_CONTEXT]` user message frame (`SPEC.md` §3.2.1).
 *
 * Injects role identity, active partitions, actor instructions, skill catalog, live topology
 * partition contracts and epochs, in-run grounding diffs, partition-scoped rules, and recalled lessons.
 *
 * @param {RoleAndScopeContextFrameParams} params - Context sections for the active actor session.
 *
 * @returns {string} Formatted `[ROLE_AND_SCOPE_CONTEXT]` message text.
 */
export function buildRoleAndScopeContextFrame(params: RoleAndScopeContextFrameParams): string {
  const sections: string[] = [
    `[ROLE_AND_SCOPE_CONTEXT]`,
    `Actor: ${params.agentId} (roleKey: ${params.roleKey})`,
    `Active Partitions: ${params.activePartitions.length > 0 ? params.activePartitions.join(', ') : 'none'}`,
  ];
  if (params.actorGroundingTexts !== undefined && params.actorGroundingTexts.length > 0) {
    sections.push(`Grounding:\n${params.actorGroundingTexts.join('\n\n')}`);
  }
  if (params.actorInstructionTexts !== undefined && params.actorInstructionTexts.length > 0) {
    sections.push(`Role Instructions:\n${params.actorInstructionTexts.join('\n\n')}`);
  }
  if (params.skillCatalog !== undefined && params.skillCatalog.length > 0) {
    const lines: string[] = [];
    for (const s of params.skillCatalog) {
      lines.push(`- ${s.skillId}${s.highlighted ? ' [HIGHLIGHTED]' : ''}: ${s.description}`);
    }
    sections.push(`Mounted Skills:\n${lines.join('\n')}`);
  }
  if (params.topologyPartitions !== undefined && params.topologyPartitions.length > 0) {
    const lines: string[] = [];
    for (const p of params.topologyPartitions) {
      lines.push(`- ${p.partitionId} (epoch ${String(p.epoch)}): ${p.contractText}`);
    }
    sections.push(`Topology Contracts:\n${lines.join('\n')}`);
  }
  if (params.updatedGroundingDiffs !== undefined && params.updatedGroundingDiffs.length > 0) {
    const lines: string[] = [];
    for (const d of params.updatedGroundingDiffs) {
      lines.push(`- ${d.sourceId} (${d.previousDigest} -> ${d.currentDigest}):\n${d.updatedText}`);
    }
    sections.push(`Updated Grounding Diffs:\n${lines.join('\n')}`);
  }
  if (params.scopedRuleDirectives !== undefined && params.scopedRuleDirectives.length > 0) {
    const lines: string[] = [];
    for (const r of params.scopedRuleDirectives) {
      lines.push(`- [${r.id}] ${r.directive}`);
    }
    sections.push(`Scoped Rules:\n${lines.join('\n')}`);
  }
  if (params.recalledLessons !== undefined && params.recalledLessons.length > 0) {
    const lines: string[] = [];
    for (const l of params.recalledLessons) {
      lines.push(`- [${l.id}] ${l.directive}`);
    }
    sections.push(`Recalled Lessons:\n${lines.join('\n')}`);
  }
  return sections.join('\n\n');
}
