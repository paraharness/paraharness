/**
 * Performs a 3-way merge of `overlayText` and `currentBaseText` against `baseAtAcquire` (`SPEC.md` §3.3).
 *
 * Preserves non-conflicting line additions/modifications from both `currentBaseText` and `overlayText`
 * and falls back to section concatenation if both independently modified the same lines.
 *
 * @param {string} baseAtAcquire   - Contract text pinned when the run acquired or synced the partition.
 * @param {string} currentBaseText - Current committed contract text in the canonical base store.
 * @param {string} overlayText     - Contract text in the committing run's overlay.
 *
 * @returns {string} Merged canonical contract text.
 */
export function threeWayMergeContract(
  baseAtAcquire: string,
  currentBaseText: string,
  overlayText: string,
): string {
  if (currentBaseText === baseAtAcquire || currentBaseText.length === 0) {
    return overlayText;
  }
  if (overlayText === baseAtAcquire || overlayText === currentBaseText) {
    return currentBaseText;
  }
  const baseLines = baseAtAcquire.length > 0 ? baseAtAcquire.split('\n') : [];
  const currentLines = currentBaseText.split('\n');
  const overlayLines = overlayText.split('\n');
  const baseLineSet = new Set<string>(baseLines);
  const overlayLineSet = new Set<string>(overlayLines);
  const removedByOverlay = new Set<string>();
  for (const baseLine of baseLines) {
    if (!overlayLineSet.has(baseLine)) {
      removedByOverlay.add(baseLine);
    }
  }
  const mergedLines: string[] = [];
  const mergedSet = new Set<string>();
  for (const curLine of currentLines) {
    if (removedByOverlay.has(curLine)) {
      continue;
    }
    mergedLines.push(curLine);
    mergedSet.add(curLine);
  }
  for (const ovLine of overlayLines) {
    if (!baseLineSet.has(ovLine) && !mergedSet.has(ovLine)) {
      mergedLines.push(ovLine);
      mergedSet.add(ovLine);
    }
  }
  return mergedLines.join('\n');
}
