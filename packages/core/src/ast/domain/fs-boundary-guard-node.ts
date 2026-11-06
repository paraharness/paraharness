import type { BasePolicyGuardASTNode } from '../base/base-policy-guard-ast-node.js';
import type { FsPartitionMapNode } from './fs-partition-map-node.js';

/**
 * Passive AST node blocking unapproved writes to partition `boundaryGlobs` (`fs.boundaryGuard`).
 *
 * Rejects any filesystem write targeting a partition's public boundary files unless the active
 * actor holds an explicit capability lease covering those boundary paths.
 */
export interface FsBoundaryGuardNode extends BasePolicyGuardASTNode<'fs:boundary-guard'> {
  /** Filesystem partition map defining protected `boundaryGlobs` per partition. */
  readonly partitionMap: FsPartitionMapNode<string>;
}
