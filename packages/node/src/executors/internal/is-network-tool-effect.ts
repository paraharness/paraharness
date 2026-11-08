import type { ToolEffect } from '@metaharness/core';

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
