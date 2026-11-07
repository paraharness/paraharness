import type { LocalServiceNode, LocalServiceToolNode } from '@harness-dsl/core';

/**
 * Builds the `LocalServiceToolNode` descriptors for all `.interact()` tools on a `LocalServiceNode`.
 *
 * Sets `effectTracking: 'subprocess-post-flight'` on each emitted `LocalServiceToolNode`.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {LocalServiceNode} node - Passive daemon service AST node.
 *
 * @returns {readonly LocalServiceToolNode<THandle>[]} Frozen array of service tool AST nodes.
 */
export function buildServiceToolNodes<THandle = unknown>(
  node: LocalServiceNode,
): readonly LocalServiceToolNode<THandle>[] {
  const tools: LocalServiceToolNode<THandle>[] = [];
  for (const interaction of node.interactions) {
    tools.push(
      Object.freeze<LocalServiceToolNode<THandle>>({
        type: 'node:service-tool',
        name: interaction.toolName,
        description: interaction.description,
        inputSchema: interaction.inputSchema,
        effectTracking: 'subprocess-post-flight',
        serviceId: node.id,
      }),
    );
  }
  return Object.freeze(tools);
}
