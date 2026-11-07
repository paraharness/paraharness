import { diff3Merge } from 'node-diff3';

/**
 * Splits a contract text string into an array of lines for 3-way line-level merging.
 *
 * Returns an empty array when `text` is empty so empty baselines do not introduce phantom blank lines.
 *
 * @param {string} text - Contract text to split.
 *
 * @returns {string[]} Array of lines.
 */
function splitContractLines(text: string): string[] {
  return text.length > 0 ? text.split('\n') : [];
}

/**
 * Resolves a `diff3Merge` conflict block by removing ancestor `o` lines deleted by either side
 * and concatenating surviving additions/modifications from `conflict.a` and `conflict.b`.
 *
 * Handles both adjacent-line hunk merges in `node-diff3` and concurrent same-line modifications (`SPEC.md` §3.3).
 *
 * @param {string[]}                                                                                        target   - Mutable output line buffer.
 * @param {{ readonly a: readonly string[]; readonly o: readonly string[]; readonly b: readonly string[] }} conflict - Conflict region from `diff3Merge`.
 *
 * @returns {void} Appends resolved lines to `target` in-place.
 */
function resolveConflictRegion(
  target: string[],
  conflict: {
    readonly a: readonly string[];
    readonly o: readonly string[];
    readonly b: readonly string[];
  },
): void {
  const oSet = new Set<string>(conflict.o);
  const aSet = new Set<string>(conflict.a);
  const bSet = new Set<string>(conflict.b);
  const seen = new Set<string>();
  for (const line of conflict.a) {
    if (oSet.has(line) && !bSet.has(line)) continue;
    if (!seen.has(line)) {
      target.push(line);
      seen.add(line);
    }
  }
  for (const line of conflict.b) {
    if (oSet.has(line) && !aSet.has(line)) continue;
    if (!seen.has(line)) {
      target.push(line);
      seen.add(line);
    }
  }
}

/**
 * Performs a 3-way merge of `overlayText` and `currentBaseText` against `baseAtAcquire` (`SPEC.md` §3.3).
 *
 * Uses `diff3Merge` (`node-diff3`) to merge non-conflicting line additions/modifications from both
 * `currentBaseText` and `overlayText`, falling back to section concatenation on conflict blocks.
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
  const regions = diff3Merge<string>(
    splitContractLines(currentBaseText),
    splitContractLines(baseAtAcquire),
    splitContractLines(overlayText),
  );
  const mergedLines: string[] = [];
  for (const region of regions) {
    if (region.ok !== undefined) {
      for (const line of region.ok) {
        mergedLines.push(line);
      }
      continue;
    }
    if (region.conflict !== undefined) {
      resolveConflictRegion(mergedLines, region.conflict);
    }
  }
  return mergedLines.join('\n');
}
