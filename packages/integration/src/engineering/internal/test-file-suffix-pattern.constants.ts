/**
 * Pre-compiled regular expression matching TypeScript (`.test.ts`) and TSX (`.test.tsx`) test file paths (`CODING_SAMPLE.md` §6.7).
 *
 * Used by `isValidTestLeaseVerdict` to verify that `leaseAdjudicator` only unlocks test file globs.
 */
export const TEST_FILE_SUFFIX_PATTERN = /\.test\.tsx?$/;
