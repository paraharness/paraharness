import { createHash } from 'node:crypto';
import type {
  CompiledWirePrefix,
  GroundingSnapshotRecord,
  WireToolSchema,
} from '../../ports/compiled-wire-prefix.js';
import type {
  CompileWirePrefixParams,
  InRunGroundingDiffParams,
  InRunGroundingDiffRecord,
  RoleAndScopeContextFrameParams,
} from './compile-wire-prefix-params.js';
import {
  collectRoleScopedWireTools,
  collectUnionWireTools,
  resolveGlobalRuleDirectives,
  resolveSourceStringValue,
} from './internal/collect-prefix-tools.js';

/**
 * Compiles all `PrefixGroupNode` definitions in AST declaration order at the start of a flow run (`SPEC.md` §3.2.1).
 *
 * Resolves `.sharedGrounding()`, `.sharedInstructions()`, and `.sharedRules()`, snapshots
 * `groundingSnapshots`, and builds `wireToolSchemasByRoleKey` (`'role-scoped'` vs `'union'`).
 *
 * @param {CompileWirePrefixParams} params - Prefix compilation parameters and runtime registry.
 *
 * @returns {Promise<ReadonlyMap<string, CompiledWirePrefix>>} Map of `prefixGroupId` to pinned `CompiledWirePrefix`.
 */
export async function compileRunWirePrefixes(
  params: CompileWirePrefixParams,
): Promise<ReadonlyMap<string, CompiledWirePrefix>> {
  const result = new Map<string, CompiledWirePrefix>();
  for (const group of params.prefixGroups) {
    const groundingSnapshots: GroundingSnapshotRecord[] = [], systemBlocks: string[] = [];
    for (const gSource of group.sharedGrounding) {
      const snap = await resolveSourceStringValue(gSource, params.registry, params.resolutionContext);
      groundingSnapshots.push(snap);
      systemBlocks.push(snap.text);
    }
    for (const iSource of group.sharedInstructions) {
      const snap = await resolveSourceStringValue(iSource, params.registry, params.resolutionContext);
      systemBlocks.push(snap.text);
    }
    for (const d of await resolveGlobalRuleDirectives(group.sharedRules, params.registry, params.resolutionContext)) systemBlocks.push(d);
    const systemPromptText = systemBlocks.join('\n\n'), groupActors = [];
    for (const actor of params.actors) if (actor.prefixGroup === undefined || actor.prefixGroup.id === group.id) groupActors.push(actor);
    const wireToolSchemasByRoleKey: Record<string, readonly WireToolSchema[]> = {};
    if (group.toolsMode === 'union') {
      wireToolSchemasByRoleKey['*'] = collectUnionWireTools(groupActors, params.resolvedSkillsByRoleKey);
    } else {
      for (const a of groupActors) wireToolSchemasByRoleKey[a.roleKey] = collectRoleScopedWireTools(a, params.resolvedSkillsByRoleKey?.get(a.roleKey));
    }
    const frozenToolsMap = Object.freeze(wireToolSchemasByRoleKey);
    const systemDigest = createHash('sha256').update(systemPromptText, 'utf8').update(JSON.stringify(frozenToolsMap), 'utf8').digest('hex');
    result.set(group.id, Object.freeze<CompiledWirePrefix>({ prefixGroupId: group.id, toolsMode: group.toolsMode, systemPromptText, systemDigest, groundingSnapshots: Object.freeze(groundingSnapshots), wireToolSchemasByRoleKey: frozenToolsMap }));
  }
  return result;
}

/**
 * Computes in-run grounding diffs against a run's pinned `CompiledWirePrefix.groundingSnapshots`.
 *
 * Re-loads `.sharedGrounding()` sources with `scopeHandle` attached to `ResolutionContext` so
 * mid-run edits to grounding files are surfaced in `[ROLE_AND_SCOPE_CONTEXT]` and `[TOPOLOGY_SYNC]`
 * without mutating byte 0 of `systemPromptText`.
 *
 * @param {InRunGroundingDiffParams} params - Prefix group, pinned prefix, and active scope handle.
 *
 * @returns {Promise<readonly InRunGroundingDiffRecord[]>} Frozen array of grounding diff records for modified sources.
 */
export async function computeInRunGroundingDiffs(
  params: InRunGroundingDiffParams,
): Promise<readonly InRunGroundingDiffRecord[]> {
  const diffs: InRunGroundingDiffRecord[] = [];
  const scopedCtx = Object.freeze({
    runId: params.resolutionContext.runId,
    activePartitions: params.resolutionContext.activePartitions,
    observedEffects: params.resolutionContext.observedEffects,
    scopeHandle: params.scopeHandle,
    resolveEnv: (v: Parameters<typeof params.resolutionContext.resolveEnv>[0]) =>
      params.resolutionContext.resolveEnv(v),
  });
  for (let i = 0; i < params.prefixGroup.sharedGrounding.length; i += 1) {
    const gSource = params.prefixGroup.sharedGrounding[i];
    const snap = params.compiledPrefix.groundingSnapshots[i];
    if (gSource === undefined || snap === undefined) continue;
    const current = await resolveSourceStringValue(gSource, params.registry, scopedCtx);
    if (current.digest !== snap.digest) {
      diffs.push(
        Object.freeze<InRunGroundingDiffRecord>({
          sourceId: snap.sourceId,
          previousDigest: snap.digest,
          currentDigest: current.digest,
          updatedText: current.text,
        }),
      );
    }
  }
  return Object.freeze(diffs);
}

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
  if (params.actorGroundingTexts !== undefined && params.actorGroundingTexts.length > 0) sections.push(`Grounding:\n${params.actorGroundingTexts.join('\n\n')}`);
  if (params.actorInstructionTexts !== undefined && params.actorInstructionTexts.length > 0) sections.push(`Role Instructions:\n${params.actorInstructionTexts.join('\n\n')}`);
  if (params.skillCatalog !== undefined && params.skillCatalog.length > 0) {
    const lines: string[] = [];
    for (const s of params.skillCatalog) lines.push(`- ${s.skillId}${s.highlighted ? ' [HIGHLIGHTED]' : ''}: ${s.description}`);
    sections.push(`Mounted Skills:\n${lines.join('\n')}`);
  }
  if (params.topologyPartitions !== undefined && params.topologyPartitions.length > 0) {
    const lines: string[] = [];
    for (const p of params.topologyPartitions) lines.push(`- ${p.partitionId} (epoch ${String(p.epoch)}): ${p.contractText}`);
    sections.push(`Topology Contracts:\n${lines.join('\n')}`);
  }
  if (params.updatedGroundingDiffs !== undefined && params.updatedGroundingDiffs.length > 0) {
    const lines: string[] = [];
    for (const d of params.updatedGroundingDiffs) lines.push(`- ${d.sourceId} (${d.previousDigest} -> ${d.currentDigest}):\n${d.updatedText}`);
    sections.push(`Updated Grounding Diffs:\n${lines.join('\n')}`);
  }
  if (params.scopedRuleDirectives !== undefined && params.scopedRuleDirectives.length > 0) {
    const lines: string[] = [];
    for (const r of params.scopedRuleDirectives) lines.push(`- [${r.id}] ${r.directive}`);
    sections.push(`Scoped Rules:\n${lines.join('\n')}`);
  }
  if (params.recalledLessons !== undefined && params.recalledLessons.length > 0) {
    const lines: string[] = [];
    for (const l of params.recalledLessons) lines.push(`- [${l.id}] ${l.directive}`);
    sections.push(`Recalled Lessons:\n${lines.join('\n')}`);
  }
  return sections.join('\n\n');
}
