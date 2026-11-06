/**
 * Domain-agnostic base AST node contract for lane signal rewind hooks (`ScopeRewindHookASTNode`).
 *
 * Invoked during Step 4 of the Hierarchical Rewind Drain Barrier when `.onSignal().rewindTo()`
 * rewinds an active run to an earlier flow step.
 *
 * @template TType   String-literal discriminant of the rewind hook node.
 * @template THandle Isolation scope handle type operated on by the hook.
 */
export interface BaseScopeRewindHookASTNode<TType extends string = string, THandle = unknown> {
  /** Unique string-literal discriminant of the scope rewind hook node. */
  readonly type: TType;
  /** Logical identifier of the rewind hook. */
  readonly id: string;
  /** Whether executing this rewind hook also resets uncommitted run topology overlay mutations. */
  readonly resetsRunOverlay?: boolean;
  /** Phantom type brand binding the hook to its compatible scope handle type. */
  readonly __handleBrand?: THandle;
}
