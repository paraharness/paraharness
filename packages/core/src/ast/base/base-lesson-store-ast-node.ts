/**
 * Domain-agnostic base AST node contract for empirical lesson stores (`LessonStoreASTNode`).
 *
 * Resolved against the host process root via `RuntimeExecutorRegistry.lessons[node.type]`
 * into a `LessonStore` instance.
 *
 * @template TType String-literal discriminant of the lesson store node.
 */
export interface BaseLessonStoreASTNode<TType extends string = string> {
  /** Unique string-literal discriminant of the lesson store node. */
  readonly type: TType;
}
