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
