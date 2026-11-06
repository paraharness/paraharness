import type { RuntimeExecutorRegistry } from '../runtime-executor-registry.js';
import type { RuntimeExecutorRegistrySlice } from '../runtime-executor-registry-slice.js';

/**
 * Type guard checking whether a registry argument is a readonly array of `RuntimeExecutorRegistrySlice` entries.
 *
 * Used by `createExecutorRegistry` to flatten variadic slice arguments and nested slice arrays in a single pass.
 *
 * @param {RuntimeExecutorRegistrySlice | readonly RuntimeExecutorRegistrySlice[]} entry - Single slice or slice array.
 *
 * @returns {entry is readonly RuntimeExecutorRegistrySlice[]} True when `entry` is an array.
 */
export function isSliceArray(
  entry: RuntimeExecutorRegistrySlice | readonly RuntimeExecutorRegistrySlice[],
): entry is readonly RuntimeExecutorRegistrySlice[] {
  return Array.isArray(entry);
}

/**
 * Merges a single category across all flattened `RuntimeExecutorRegistrySlice` entries into a frozen category map.
 *
 * Iterates slices in registration order so later slices override earlier slices on duplicate `node.type` keys.
 *
 * @template K Category key of `RuntimeExecutorRegistry`.
 *
 * @param {readonly RuntimeExecutorRegistrySlice[]} slices   - Flattened slice array in registration order.
 * @param {K}                                       category - Category key to merge.
 *
 * @returns {Readonly<NonNullable<RuntimeExecutorRegistrySlice[K]>>} Frozen category map.
 */
export function mergeCategory<K extends keyof RuntimeExecutorRegistry>(
  slices: readonly RuntimeExecutorRegistrySlice[],
  category: K,
): Readonly<NonNullable<RuntimeExecutorRegistrySlice[K]>> {
  const merged: NonNullable<RuntimeExecutorRegistrySlice[K]> = {};
  for (const slice of slices) {
    const entries = slice[category];
    if (entries !== undefined) {
      Object.assign(merged, entries);
    }
  }
  return Object.freeze(merged);
}
