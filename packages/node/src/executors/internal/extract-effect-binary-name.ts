import type { ToolEffect } from '@paraharness/core';

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
