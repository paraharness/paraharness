import type { ToolEffect } from '@metaharness/core';
import { checkPathsExistAtBaseRef } from './check-paths-exist-at-base-ref.js';

/**
 * Builds an $O(1)$ per-effect `Set<string>` lookup for `existingPathsAtBaseRef` (`Rule 4.2`).
 *
 * Uses `effect.attributes['existingPathsAtBaseRef']` when populated, or falls back to
 * `checkPathsExistAtBaseRef(scopeHandle, ...)` once per `ToolEffect` instance.
 *
 * @param {unknown} scopeHandle - Active isolation scope handle for fallback `baseRef` inspection.
 *
 * @returns {(effect: ToolEffect, normPath: string) => boolean} Predicate returning `true` when `normPath` existed at `baseRef`.
 */
export function createEffectBaseRefPathLookup(
  scopeHandle: unknown,
): (effect: ToolEffect, normPath: string) => boolean {
  const cache = new WeakMap<ToolEffect, ReadonlySet<string>>();
  return (effect: ToolEffect, normPath: string): boolean => {
    let baseSet = cache.get(effect);
    if (baseSet === undefined) {
      const declaredBase = effect.attributes?.['existingPathsAtBaseRef'];
      const rawList = Array.isArray(declaredBase)
        ? (declaredBase as readonly string[])
        : checkPathsExistAtBaseRef(
            scopeHandle,
            (effect.attributes?.['paths'] as readonly string[] | undefined) ?? [normPath],
          );
      const constructed = new Set<string>();
      for (const item of rawList) {
        if (typeof item === 'string') {
          constructed.add(item.replace(/\\/g, '/').replace(/^\.\//, ''));
        }
      }
      baseSet = constructed;
      cache.set(effect, baseSet);
    }
    return baseSet.has(normPath);
  };
}
