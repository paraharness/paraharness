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
