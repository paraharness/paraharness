import { buildRelativeProbes } from './build-relative-probes.js';
import { extractStaticDirPrefix } from './extract-static-dir-prefix.js';
import { getCompiledPicomatch } from './get-compiled-picomatch.js';
import { isDirectoryCandidate } from './is-directory-candidate.js';
import { isGlobPattern } from './is-glob-pattern.js';
import { DEFAULT_RELATIVE_PROBES } from './memory-protocol.constants.js';

/**
 * Evaluates Case 1 (Specific-to-Specific) of the 4-way context matching contract (§4.3).
 *
 * @param {string} queryPath   - Normalized non-glob query path `q`.
 * @param {string} contextPath - Normalized non-glob record context path `c`.
 *
 * @returns {boolean} `true` if `q` and `c` are equal or one is a descendant of the other.
 */
function matchSpecificToSpecific(queryPath: string, contextPath: string): boolean {
  return (
    queryPath === contextPath ||
    queryPath.startsWith(`${contextPath}/`) ||
    contextPath.startsWith(`${queryPath}/`)
  );
}

/**
 * Evaluates Case 2 (Specific-to-Pattern) and symmetric Case 3 (Pattern-to-Specific) of §4.3.
 *
 * @param {string}            specificPath - Normalized non-glob path (`q` in Case 2, `c` in Case 3).
 * @param {string}            globPattern  - Normalized glob pattern (`c` in Case 2, `q` in Case 3).
 * @param {readonly string[]} repoFiles    - Tracked workspace-relative POSIX file paths.
 *
 * @returns {boolean} `true` if `specificPath` and `globPattern` intersect under §4.3 Case 2/3.
 */
function matchSpecificToPattern(
  specificPath: string,
  globPattern: string,
  repoFiles: readonly string[],
): boolean {
  const matcher = getCompiledPicomatch(globPattern);
  if (matcher(specificPath)) {
    return true;
  }
  const staticPrefix = extractStaticDirPrefix(globPattern);
  if (isDirectoryCandidate(specificPath, repoFiles)) {
    const probes =
      staticPrefix === '' && repoFiles.length > 0
        ? DEFAULT_RELATIVE_PROBES
        : buildRelativeProbes(globPattern);
    for (const relProbe of probes) {
      if (matcher(`${specificPath}/${relProbe}`)) {
        return true;
      }
    }
  }
  if (
    staticPrefix.length > 0 &&
    (staticPrefix === specificPath || staticPrefix.startsWith(`${specificPath}/`))
  ) {
    return true;
  }
  const dirPrefix = `${specificPath}/`;
  for (const repoFile of repoFiles) {
    if ((repoFile === specificPath || repoFile.startsWith(dirPrefix)) && matcher(repoFile)) {
      return true;
    }
  }
  return false;
}

/**
 * Checks whether two static directory prefixes are hierarchically compatible (one is empty, equal,
 * or a directory ancestor of the other).
 *
 * @param {string} prefixA - First static directory prefix.
 * @param {string} prefixB - Second static directory prefix.
 *
 * @returns {boolean} `true` if `prefixA` and `prefixB` can share descendant paths.
 */
function arePrefixesHierarchicallyCompatible(prefixA: string, prefixB: string): boolean {
  return (
    prefixA === '' ||
    prefixB === '' ||
    prefixA === prefixB ||
    prefixA.startsWith(`${prefixB}/`) ||
    prefixB.startsWith(`${prefixA}/`)
  );
}

/**
 * Evaluates Case 4 (Pattern-to-Pattern) of the 4-way context matching contract (§4.3).
 *
 * @param {string}            queryGlob   - Normalized query glob pattern `q`.
 * @param {string}            contextGlob - Normalized record context glob pattern `c`.
 * @param {readonly string[]} repoFiles   - Tracked workspace-relative POSIX file paths.
 *
 * @returns {boolean} `true` if `queryGlob` and `contextGlob` overlap under §4.3 Case 4.
 */
function matchPatternToPattern(
  queryGlob: string,
  contextGlob: string,
  repoFiles: readonly string[],
): boolean {
  if (queryGlob === contextGlob) {
    return true;
  }
  const qMatcher = getCompiledPicomatch(queryGlob);
  const cMatcher = getCompiledPicomatch(contextGlob);
  if (qMatcher(contextGlob) || cMatcher(queryGlob)) {
    return true;
  }
  for (const repoFile of repoFiles) {
    if (qMatcher(repoFile) && cMatcher(repoFile)) {
      return true;
    }
  }
  const qPrefix = extractStaticDirPrefix(queryGlob);
  const cPrefix = extractStaticDirPrefix(contextGlob);
  if (!arePrefixesHierarchicallyCompatible(qPrefix, cPrefix)) {
    return false;
  }
  const deeperPrefix = qPrefix.length >= cPrefix.length ? qPrefix : cPrefix;
  const base = deeperPrefix === '' ? '' : `${deeperPrefix}/`;
  const combinedProbes = new Set<string>();
  for (const probe of buildRelativeProbes(queryGlob)) {
    combinedProbes.add(probe);
  }
  for (const probe of buildRelativeProbes(contextGlob)) {
    combinedProbes.add(probe);
  }
  for (const relProbe of combinedProbes) {
    const candidate = `${base}${relProbe}`;
    if (qMatcher(candidate) && cMatcher(candidate)) {
      return true;
    }
  }
  return false;
}

/**
 * Evaluates whether a single normalized query path/glob `q` matches a single normalized record
 * context path/glob `c` under the 4-way symmetric matching contract (§4.3).
 *
 * @param {string}            q         - Normalized query path or glob pattern.
 * @param {string}            c         - Normalized record context path or glob pattern.
 * @param {readonly string[]} repoFiles - Tracked workspace-relative POSIX file paths.
 *
 * @returns {boolean} `true` if `q` and `c` match under Case 1, Case 2, Case 3, or Case 4.
 */
export function matchSingleContextPair(
  q: string,
  c: string,
  repoFiles: readonly string[],
): boolean {
  const qIsGlob = isGlobPattern(q);
  const cIsGlob = isGlobPattern(c);
  if (!qIsGlob && !cIsGlob) {
    return matchSpecificToSpecific(q, c);
  }
  if (!qIsGlob && cIsGlob) {
    return matchSpecificToPattern(q, c, repoFiles);
  }
  if (qIsGlob && !cIsGlob) {
    return matchSpecificToPattern(c, q, repoFiles);
  }
  return matchPatternToPattern(q, c, repoFiles);
}

/**
 * Evaluates whether any normalized query path/glob in `queryPaths` matches any normalized record
 * context path/glob in `recordContext` under the 4-way symmetric matching contract (§4.3).
 *
 * @param {readonly string[]} queryPaths    - Normalized query paths or glob patterns `Q`.
 * @param {readonly string[]} recordContext - Normalized record context paths or glob patterns `C`.
 * @param {readonly string[]} repoFiles     - Tracked workspace-relative POSIX file paths.
 *
 * @returns {boolean} `true` if at least one `(q, c)` pair satisfies `matchSingleContextPair`.
 */
export function matchesContextScope(
  queryPaths: readonly string[],
  recordContext: readonly string[],
  repoFiles: readonly string[],
): boolean {
  for (const q of queryPaths) {
    for (const c of recordContext) {
      if (matchSingleContextPair(q, c, repoFiles)) {
        return true;
      }
    }
  }
  return false;
}
