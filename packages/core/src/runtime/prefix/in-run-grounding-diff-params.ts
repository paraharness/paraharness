import type { PrefixGroupNode } from '../../ast/prefix-group-node.js';
import type { CompiledWirePrefix } from '../../ports/compiled-wire-prefix.js';
import type { ResolutionContext } from '../../ports/resolution-context.js';
import type { RuntimeExecutorRegistry } from '../../ports/runtime-executor-registry.js';

/**
 * Parameters for computing in-run grounding diffs against a pinned `CompiledWirePrefix`.
 *
 * Supplies the prefix group AST node, pinned compiled prefix, active scope handle, registry,
 * and base resolution context.
 */
export interface InRunGroundingDiffParams {
  /** Passive prefix group AST node declaring `.sharedGrounding()`. */
  readonly prefixGroup: PrefixGroupNode;
  /** Run-start pinned `CompiledWirePrefix` containing `groundingSnapshots`. */
  readonly compiledPrefix: CompiledWirePrefix;
  /** Active isolation scope handle (`GitWorktreeHandle` or test scope handle). */
  readonly scopeHandle: unknown;
  /** Runtime executor registry resolving `SourceASTNode` descriptors. */
  readonly registry: RuntimeExecutorRegistry;
  /** Base resolution context for the active run and step. */
  readonly resolutionContext: ResolutionContext;
}
