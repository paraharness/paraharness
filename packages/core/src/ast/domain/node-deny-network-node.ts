import type { BasePolicyGuardASTNode } from '../base/base-policy-guard-ast-node.js';

/**
 * Passive AST node denying outbound network access during subprocess execution (`local.denyNetwork`).
 *
 * Enforces network isolation on spawned OS subprocesses and rejects any declared network
 * effect unless explicitly leased.
 */
export interface NodeDenyNetworkNode extends BasePolicyGuardASTNode<'node:deny-network'> {}
