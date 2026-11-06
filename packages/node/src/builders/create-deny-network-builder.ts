import type { AstBuilder, NodeDenyNetworkNode } from '@harness-dsl/core';

/**
 * Creates a policy guard builder and passive AST node denying outbound network access (`local.denyNetwork`).
 *
 * Compiles to a frozen `NodeDenyNetworkNode` (`type: 'node:deny-network'`) that blocks network
 * effects and enforces network isolation on guarded subprocesses.
 *
 * @returns {AstBuilder<NodeDenyNetworkNode> & NodeDenyNetworkNode} Frozen deny-network guard builder and AST node.
 */
export function createDenyNetworkBuilder(): AstBuilder<NodeDenyNetworkNode> & NodeDenyNetworkNode {
  const astNode = Object.freeze<NodeDenyNetworkNode>({
    type: 'node:deny-network',
    id: 'node:deny-network',
  });
  return Object.freeze({
    type: 'node:deny-network' as const,
    id: 'node:deny-network',
    toAST(): NodeDenyNetworkNode {
      return astNode;
    },
  });
}
