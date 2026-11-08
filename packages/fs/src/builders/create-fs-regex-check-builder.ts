import type { FsRegexCheckNode } from '@paraharness/core';

/**
 * Configuration options for `fs.regexCheck(id, options)`.
 *
 * Specifies the target file globs to inspect among mutated files, the forbidden regex
 * pattern (as a `string` or `RegExp`), and the deficit message reported on match.
 */
export interface FsRegexCheckOptions {
  /** Glob patterns selecting mutated files to scan. */
  readonly targetGlobs: readonly string[];
  /** Regular expression pattern or `RegExp` instance that fails the check when matched. */
  readonly forbidPattern: string | RegExp;
  /** Optional regular expression flags when `forbidPattern` is provided as a string. */
  readonly forbidFlags?: string;
  /** Diagnostic message reported in `deficits` when a match is found. */
  readonly violationMessage: string;
}

/**
 * Resolves the normalized regular expression pattern source and flags from `options`.
 *
 * Validates that the compiled `RegExp` is syntactically valid at AST construction time.
 *
 * @param {FsRegexCheckOptions} options - Regex check options containing `forbidPattern` and `forbidFlags`.
 *
 * @returns {{ readonly forbidPattern: string; readonly forbidFlags: string | undefined }} Normalized pattern and optional flags.
 */
function resolveForbidPatternAndFlags(options: FsRegexCheckOptions): {
  readonly forbidPattern: string;
  readonly forbidFlags: string | undefined;
} {
  if (options.forbidPattern instanceof RegExp) {
    const rawFlags = options.forbidFlags ?? options.forbidPattern.flags;
    const forbidFlags = rawFlags.length > 0 ? rawFlags : undefined;
    void new RegExp(options.forbidPattern.source, forbidFlags);
    return { forbidPattern: options.forbidPattern.source, forbidFlags };
  }
  const forbidFlags =
    options.forbidFlags !== undefined && options.forbidFlags.length > 0
      ? options.forbidFlags
      : undefined;
  void new RegExp(options.forbidPattern, forbidFlags);
  return { forbidPattern: options.forbidPattern, forbidFlags };
}

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
 *
 * @throws {Error} If `id`, `options.targetGlobs`, or `options.violationMessage` is empty.
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
  const { forbidPattern, forbidFlags } = resolveForbidPatternAndFlags(options);
  return Object.freeze<FsRegexCheckNode<THandle>>({
    type: 'fs:regex-check',
    id: id.trim(),
    targetGlobs: Object.freeze([...options.targetGlobs]),
    forbidPattern,
    forbidFlags,
    violationMessage: options.violationMessage,
  });
}
