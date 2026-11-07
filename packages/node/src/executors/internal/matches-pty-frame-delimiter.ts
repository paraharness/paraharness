import type { LocalDaemonRegexDescriptor } from '../../builders/local-daemon-builder.js';

/**
 * Checks whether `buffer` currently satisfies a string or compiled `RegExp` frame delimiter.
 *
 * Evaluates either string inclusion or `delimiterRegex.test(buffer)`.
 *
 * @param {string}                              buffer         - Accumulated frame output text.
 * @param {string | LocalDaemonRegexDescriptor} frameDelimiter - Configured string or regex delimiter descriptor.
 * @param {RegExp | undefined}                  delimiterRegex - Pre-compiled regular expression when `frameDelimiter` is not a string.
 *
 * @returns {boolean} True when the delimiter matches `buffer`.
 */
export function matchesPtyFrameDelimiter(
  buffer: string,
  frameDelimiter: string | LocalDaemonRegexDescriptor,
  delimiterRegex: RegExp | undefined,
): boolean {
  if (typeof frameDelimiter === 'string') {
    return buffer.includes(frameDelimiter);
  }
  if (delimiterRegex === undefined) {
    return false;
  }
  delimiterRegex.lastIndex = 0;
  return delimiterRegex.test(buffer);
}
