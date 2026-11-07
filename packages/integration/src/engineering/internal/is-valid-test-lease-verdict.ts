import type { WorkItem } from '../engineering-schemas.schema.js';
import { TEST_FILE_SUFFIX_PATTERN } from './test-file-suffix-pattern.constants.js';

/**
 * Validates that a `leaseAdjudicator` verdict approves a non-empty subset of `req.requestedPaths` matching `.test.ts` or `.test.tsx` (`CODING_SAMPLE.md` §6.7).
 *
 * Pre-indexes `req.requestedPaths` into a `Set<string>` for $O(1)$ membership lookup and checks each unlocked
 * path against `TEST_FILE_SUFFIX_PATTERN` before granting `fs.allowWriteGlobs`.
 *
 * @param {WorkItem}                                                                                        _item   - Active worker `WorkItem` input.
 * @param {{ readonly requestedPaths: readonly string[]; readonly justification: string }}                  req     - Original `leaseRequest` interrupt payload.
 * @param {{ readonly approved: boolean; readonly unlockedGlobs: readonly string[]; readonly ruling: string }} verdict - Structured verdict returned by `leaseAdjudicator`.
 *
 * @returns {boolean} `true` when the verdict is approved and all `unlockedGlobs` are requested `.test.ts(x)` paths.
 */
export function isValidTestLeaseVerdict(
  _item: WorkItem,
  req: { readonly requestedPaths: readonly string[]; readonly justification: string },
  verdict: {
    readonly approved: boolean;
    readonly unlockedGlobs: readonly string[];
    readonly ruling: string;
  },
): boolean {
  if (!verdict.approved || verdict.unlockedGlobs.length === 0) {
    return false;
  }
  const requestedSet = new Set<string>(req.requestedPaths);
  for (const globPattern of verdict.unlockedGlobs) {
    if (!TEST_FILE_SUFFIX_PATTERN.test(globPattern) || !requestedSet.has(globPattern)) {
      return false;
    }
  }
  return true;
}
