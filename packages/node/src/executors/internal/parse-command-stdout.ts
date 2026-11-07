/**
 * Parses trimmed `stdout` from a completed `local.command` subprocess.
 *
 * Returns `undefined` when `stdout` is empty, parses valid JSON payloads via `JSON.parse`,
 * and falls back to the trimmed UTF-8 string when `stdout` is not valid JSON.
 *
 * @param {string} stdout - Raw standard output captured from the subprocess.
 *
 * @returns {unknown} Parsed JSON value, trimmed string, or `undefined`.
 */
export function parseCommandStdout(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}
