import type { BasePolicyGuardASTNode } from '../base/base-policy-guard-ast-node.js';

/**
 * Passive AST node requiring an existing file to be read in the session before it is edited or overwritten (`fs.requireReadBeforeWrite`).
 *
 * Prevents blind file overwrites by verifying that any pre-existing target path has a prior
 * `FsToolEffect` read record in the current actor session.
 */
export interface FsRequireReadBeforeWriteGuardNode
  extends BasePolicyGuardASTNode<'fs:require-read-before-write'> {}
