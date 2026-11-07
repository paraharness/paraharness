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
  const endsWithNewline =
    matchEndIndex > matchIndex && combinedOutput.charCodeAt(matchEndIndex - 1) === 10;
  const searchFrom = endsWithNewline ? matchEndIndex - 1 : matchEndIndex;
  const matchLineEnd = combinedOutput.indexOf('\n', searchFrom);
  if (matchLineEnd === -1) {
    return false;
  }
  if (graceLinesAfterMatch <= 0) {
    return true;
  }
  const counter = { newlineCount: 0 };
  for (let i = matchLineEnd + 1; i < combinedOutput.length; i += 1) {
    if (combinedOutput.charCodeAt(i) === 10) {
      counter.newlineCount += 1;
      if (counter.newlineCount >= graceLinesAfterMatch) {
        return true;
      }
    }
  }
  return false;
}
