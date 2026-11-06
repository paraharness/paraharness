import type { AstBuilder, NodeAllowBinariesNode } from '@harness-dsl/core';

/**
 * Creates a policy guard builder and passive AST node restricting subprocess binaries (`local.allowBinaries`).
 *
 * Compiles to a frozen `NodeAllowBinariesNode` (`type: 'node:allow-binaries'`) that rejects
 * any subprocess invocation whose binary name or basename is absent from `binaries`.
 *
 * @param {readonly string[]} binaries - Allowed executable binary names.
 *
 * @returns {AstBuilder<NodeAllowBinariesNode> & NodeAllowBinariesNode} Frozen allow-binaries guard builder and AST node.
 *
 * @throws {Error} If `binaries` is empty or contains an empty string.
 */
export function createAllowBinariesBuilder(
  binaries: readonly string[],
): AstBuilder<NodeAllowBinariesNode> & NodeAllowBinariesNode {
  if (binaries.length === 0) {
    throw new Error('local.allowBinaries requires at least one allowed binary name.');
  }
  const normalized: string[] = [];
  for (const binary of binaries) {
    if (binary.trim().length === 0) {
      throw new Error('local.allowBinaries cannot contain empty binary names.');
    }
    normalized.push(binary);
  }
  const frozenBinaries = Object.freeze(normalized);
  const id = `node:allow-binaries:${frozenBinaries.join(',')}`;
  const astNode = Object.freeze<NodeAllowBinariesNode>({
    type: 'node:allow-binaries',
    id,
    binaries: frozenBinaries,
  });
  return Object.freeze({
    type: 'node:allow-binaries' as const,
    id,
    binaries: frozenBinaries,
    toAST(): NodeAllowBinariesNode {
      return astNode;
    },
  });
}
