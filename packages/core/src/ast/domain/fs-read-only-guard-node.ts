import type { BasePolicyGuardASTNode } from '../base/base-policy-guard-ast-node.js';

/**
 * Passive AST node denying all filesystem write operations (`fs.readOnly`).
 *
 * Enforces read-only workspace access for adjudicators, evaluators, arbiters, and planners
 * across both declared and post-flight-diffed tools.
 */
export interface FsReadOnlyGuardNode extends BasePolicyGuardASTNode<'fs:read-only'> {}
