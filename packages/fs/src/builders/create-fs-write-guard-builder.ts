import type { FsWriteGuardNode } from '@harness-dsl/core';
import type { FsWriteGuardOptions } from './fs-write-guard-options.js';

/**
 * Compiles a passive `FsWriteGuardNode` (`fs:write-guard`) for `fs.writeGuard(options)`.
 *
 * Rejects write effects matching `options.denyGlobs` unless exempted by `options.allowGlobs`
 * or an active `LeaseDelta`, optionally scoping denials to files existing at `baseRef`.
 *
 * @param {FsWriteGuardOptions} options - Write guard deny/allow glob and baseRef options.
 *
 * @returns {FsWriteGuardNode} Deeply frozen `FsWriteGuardNode` AST descriptor.
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
