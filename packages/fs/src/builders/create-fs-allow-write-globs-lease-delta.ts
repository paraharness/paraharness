import type { LeaseDelta } from '@paraharness/core';
import { createFsGlobMatcherBuilder } from './create-fs-glob-matcher-builder.js';

/**
 * Creates a serializable `LeaseDelta` unlocking writes to `globs` (`fs.allowWriteGlobs(globs)`).
 *
 * Emits a `grantedMatchers` entry with a deterministic `FsGlobMatcherNode` (`mode: 'write'`)
 * that matches both exact normalized file paths (including bracketed routes) and POSIX globs.
 *
 * @param {readonly string[]} globs - Exact file paths or POSIX glob patterns to unlock for writing.
 *
 * @returns {LeaseDelta} Deeply frozen `LeaseDelta` capability grant.
 */
export function createFsAllowWriteGlobsLeaseDelta(globs: readonly string[]): LeaseDelta {
  const matcher = createFsGlobMatcherBuilder(globs, 'write');
  return Object.freeze<LeaseDelta>({
    type: 'harness:lease-delta',
    id: `fs:allow-write-globs:${matcher.globs.join(',')}`,
    grantedMatchers: Object.freeze([matcher]),
  });
}
