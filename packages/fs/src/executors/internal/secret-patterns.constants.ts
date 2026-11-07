/**
 * Default regular expression source strings scanned by `fs:secret-literals` (`SPEC.md` §4.3).
 *
 * Detects OpenAI/Anthropic `sk-` keys, GitHub `ghp_` / `github_pat_` tokens, Slack `xox*-` tokens,
 * AWS `AKIA` access key IDs, and PEM private key headers.
 */
export const DEFAULT_SECRET_PATTERN_SOURCES: readonly string[] = Object.freeze([
  '\\bsk-[A-Za-z0-9_-]{16,}\\b',
  '\\bghp_[A-Za-z0-9]{20,}\\b',
  '\\bgithub_pat_[A-Za-z0-9_]{20,}\\b',
  '\\bxox[baprs]-[A-Za-z0-9-]{10,}\\b',
  '\\bAKIA[0-9A-Z]{16}\\b',
  '-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----',
]);

/**
 * Pre-compiled default regular expressions for `fs:secret-literals` (`Rule 4.4`).
 */
export const DEFAULT_COMPILED_SECRET_PATTERNS: readonly RegExp[] = Object.freeze([
  new RegExp('\\bsk-[A-Za-z0-9_-]{16,}\\b'),
  new RegExp('\\bghp_[A-Za-z0-9]{20,}\\b'),
  new RegExp('\\bgithub_pat_[A-Za-z0-9_]{20,}\\b'),
  new RegExp('\\bxox[baprs]-[A-Za-z0-9-]{10,}\\b'),
  new RegExp('\\bAKIA[0-9A-Z]{16}\\b'),
  new RegExp('-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'),
]);

/**
 * WeakMap cache mapping frozen custom secret pattern arrays to their compiled `RegExp` lists (`Rule 4.4`).
 */
export const CACHED_SECRET_PATTERN_LISTS = new WeakMap<
  readonly string[],
  readonly RegExp[]
>();
