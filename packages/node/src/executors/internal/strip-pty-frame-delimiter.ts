import type { LocalDaemonRegexDescriptor } from '../../builders/local-daemon-builder.js';

/**
 * Strips the trailing prompt delimiter from a settled PTY frame buffer.
 *
 * Removes the last occurrence of a string delimiter or regex delimiter match and trims whitespace.
 *
 * @param {string}                              buffer         - Settled frame output text.
 * @param {string | LocalDaemonRegexDescriptor} frameDelimiter - Configured string or regex delimiter descriptor.
 * @param {RegExp | undefined}                  delimiterRegex - Pre-compiled regular expression when `frameDelimiter` is not a string.
 *
 * @returns {string} Cleaned turn output without the trailing prompt.
 */
export function stripPtyFrameDelimiter(
  buffer: string,
  frameDelimiter: string | LocalDaemonRegexDescriptor,
  delimiterRegex: RegExp | undefined,
): string {
  if (typeof frameDelimiter === 'string') {
    const idx = buffer.lastIndexOf(frameDelimiter);
    return (idx !== -1 ? buffer.slice(0, idx) : buffer).trim();
  }
  if (delimiterRegex !== undefined) {
    delimiterRegex.lastIndex = 0;
    return buffer.replace(delimiterRegex, '').trim();
  }
  return buffer.trim();
}
