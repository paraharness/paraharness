/**
 * Extracts the matched failure line and up to `graceLinesAfterMatch` trailing lines from `combinedOutput`.
 *
 * Starts at the beginning of the line containing `matchIndex` and includes `graceLinesAfterMatch`
 * complete lines following `matchEndIndex`.
 *
 * @param {string} combinedOutput       - Combined rolling `stdout` and `stderr` text buffer.
 * @param {number} matchIndex           - Character offset where the circuit-breaker regex matched.
 * @param {number} matchEndIndex        - Character offset where the circuit-breaker regex match ended.
 * @param {number} graceLinesAfterMatch - Maximum number of trailing lines to include after the match.
 *
 * @returns {string} Trimmed multi-line failure excerpt for `CheckEvaluationResult.deficits`.
 */
export function extractCircuitBreakerExcerpt(
  combinedOutput: string,
  matchIndex: number,
  matchEndIndex: number,
  graceLinesAfterMatch: number,
): string {
  const lineStart = combinedOutput.lastIndexOf('\n', Math.max(0, matchIndex - 1)) + 1;
  let cursor = matchEndIndex;
  const firstLineEnd = combinedOutput.indexOf('\n', cursor);
  if (firstLineEnd === -1) return combinedOutput.slice(lineStart).trim();
  cursor = firstLineEnd + 1;
  for (let i = 0; i < graceLinesAfterMatch; i += 1) {
    const nextNewline = combinedOutput.indexOf('\n', cursor);
    if (nextNewline === -1) {
      cursor = combinedOutput.length;
      break;
    }
    cursor = nextNewline + 1;
  }
  return combinedOutput.slice(lineStart, cursor).trim();
}

/**
 * Checks whether at least `graceLinesAfterMatch` trailing lines have arrived after `matchEndIndex`.
 *
 * Counts newline characters following the line containing `matchEndIndex`.
 *
 * @param {string} combinedOutput       - Combined rolling `stdout` and `stderr` text buffer.
 * @param {number} matchEndIndex        - Character offset where the regex match ended.
 * @param {number} graceLinesAfterMatch - Required number of trailing lines after the match line.
 *
 * @returns {boolean} True when the match line and `graceLinesAfterMatch` trailing lines are buffered.
 */
export function hasCapturedGraceLines(
  combinedOutput: string,
  matchEndIndex: number,
  graceLinesAfterMatch: number,
): boolean {
  const matchLineEnd = combinedOutput.indexOf('\n', matchEndIndex);
  if (matchLineEnd === -1) return false;
  let newlineCount = 0;
  for (let i = matchLineEnd + 1; i < combinedOutput.length; i += 1) {
    if (combinedOutput.charCodeAt(i) === 10) {
      newlineCount += 1;
      if (newlineCount >= graceLinesAfterMatch) return true;
    }
  }
  return graceLinesAfterMatch <= 0;
}
