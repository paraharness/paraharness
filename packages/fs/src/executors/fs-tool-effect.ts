import type { ToolEffect } from '@paraharness/core';

/**
 * Structured filesystem attributes attached to an `FsToolEffect` descriptor.
 *
 * Captures the access mode (`'read' | 'write'`), canonicalized worktree-relative POSIX
 * file paths, base-ref path existence (`existingPathsAtBaseRef`), and post-edit UTF-8
 * contents (`proposedContent`).
 */
export interface FsToolEffectAttributes extends Readonly<Record<string, unknown>> {
  /** Filesystem access mode (`'read'` for non-mutating reads/searches, `'write'` for edits/writes). */
  readonly mode: 'read' | 'write';
  /** Canonicalized worktree-relative POSIX file paths touched by the tool invocation. */
  readonly paths: readonly string[];
  /** Subset of `paths` that already existed at `scopeHandle.baseRef` prior to mutation. */
  readonly existingPathsAtBaseRef?: readonly string[];
  /** Proposed post-mutation UTF-8 file text keyed by normalized worktree-relative path. */
  readonly proposedContent?: Readonly<Record<string, string>>;
}

/**
 * Domain-specific `ToolEffect` emitted by `@paraharness/fs` tools and workspace diffs (`SPEC.md` §4.3).
 *
 * Sets `kind: 'fs:effect'` and `mutatesScope: true` on write mutations so `ScopeLockManager`,
 * policy guards, quota tripwires, and telemetry collectors can inspect filesystem operations.
 */
export interface FsToolEffect extends ToolEffect {
  /** Discriminant identifying a filesystem tool effect. */
  readonly kind: 'fs:effect';
  /** True when `attributes.mode === 'write'`, acquiring an exclusive scope write lock. */
  readonly mutatesScope: boolean;
  /** Structured filesystem effect attributes. */
  readonly attributes: FsToolEffectAttributes;
}
