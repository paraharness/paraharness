import path from 'node:path';
import type { ToolEffect } from '@harness-dsl/core';

/**
 * Extracts the executable binary name from a `ToolEffect` if the effect describes a subprocess invocation.
 *
 * Inspects `attributes.binary`, `attributes.executable`, `attributes.command`, and `attributes.argv[0]`.
 *
 * @param {ToolEffect} effect - Proposed pre-flight or post-flight tool effect.
 *
 * @returns {string | undefined} Extracted binary string, or `undefined` for non-process effects.
 */
export function extractEffectBinaryName(effect: ToolEffect): string | undefined {
  const attrs = effect.attributes;
  if (attrs === undefined) return undefined;
  if (typeof attrs['binary'] === 'string' && attrs['binary'].length > 0) return attrs['binary'];
  if (typeof attrs['executable'] === 'string' && attrs['executable'].length > 0) {
    return attrs['executable'];
  }
  if (typeof attrs['command'] === 'string' && attrs['command'].length > 0) {
    return attrs['command'].trim().split(/\s+/)[0];
  }
  const argv = attrs['argv'];
  if (Array.isArray(argv) && typeof argv[0] === 'string' && argv[0].length > 0) {
    return argv[0];
  }
  return undefined;
}

/**
 * Checks whether `binaryName` or its POSIX/Windows basename matches any entry in `allowedBinaries`.
 *
 * Compares both the full path string and `path.basename(binaryName)` against `allowedSet`.
 *
 * @param {string}              binaryName  - Candidate binary name or path from a `ToolEffect`.
 * @param {ReadonlySet<string>} allowedSet  - Set of allowed binary names and basenames.
 *
 * @returns {boolean} True when the binary is permitted by the allowlist.
 */
export function isBinaryInAllowlist(
  binaryName: string,
  allowedSet: ReadonlySet<string>,
): boolean {
  return allowedSet.has(binaryName) || allowedSet.has(path.basename(binaryName));
}

/**
 * Determines whether a `ToolEffect` represents an outbound network operation.
 *
 * Matches network effect kinds (`'node:network'`, `'network'`, `'net:*'`, `'http:*'`) and
 * effects carrying `network: true`, `url`, or `host` attributes.
 *
 * @param {ToolEffect} effect - Proposed pre-flight or post-flight tool effect.
 *
 * @returns {boolean} True when `effect` performs or requests network access.
 */
export function isNetworkToolEffect(effect: ToolEffect): boolean {
  if (
    effect.kind === 'node:network' ||
    effect.kind === 'network' ||
    effect.kind.startsWith('net:') ||
    effect.kind.startsWith('http:')
  ) {
    return true;
  }
  const attrs = effect.attributes;
  if (attrs === undefined) return false;
  return (
    attrs['network'] === true ||
    typeof attrs['url'] === 'string' ||
    typeof attrs['host'] === 'string'
  );
}
