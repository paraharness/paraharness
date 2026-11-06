import type { BasePolicyGuardASTNode } from '../base/base-policy-guard-ast-node.js';
import type { FsPartitionMapNode } from './fs-partition-map-node.js';

/**
 * Passive AST node restricting writes to the actor's active partitions (`fs.scopedWrite`).
 *
 * Resolves the union of member `globs` for `ResolutionContext.activePartitions` in `partitionMap`
 * and blocks writes outside those partitions unless covered by an elevated lease.
 */
export interface FsScopedWriteGuardNode extends BasePolicyGuardASTNode<'fs:scoped-write'> {
  /** Filesystem partition map associating partitions with member globs. */
  readonly partitionMap: FsPartitionMapNode<string>;
}
