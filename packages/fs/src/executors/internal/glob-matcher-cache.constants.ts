/**
 * WeakMap cache of pre-compiled `(candidatePath: string) => boolean` matchers keyed by `globs` array reference (`Rule 4.4`).
 *
 * Avoids re-compiling `picomatch` regular expressions across repeated policy guard, matcher, and check evaluations.
 */
export const CACHED_GLOB_OR_EXACT_MATCHERS: WeakMap<
  readonly string[],
  (candidatePath: string) => boolean
> = new WeakMap<readonly string[], (candidatePath: string) => boolean>();
