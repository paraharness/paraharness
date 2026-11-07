/**
 * Parses an HTTP `retry-after` header value in seconds into an epoch timestamp in milliseconds.
 *
 * Returns `undefined` when the header is absent, empty, or not a finite number.
 *
 * @param {string | null | undefined} retryAfterHeader - Raw `retry-after` header string.
 *
 * @returns {number | undefined} Epoch timestamp in milliseconds when the rate-limit window resets.
 */
export function parseOpenAiRetryAfterResetAtMs(
  retryAfterHeader: string | null | undefined,
): number | undefined {
  if (
    retryAfterHeader === null ||
    retryAfterHeader === undefined ||
    retryAfterHeader.trim().length === 0
  ) {
    return undefined;
  }
  const seconds = Number(retryAfterHeader);
  return Number.isFinite(seconds) ? Date.now() + seconds * 1_000 : undefined;
}
