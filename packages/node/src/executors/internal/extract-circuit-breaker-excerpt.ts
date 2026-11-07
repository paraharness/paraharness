/**
 * Advances `startOffset` across at most `graceLinesAfterMatch` newline characters in `combinedOutput`.
 *
 * Returns `combinedOutput.length` if fewer than `graceLinesAfterMatch` trailing newlines exist.
 *
 * @param {string} combinedOutput       - Combined rolling `stdout` and `stderr` text buffer.
 * @param {number} startOffset          - Character index immediately after the matched line's newline.
 * @param {number} graceLinesAfterMatch - Maximum number of trailing lines to include.
 *
 * @returns {number} Exclusive end offset of the captured grace window.
 */
function resolveGraceWindowEndOffset(
  combinedOutput: string,
  startOffset: number,
  graceLinesAfterMatch: number,
): number {
  const state = { cursor: startOffset };
  for (let i = 0; i < graceLinesAfterMatch; i += 1) {
    const nextNewline = combinedOutput.indexOf('\n', state.cursor);
    if (nextNewline === -1) {
      return combinedOutput.length;
    }
    state.cursor = nextNewline + 1;
  }
  return state.cursor;
}

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
  const endsWithNewline =
    matchEndIndex > matchIndex && combinedOutput.charCodeAt(matchEndIndex - 1) === 10;
  const searchFrom = endsWithNewline ? matchEndIndex - 1 : matchEndIndex;
  const firstLineEnd = combinedOutput.indexOf('\n', searchFrom);
  if (firstLineEnd === -1) {
    return combinedOutput.slice(lineStart).trim();
  }
  const endOffset = resolveGraceWindowEndOffset(
    combinedOutput,
    firstLineEnd + 1,
    graceLinesAfterMatch,
  );
  return combinedOutput.slice(lineStart, endOffset).trim();
}
