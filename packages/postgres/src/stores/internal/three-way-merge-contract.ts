/**
 * Performs a deterministic line-based 3-way merge of `oursText` against `baseText` and `theirsText`.
 *
 * Fast-forwards cleanly when either side is unchanged from `baseText` or when both sides made identical edits,
 * merges non-overlapping line additions/modifications, and throws on conflicting edits to the same line.
 *
 * @param {string} baseText   - Pinned `baseContractTextAtAcquire` merge-base text.
 * @param {string} theirsText - Current canonical base store `contractText`.
 * @param {string} oursText   - Run overlay `contractText` being committed.
 *
 * @returns {string} Merged canonical contract text.
 *
 * @throws {Error} If `oursText` and `theirsText` modified the same line to different values.
 */
export function threeWayMergeContract(baseText: string, theirsText: string, oursText: string): string {
  if (oursText === baseText) return theirsText;
  if (theirsText === baseText || oursText === theirsText) return oursText;

  const baseLines = baseText.length === 0 ? [] : baseText.split('\n');
  const theirsLines = theirsText.length === 0 ? [] : theirsText.split('\n');
  const oursLines = oursText.length === 0 ? [] : oursText.split('\n');

  if (baseLines.length === theirsLines.length && baseLines.length === oursLines.length) {
    const mergedLines: string[] = [];
    for (let idx = 0; idx < baseLines.length; idx += 1) {
      const bLine = baseLines[idx] ?? '';
      const tLine = theirsLines[idx] ?? '';
      const oLine = oursLines[idx] ?? '';
      if (oLine === bLine) {
        mergedLines.push(tLine);
      } else if (tLine === bLine || oLine === tLine) {
        mergedLines.push(oLine);
      } else {
        throw new Error(
          `Topology 3-way merge conflict at line ${String(idx + 1)}: base='${bLine}', canonical='${tLine}', overlay='${oLine}'.`,
        );
      }
    }
    return mergedLines.join('\n');
  }

  if (theirsText.startsWith(baseText) && oursText.startsWith(baseText)) {
    const theirsSuffix = theirsText.slice(baseText.length);
    const oursSuffix = oursText.slice(baseText.length);
    if (theirsSuffix !== oursSuffix) {
      return `${baseText}${theirsSuffix}\n${oursSuffix.replace(/^\n/, '')}`;
    }
  }

  throw new Error(
    `Topology 3-way merge conflict: concurrent incompatible structural edits against base '${baseText}'.`,
  );
}
