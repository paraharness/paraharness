/**
 * Domain-agnostic effect descriptor emitted pre-flight by `ToolDriver.describeEffects()`
 * or synthesized post-flight by `CheckpointableScope.diffEffects()`.
 *
 * Keyed on `mutatesScope` by `ScopeLockManager` to coordinate shared-read vs exclusive-write
 * locks and evaluated by `PolicyGuardASTNode`, `QuotaTripwireASTNode`, and `TelemetryCollectorASTNode`.
 */
export interface ToolEffect {
  /** Domain-qualified effect kind identifier (such as `'fs:effect'` or `'billing:effect'`). */
  readonly kind: string;
  /** Whether the effect mutates the active isolation scope state (`true` acquires an exclusive write lock). */
  readonly mutatesScope?: boolean;
  /** Domain-specific structured effect attributes (such as `paths`, `mode`, or `amountUsd`). */
  readonly attributes?: Readonly<Record<string, unknown>>;
}
