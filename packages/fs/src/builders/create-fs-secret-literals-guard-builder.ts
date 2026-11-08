import type { FsSecretLiteralsGuardNode } from '@paraharness/core';

/**
 * Compiles a passive `FsSecretLiteralsGuardNode` (`fs:secret-literals`) for `fs.secretLiterals(patterns)`.
 *
 * Scans `proposedContent` on pre-flight and post-flight file writes against built-in
 * credential patterns and any custom regex `patterns`.
 *
 * @param {readonly string[]} [patterns] - Optional custom regular expression pattern strings.
 *
 * @returns {FsSecretLiteralsGuardNode} Deeply frozen `FsSecretLiteralsGuardNode` AST descriptor.
 */
export function createFsSecretLiteralsGuardBuilder(
  patterns?: readonly string[],
): FsSecretLiteralsGuardNode {
  const frozenPatterns = patterns !== undefined ? Object.freeze([...patterns]) : undefined;
  return Object.freeze<FsSecretLiteralsGuardNode>({
    type: 'fs:secret-literals',
    id:
      frozenPatterns !== undefined && frozenPatterns.length > 0
        ? `fs:secret-literals:${frozenPatterns.join(',')}`
        : 'fs:secret-literals',
    patterns: frozenPatterns,
  });
}
