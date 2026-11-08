import type { FsBoundaryGuardNode, LeaseDelta } from '@paraharness/core';

/**
 * WeakMap cache of pre-compiled `(candidatePath: string) => boolean` matchers keyed by `globs` array reference (`Rule 4.4`).
 *
 * Avoids re-compiling `picomatch` regular expressions across repeated policy guard, matcher, and check evaluations.
 */
export const CACHED_GLOB_OR_EXACT_MATCHERS: WeakMap<
  readonly string[],
  (candidatePath: string) => boolean
> = new WeakMap<readonly string[], (candidatePath: string) => boolean>();

/**
 * WeakMap cache of pre-compiled boundary path matchers keyed by `FsBoundaryGuardNode` reference (`Rules 4.2 & 4.4`).
 *
 * Avoids calling `Object.keys` and allocating fresh `boundaryGlobs` arrays across repeated boundary guard evaluations.
 */
export const CACHED_BOUNDARY_GUARD_MATCHERS: WeakMap<
  FsBoundaryGuardNode,
  (candidatePath: string) => boolean
> = new WeakMap<FsBoundaryGuardNode, (candidatePath: string) => boolean>();

/**
 * WeakMap cache of pre-compiled active lease write matchers keyed by `activeLeases` array reference (`Rule 4.4`).
 *
 * Reuses the composed lease matcher predicate across repeated guard evaluations sharing the same `activeLeases` slice.
 */
export const CACHED_ACTIVE_LEASE_WRITE_MATCHERS: WeakMap<
  readonly LeaseDelta[],
  (candidatePath: string) => boolean
> = new WeakMap<readonly LeaseDelta[], (candidatePath: string) => boolean>();
