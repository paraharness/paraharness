import type { FsWriteGuardNode } from '@metaharness/core';

/**
 * Configuration options for `fs.writeGuard(options)`.
 *
 * Defines glob patterns that deny write mutations (`denyGlobs`), optional exemptions
 * (`allowGlobs`), and optional base-ref existence filtering (`onlyExistingAtBaseRef`).
 */
export interface FsWriteGuardOptions {
  /** Glob patterns denying write mutations. */
  readonly denyGlobs: readonly string[];
  /** Optional glob patterns exempted from `denyGlobs`. */
  readonly allowGlobs?: readonly string[];
  /** When `true`, blocks only paths that already existed at `handle.baseRef`. */
  readonly onlyExistingAtBaseRef?: boolean;
}

/**
 * Compiles a passive `FsWriteGuardNode` (`fs:write-guard`) for `fs.writeGuard(options)`.
 *
 * Rejects write effects matching `options.denyGlobs` unless exempted by `options.allowGlobs`
 * or an active `LeaseDelta`, optionally scoping denials to files existing at `baseRef`.
 *
 * @param {FsWriteGuardOptions} options - Write guard deny/allow glob and baseRef options.
 *
 * @returns {FsWriteGuardNode} Deeply frozen `FsWriteGuardNode` AST descriptor.
 *
 * @throws {Error} If `options.denyGlobs` is empty.
 */
export function createFsWriteGuardBuilder(options: FsWriteGuardOptions): FsWriteGuardNode {
  if (!Array.isArray(options.denyGlobs) || options.denyGlobs.length === 0) {
    throw new Error('fs.writeGuard requires a non-empty denyGlobs array.');
  }
  const denyGlobs = Object.freeze([...options.denyGlobs]);
  const allowGlobs =
    options.allowGlobs !== undefined ? Object.freeze([...options.allowGlobs]) : undefined;
  const allowKey = allowGlobs !== undefined ? allowGlobs.join(',') : '';
  const existingKey = String(options.onlyExistingAtBaseRef === true);
  return Object.freeze<FsWriteGuardNode>({
    type: 'fs:write-guard',
    id: `fs:write-guard:deny=${denyGlobs.join(',')}|allow=${allowKey}|existing=${existingKey}`,
    denyGlobs,
    allowGlobs,
    onlyExistingAtBaseRef: options.onlyExistingAtBaseRef,
  });
}
