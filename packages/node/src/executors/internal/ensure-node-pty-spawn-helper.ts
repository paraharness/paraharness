import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

/**
 * Ensures the `node-pty` native `spawn-helper` binary carries executable permissions (`0o755`) on POSIX hosts.
 *
 * Prevents `posix_spawnp failed` errors on macOS when package managers extract prebuilt `spawn-helper`
 * binaries without the `+x` execute bit set.
 */
export function ensureNodePtySpawnHelperExecutable(): void {
  try {
    const req = createRequire(import.meta.url);
    const ptyEntry = req.resolve('node-pty');
    const ptyRoot = path.resolve(path.dirname(ptyEntry), '..');
    const candidates = [
      path.join(ptyRoot, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
      path.join(ptyRoot, 'build', 'Release', 'spawn-helper'),
      path.join(ptyRoot, 'build', 'Debug', 'spawn-helper'),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        fs.chmodSync(candidate, 0o755);
      }
    }
  } catch {
    return;
  }
}

/**
 * Checks whether `buffer` currently satisfies a string or compiled `RegExp` frame delimiter.
 *
 * Evaluates either string inclusion or `delimiterRegex.test(buffer)`.
 *
 * @param {string}             buffer         - Accumulated frame output text.
 * @param {string | object}    frameDelimiter - Configured string or regex delimiter descriptor.
 * @param {RegExp | undefined} delimiterRegex - Pre-compiled regular expression when `frameDelimiter` is not a string.
 *
 * @returns {boolean} True when the delimiter matches `buffer`.
 */
export function matchesPtyFrameDelimiter(
  buffer: string,
  frameDelimiter: string | object,
  delimiterRegex: RegExp | undefined,
): boolean {
  if (typeof frameDelimiter === 'string') {
    return buffer.includes(frameDelimiter);
  }
  if (delimiterRegex === undefined) return false;
  delimiterRegex.lastIndex = 0;
  return delimiterRegex.test(buffer);
}

/**
 * Strips the trailing prompt delimiter from a settled PTY frame buffer.
 *
 * Removes the last occurrence of a string delimiter or regex delimiter match and trims whitespace.
 *
 * @param {string}             buffer         - Settled frame output text.
 * @param {string | object}    frameDelimiter - Configured string or regex delimiter descriptor.
 * @param {RegExp | undefined} delimiterRegex - Pre-compiled regular expression when `frameDelimiter` is not a string.
 *
 * @returns {string} Cleaned turn output without the trailing prompt.
 */
export function stripPtyFrameDelimiter(
  buffer: string,
  frameDelimiter: string | object,
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
