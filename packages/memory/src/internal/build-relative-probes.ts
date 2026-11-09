import { extractStaticDirPrefix } from './extract-static-dir-prefix.js';
import {
  BRACE_GROUP_REGEX,
  CHAR_CLASS_CAPTURE_REGEX,
  DEFAULT_RELATIVE_PROBES,
  EXTGLOB_SEGMENT_REGEX,
  LEADING_BANG_REGEX,
  NEGATED_CHAR_CLASS_REGEX,
  PROBE_FILE_SEGMENT,
  PROBE_SUBDIR_SEGMENT,
  QUESTION_MARK_REGEX,
  STAR_RUN_REGEX,
  WILDCARD_RUN_REGEX,
} from './memory-protocol.constants.js';

/**
 * Recursively expands brace groups (`{a,b}`) in `pattern` into flat pattern alternatives.
 *
 * @param {string} pattern - Glob pattern potentially containing brace expressions.
 *
 * @returns {readonly string[]} Expanded pattern strings without brace groups.
 */
function expandBraceAlternatives(pattern: string): readonly string[] {
  const match = BRACE_GROUP_REGEX.exec(pattern);
  if (match === null || match.index === undefined) {
    return [pattern];
  }
  const fullMatch = match[0];
  const inner = match[1] ?? '';
  const prefix = pattern.slice(0, match.index);
  const suffix = pattern.slice(match.index + fullMatch.length);
  const options = inner.split(',');
  const expanded: string[] = [];
  for (const option of options) {
    for (const tail of expandBraceAlternatives(`${prefix}${option}${suffix}`)) {
      expanded.push(tail);
    }
  }
  return expanded;
}

/**
 * Replaces glob metacharacter tokens in a single non-`'**'` path segment with synthetic probe strings.
 *
 * @param {string} segment - Single path segment from a split glob pattern.
 *
 * @returns {readonly string[]} Synthetic probe segment variants.
 */
function buildSegmentProbes(segment: string): readonly string[] {
  const primary = segment
    .replace(EXTGLOB_SEGMENT_REGEX, PROBE_FILE_SEGMENT)
    .replace(CHAR_CLASS_CAPTURE_REGEX, PROBE_FILE_SEGMENT)
    .replace(WILDCARD_RUN_REGEX, PROBE_FILE_SEGMENT)
    .replace(LEADING_BANG_REGEX, '');
  const variants = new Set<string>();
  variants.add(primary.length > 0 ? primary : PROBE_FILE_SEGMENT);
  if (segment.includes('?') || segment.includes('[')) {
    const singleCharVariant = segment
      .replace(EXTGLOB_SEGMENT_REGEX, 'a')
      .replace(NEGATED_CHAR_CLASS_REGEX, 'z')
      .replace(CHAR_CLASS_CAPTURE_REGEX, (_m, chars: string) => chars[0] ?? 'a')
      .replace(QUESTION_MARK_REGEX, 'a')
      .replace(STAR_RUN_REGEX, PROBE_FILE_SEGMENT)
      .replace(LEADING_BANG_REGEX, '');
    if (singleCharVariant.length > 0) {
      variants.add(singleCharVariant);
    }
  }
  return [...variants];
}

/**
 * Appends each variant in `segVariants` to every existing prefix path in `prefixes`.
 *
 * @param {readonly (readonly string[])[]} prefixes    - Current accumulated path segment prefixes.
 * @param {readonly string[]}              segVariants - Variants for the next segment.
 *
 * @returns {string[][]} Expanded prefix array.
 */
function appendSegmentVariants(
  prefixes: readonly (readonly string[])[],
  segVariants: readonly string[],
): string[][] {
  const nextPrefixes: string[][] = [];
  for (const current of prefixes) {
    for (const variant of segVariants) {
      nextPrefixes.push([...current, variant]);
    }
  }
  return nextPrefixes;
}

/**
 * Expands a single brace-free sub-pattern segment list into relative probe paths, replacing each
 * `'**'` segment with both zero segments (`[]`) and one segment (`['__sub__']`).
 *
 * @param {readonly string[]} segments - Split POSIX path segments of the sub-pattern.
 *
 * @returns {readonly string[]} Generated relative probe strings for `segments`.
 */
function expandSegmentsToProbes(segments: readonly string[]): readonly string[] {
  let prefixes: string[][] = [[]];
  for (const segment of segments) {
    if (segment.length === 0) continue;
    if (segment === '**') {
      const nextPrefixes: string[][] = [];
      for (const current of prefixes) {
        nextPrefixes.push([...current]);
        nextPrefixes.push([...current, PROBE_SUBDIR_SEGMENT]);
      }
      prefixes = nextPrefixes;
    } else {
      prefixes = appendSegmentVariants(prefixes, buildSegmentProbes(segment));
    }
  }
  const results: string[] = [];
  for (const parts of prefixes) {
    if (parts.length > 0) {
      results.push(parts.join('/'));
    }
  }
  return results;
}

/**
 * Expands braces and segments for `rawCandidate` and adds non-empty relative probes to `probes`.
 *
 * @param {string}      rawCandidate - Candidate glob pattern or static-prefix-stripped sub-pattern.
 * @param {Set<string>} probes       - Mutable set of relative probe strings.
 *
 * @returns {void}
 */
function collectProbesForCandidatePattern(rawCandidate: string, probes: Set<string>): void {
  for (const expanded of expandBraceAlternatives(rawCandidate)) {
    for (const probe of expandSegmentsToProbes(expanded.split('/'))) {
      if (probe.length > 0) {
        probes.add(probe);
      }
    }
  }
}

/**
 * Constructs synthetic relative probe paths segment-wise for `pattern` (§4.3, §5.2).
 *
 * Takes both the sub-pattern after `extractStaticDirPrefix(pattern)` and the full `pattern`,
 * expands brace alternatives (`{a,b}`), replaces each `'**'` segment with `[]` and `['__sub__']`,
 * replaces remaining glob metacharacter tokens with `'__probe__'`, and always includes
 * `'__probe__'` and `'__sub__/__probe__'` in the returned deduplicated list.
 *
 * @param {string} pattern - Normalized POSIX path or glob pattern.
 *
 * @returns {readonly string[]} Frozen deduplicated list of relative probe paths.
 */
export function buildRelativeProbes(pattern: string): readonly string[] {
  const staticPrefix = extractStaticDirPrefix(pattern);
  const subPattern =
    staticPrefix.length === 0
      ? pattern
      : pattern === staticPrefix
        ? ''
        : pattern.slice(staticPrefix.length + 1);
  const candidatePatterns =
    subPattern.length > 0 && subPattern !== pattern ? [subPattern, pattern] : [pattern];
  const probes = new Set<string>();
  for (const rawCandidate of candidatePatterns) {
    collectProbesForCandidatePattern(rawCandidate, probes);
  }
  for (const fallbackProbe of DEFAULT_RELATIVE_PROBES) {
    probes.add(fallbackProbe);
  }
  return Object.freeze([...probes]);
}
