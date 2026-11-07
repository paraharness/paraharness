/**
 * Extracts the matched failure line and up to `graceLinesAfterMatch` trailing lines from `combinedOutput`.
 *
 * Starts at the beginning of the line containing `matchRange[0]` and includes `graceLinesAfterMatch`
 * complete lines following the line containing `matchRange[1]`.
 *
 * @param {string}                    combinedOutput       - Combined rolling `stdout` and `stderr` text buffer.
 * @param {readonly [number, number]} matchRange           - Inclusive start and exclusive end character offsets of the match.
 * @param {number}                    graceLinesAfterMatch - Maximum number of trailing lines to include after the match.
 *
 * @returns {string} Trimmed multi-line failure excerpt for `CheckEvaluationResult.deficits`.
 */
export function extractCircuitBreakerExcerpt(
  combinedOutput: string,
  matchRange: readonly [number, number],
  graceLinesAfterMatch: number,
): string {
  const [matchIndex, matchEndIndex] = matchRange;
  const lineStart = combinedOutput.lastIndexOf('\n', Math.max(0, matchIndex - 1)) + 1;
  const searchFrom =
    matchEndIndex > matchIndex && combinedOutput.charCodeAt(matchEndIndex - 1) === 10
      ? matchEndIndex - 1
      : matchEndIndex;
  const firstLineEnd = combinedOutput.indexOf('\n', searchFrom);
  if (firstLineEnd === -1) return combinedOutput.slice(lineStart).trim();
  let cursor = firstLineEnd + 1;
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
 * Checks whether at least `graceLinesAfterMatch` trailing lines have arrived after `matchRange`.
 *
 * Counts newline characters following the line where the circuit-breaker regex match ended.
 *
 * @param {string}                    combinedOutput       - Combined rolling `stdout` and `stderr` text buffer.
 * @param {readonly [number, number]} matchRange           - Inclusive start and exclusive end character offsets of the match.
 * @param {number}                    graceLinesAfterMatch - Required number of trailing lines after the match line.
 *
 * @returns {boolean} True when the match line and `graceLinesAfterMatch` trailing lines are buffered.
 */
export function hasCapturedGraceLines(
  combinedOutput: string,
  matchRange: readonly [number, number],
  graceLinesAfterMatch: number,
): boolean {
  const [matchIndex, matchEndIndex] = matchRange;
  const searchFrom =
    matchEndIndex > matchIndex && combinedOutput.charCodeAt(matchEndIndex - 1) === 10
      ? matchEndIndex - 1
      : matchEndIndex;
  const matchLineEnd = combinedOutput.indexOf('\n', searchFrom);
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
