/**
 * Parses a positive integer GitHub issue number from an external item key such as `'#42'` or `'42'`.
 *
 * Strips any leading `'#'` prefix and validates that the remaining value is a positive integer.
 *
 * @param {string} itemKey - External tracker item key (`'#42'` or `'42'`).
 * @param {string} repo    - Repository slug used in diagnostic error messages.
 *
 * @returns {number} Parsed positive integer GitHub issue number.
 *
 * @throws {Error} If `itemKey` does not parse to a positive integer.
 */
export function parseGithubIssueNumber(itemKey: string, repo: string): number {
  const rawNumber = itemKey.startsWith('#') ? itemKey.slice(1).trim() : itemKey.trim();
  const issueNumber = Number.parseInt(rawNumber, 10);
  if (rawNumber.length === 0 || !Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new Error(
      `Invalid itemKey '${itemKey}' in GithubIssuesTrackerAdapter.setExternalState for '${repo}'.`,
    );
  }
  return issueNumber;
}
