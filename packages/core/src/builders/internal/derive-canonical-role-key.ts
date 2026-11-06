import type { ToolASTNode } from '../../ast/domain-ast.types.js';

/**
 * Derives the canonical, order-independent `roleKey` for an actor or loop cloned via `.withTools(...extraTools)`.
 *
 * Sorts deduplicated extra tool names lexicographically and formats `"${baseId}+tools:${sortedNames.join(',')}"`,
 * or returns `baseId` unchanged when `extraTools` is empty.
 *
 * @param {string}                          baseIdOrRoleKey - Base actor identifier or existing `roleKey`.
 * @param {readonly ToolASTNode<unknown>[]} extraTools      - Extra tools appended via `.withTools(...)`.
 *
 * @returns {string} Canonical role key indexing `CompiledWirePrefix.wireToolSchemasByRoleKey`.
 */
export function deriveCanonicalRoleKey(
  baseIdOrRoleKey: string,
  extraTools: readonly ToolASTNode<unknown>[],
): string {
  const markerIndex = baseIdOrRoleKey.indexOf('+tools:');
  const baseId = markerIndex >= 0 ? baseIdOrRoleKey.slice(0, markerIndex) : baseIdOrRoleKey;
  const uniqueNames = new Set<string>();
  if (markerIndex >= 0) {
    const existingCsv = baseIdOrRoleKey.slice(markerIndex + '+tools:'.length);
    for (const existingName of existingCsv.split(',')) {
      if (existingName.length > 0) {
        uniqueNames.add(existingName);
      }
    }
  }
  for (const tool of extraTools) {
    uniqueNames.add(tool.name);
  }
  if (uniqueNames.size === 0) {
    return baseId;
  }
  const sortedExtraToolNames = Array.from(uniqueNames).sort();
  return `${baseId}+tools:${sortedExtraToolNames.join(',')}`;
}
