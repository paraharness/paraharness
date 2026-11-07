import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, extname, posix, resolve } from 'node:path';
import {
  type FsGlobMatcherNode,
  GlobalRuleSchema,
  type InlineSkillNode,
  type ScopePredicate,
  ScopedRuleSchema,
} from '@harness-dsl/core';
import picomatch from 'picomatch';
import { glob } from 'tinyglobby';
import type { ParsedMarkdownDocument } from '../parsed-markdown-document.js';

/**
 * Resolves a host-root-relative file path or glob pattern into sorted relative POSIX paths.
 *
 * Uses `tinyglobby` and `picomatch` when glob tokens are present or expands directory paths to `**\/*.md`.
 *
 * @param {string} hostRoot   - Absolute host repository root path.
 * @param {string} pathOrGlob - Relative path or glob pattern to resolve.
 *
 * @returns {Promise<readonly string[]>} Sorted array of matched relative POSIX file paths.
 */
export async function resolveMarkdownFiles(
  hostRoot: string,
  pathOrGlob: string,
): Promise<readonly string[]> {
  let cleanPattern = pathOrGlob.replace(/\\/g, '/').replace(/^\.\//, '');
  const initialScan = picomatch.scan(cleanPattern);
  if (!initialScan.isGlob && !initialScan.negated) {
    const absPath = resolve(hostRoot, cleanPattern);
    const targetStat = await stat(absPath);
    if (targetStat.isFile()) return Object.freeze([cleanPattern]);
    if (!targetStat.isDirectory()) throw new Error(`Markdown path '${pathOrGlob}' is not a regular file.`);
    cleanPattern = `${cleanPattern.replace(/\/+$/, '')}/**/*.md`;
  }
  const activeScan = picomatch.scan(cleanPattern);
  const isAbs = cleanPattern.startsWith('/');
  const searchCwd = isAbs ? (activeScan.base.length > 0 ? activeScan.base : '/') : hostRoot;
  if (!existsSync(searchCwd)) return Object.freeze([]);
  const relGlob = isAbs ? posix.relative(searchCwd, cleanPattern) : cleanPattern;
  const rawEntries = await glob(relGlob, {
    cwd: searchCwd,
    dot: true,
    onlyFiles: true,
    ignore: ['**/.git/**', '**/node_modules/**'],
  });
  const isMatch = picomatch(cleanPattern, { dot: true });
  const matched: string[] = [];
  for (const entry of rawEntries) {
    const cleanEntry = entry.replace(/\\/g, '/').replace(/\/+$/, '');
    const candidate = isAbs ? posix.join(searchCwd, cleanEntry) : cleanEntry;
    if (isMatch(candidate)) matched.push(candidate);
  }
  matched.sort((a, b) => a.localeCompare(b));
  return Object.freeze(matched);
}

/**
 * Translates YAML frontmatter `partitions` and `globs` into a passive `ScopePredicate` record.
 *
 * Emits a passive `FsGlobMatcherNode` (`type: 'fs:match-globs'`, `mode: 'write'`) with a deterministic `id`
 * whenever frontmatter `globs` is non-empty without importing `@harness-dsl/fs`.
 *
 * @param {Readonly<Record<string, unknown>>} frontmatter - Parsed YAML frontmatter key-value record.
 *
 * @returns {ScopePredicate} Frozen `ScopePredicate` with `partitions` and optional `effects`.
 */
export function buildScopePredicateFromFrontmatter(
  frontmatter: Readonly<Record<string, unknown>>,
): ScopePredicate {
  const rawPartitions = frontmatter['partitions'];
  const partitions: string[] = [];
  if (Array.isArray(rawPartitions)) {
    for (const rawEntry of rawPartitions) if (typeof rawEntry === 'string') partitions.push(rawEntry);
  }
  const rawGlobs = frontmatter['globs'];
  const globs: string[] = [];
  if (Array.isArray(rawGlobs)) {
    for (const rawEntry of rawGlobs) if (typeof rawEntry === 'string') globs.push(rawEntry);
  }
  if (globs.length === 0) {
    return Object.freeze<ScopePredicate>({ partitions, effects: undefined });
  }
  const effectsNode = Object.freeze<FsGlobMatcherNode>({
    type: 'fs:match-globs',
    id: `fs:match-globs:write:${globs.join(',')}`,
    globs: Object.freeze(globs),
    mode: 'write',
  });
  return Object.freeze<ScopePredicate>({ partitions, effects: effectsNode });
}

/**
 * Converts a single `ParsedMarkdownDocument` into a validated rule, skill, or frontmatter record.
 *
 * Dispatches on `kind` to validate `GlobalRuleSchema`, `ScopedRuleSchema`, `InlineSkillNode`, or raw metadata.
 *
 * @param {string}                 kind    - Loader kind discriminant (`'global-rules'`, `'scoped-rule'`, etc.).
 * @param {string}                 relPath - Host-root-relative POSIX file path.
 * @param {ParsedMarkdownDocument} parsed  - Parsed frontmatter and Markdown body.
 *
 * @returns {unknown} Validated domain rule, skill node, or frontmatter record.
 */
export function buildMarkdownDomainItem(
  kind: string,
  relPath: string,
  parsed: ParsedMarkdownDocument,
): unknown {
  const fallbackId = basename(relPath, extname(relPath));
  const id = typeof parsed.frontmatter['id'] === 'string' ? parsed.frontmatter['id'] : fallbackId;
  const rawDirective = parsed.frontmatter['directive'];
  const directiveText = parsed.body.length > 0 ? parsed.body : typeof rawDirective === 'string' ? rawDirective : '';
  const when = buildScopePredicateFromFrontmatter(parsed.frontmatter);
  if (kind === 'global-rules') {
    return Object.freeze(GlobalRuleSchema.parse({ id, directive: directiveText }));
  }
  if (kind === 'scoped-rule' || kind === 'scoped-rules') {
    return Object.freeze(ScopedRuleSchema.parse({ id, when, directive: directiveText, checks: [] }));
  }
  if (kind === 'skill' || kind === 'skills') {
    const rawDesc = parsed.frontmatter['description'];
    const description = typeof rawDesc === 'string' ? rawDesc : id;
    const hasWhen = when.partitions.length > 0 || when.effects !== undefined;
    return Object.freeze<InlineSkillNode>({
      type: 'harness:skill',
      id,
      source: undefined,
      when: hasWhen ? when : undefined,
      description,
      instructions: directiveText,
      unlockedTools: Object.freeze([]),
      unlockedServices: Object.freeze([]),
      leaseMode: 'until-completed-or-fork-exit',
    });
  }
  return Object.freeze({ ...parsed.frontmatter, id, when, directive: directiveText, frontmatter: parsed.frontmatter, body: parsed.body });
}
