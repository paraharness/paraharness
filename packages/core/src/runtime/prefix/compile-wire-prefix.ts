import { createHash } from 'node:crypto';
import type { PrefixGroupNode } from '../../ast/prefix-group-node.js';
import type {
  CompiledWirePrefix,
  GroundingSnapshotRecord,
  WireToolSchema,
} from '../../ports/compiled-wire-prefix.js';
import type { CompileWirePrefixParams } from './compile-wire-prefix-params.js';
import {
  collectRoleScopedWireTools,
  collectUnionWireTools,
  resolveGlobalRuleDirectives,
  resolveSourceStringValue,
} from './internal/collect-prefix-tools.js';

/**
 * Compiles a single `PrefixGroupNode` into a pinned `CompiledWirePrefix` (`SPEC.md` §3.2.1).
 *
 * Resolves `.sharedGrounding()`, `.sharedInstructions()`, and `.sharedRules()` in AST declaration
 * order, builds `wireToolSchemasByRoleKey`, and computes the immutable `systemDigest`.
 *
 * @param {PrefixGroupNode}         group  - Prefix group AST node to compile.
 * @param {CompileWirePrefixParams} params - Prefix compilation parameters and runtime registry.
 *
 * @returns {Promise<CompiledWirePrefix>} Compiled and frozen wire prefix for `group.id`.
 */
async function compileSinglePrefixGroup(
  group: PrefixGroupNode,
  params: CompileWirePrefixParams,
): Promise<CompiledWirePrefix> {
  const groundingSnapshots: GroundingSnapshotRecord[] = [];
  const systemBlocks: string[] = [];
  for (const gSource of group.sharedGrounding) {
    const snap = await resolveSourceStringValue(
      gSource,
      params.registry,
      params.resolutionContext,
    );
    groundingSnapshots.push(snap);
    systemBlocks.push(snap.text);
  }
  for (const iSource of group.sharedInstructions) {
    const snap = await resolveSourceStringValue(
      iSource,
      params.registry,
      params.resolutionContext,
    );
    systemBlocks.push(snap.text);
  }
  const ruleDirectives = await resolveGlobalRuleDirectives(
    group.sharedRules,
    params.registry,
    params.resolutionContext,
  );
  for (const directive of ruleDirectives) {
    systemBlocks.push(directive);
  }
  const systemPromptText = systemBlocks.join('\n\n');
  const groupActors = [];
  for (const actor of params.actors) {
    if (actor.prefixGroup === undefined || actor.prefixGroup.id === group.id) {
      groupActors.push(actor);
    }
  }
  const wireToolSchemasByRoleKey: Record<string, readonly WireToolSchema[]> = {};
  if (group.toolsMode === 'union') {
    wireToolSchemasByRoleKey['*'] = collectUnionWireTools(
      groupActors,
      params.resolvedSkillsByRoleKey,
    );
  } else {
    for (const actor of groupActors) {
      wireToolSchemasByRoleKey[actor.roleKey] = collectRoleScopedWireTools(
        actor,
        params.resolvedSkillsByRoleKey?.get(actor.roleKey),
      );
    }
  }
  const frozenToolsMap = Object.freeze(wireToolSchemasByRoleKey);
  const systemDigest = createHash('sha256')
    .update(systemPromptText, 'utf8')
    .update(JSON.stringify(frozenToolsMap), 'utf8')
    .digest('hex');
  return Object.freeze<CompiledWirePrefix>({
    prefixGroupId: group.id,
    toolsMode: group.toolsMode,
    systemPromptText,
    systemDigest,
    groundingSnapshots: Object.freeze(groundingSnapshots),
    wireToolSchemasByRoleKey: frozenToolsMap,
  });
}

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
    const compiled = await compileSinglePrefixGroup(group, params);
    result.set(group.id, compiled);
  }
  return result;
}
