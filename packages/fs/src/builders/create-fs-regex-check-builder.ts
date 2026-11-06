import type { FsRegexCheckNode } from '@harness-dsl/core';
import type { FsRegexCheckOptions } from './fs-regex-check-options.js';

/**
 * Compiles a passive `FsRegexCheckNode` (`fs:regex-check`) for `fs.regexCheck(id, options)`.
 *
 * Normalizes `options.forbidPattern` (`string | RegExp`) into serializable `forbidPattern`
 * and `forbidFlags` properties and validates regular expression compilation at build time.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {string}              id      - Unique identifier for the regex check.
 * @param {FsRegexCheckOptions} options - Target globs, forbidden pattern, and violation message.
 *
 * @returns {FsRegexCheckNode<THandle>} Deeply frozen `FsRegexCheckNode` AST descriptor.
 */
export function createFsRegexCheckBuilder<THandle = unknown>(
  id: string,
  options: FsRegexCheckOptions,
): FsRegexCheckNode<THandle> {
  if (typeof id !== 'string' || id.trim().length === 0) {
    throw new Error('fs.regexCheck requires a non-empty check id.');
  }
  if (!Array.isArray(options.targetGlobs) || options.targetGlobs.length === 0) {
    throw new Error(`fs.regexCheck('${id}') requires a non-empty targetGlobs array.`);
  }
  if (typeof options.violationMessage !== 'string' || options.violationMessage.trim().length === 0) {
    throw new Error(`fs.regexCheck('${id}') requires a non-empty violationMessage.`);
  }
  const isRegExp = options.forbidPattern instanceof RegExp;
  const forbidPattern = isRegExp ? options.forbidPattern.source : options.forbidPattern;
  const rawFlags = options.forbidFlags ?? (isRegExp ? options.forbidPattern.flags : undefined);
  const forbidFlags = rawFlags !== undefined && rawFlags.length > 0 ? rawFlags : undefined;
  void new RegExp(forbidPattern, forbidFlags);
  return Object.freeze<FsRegexCheckNode<THandle>>({
    type: 'fs:regex-check',
    id: id.trim(),
    targetGlobs: Object.freeze([...options.targetGlobs]),
    forbidPattern,
    forbidFlags,
    violationMessage: options.violationMessage,
  });
}
