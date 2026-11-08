import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type {
  MarkdownFrontmatterSourceNode,
  MarkdownSectionSourceNode,
  ResolutionContext,
  ResolvedSourceArtifact,
} from '@paraharness/core';
import picomatch from 'picomatch';
import { buildMarkdownDomainItem } from '../parser/internal/build-markdown-domain-item.js';
import {
  extractMarkdownHeadingSection,
  parseMarkdownFrontmatter,
} from '../parser/internal/parse-markdown-frontmatter.js';
import { resolveMarkdownFiles } from '../parser/internal/resolve-markdown-files.js';
import { resolveFrontmatterLoaderKind } from './internal/resolve-frontmatter-loader-kind.js';

/**
 * Executes a `MarkdownFrontmatterSourceNode<T>` against the immutable host repository root (`SPEC.md` §3.4, §4.5).
 *
 * Parses YAML frontmatter and Markdown bodies, translates frontmatter `globs` into passive `FsGlobMatcherNode`
 * descriptors, validates rule schemas, and returns `{ content, digest }`.
 *
 * @template T Resolved rule, skill, or frontmatter payload type.
 *
 * @param {MarkdownFrontmatterSourceNode<T>} node   - Passive frontmatter source AST node.
 * @param {unknown}                          _input - Unused executor input parameter.
 * @param {ResolutionContext}                _ctx   - Active source resolution context.
 *
 * @returns {Promise<ResolvedSourceArtifact<T>>} Resolved payload and SHA-256 hex digest.
 */
export async function executeMarkdownFrontmatterSource<T = unknown>(
  node: MarkdownFrontmatterSourceNode<T>,
  _input: unknown,
  _ctx: ResolutionContext,
): Promise<ResolvedSourceArtifact<T>> {
  const hostRoot = process.cwd();
  const kind = resolveFrontmatterLoaderKind(node);
  const matchedPaths = await resolveMarkdownFiles(hostRoot, node.pathOrGlob);
  const isCollectionKind =
    kind === 'global-rules' ||
    kind === 'scoped-rules' ||
    kind === 'skills' ||
    (kind === 'frontmatter' && picomatch.scan(node.pathOrGlob).isGlob);
  if (!isCollectionKind && matchedPaths.length === 0) {
    throw new Error(`Markdown source '${node.id}' matched 0 files for '${node.pathOrGlob}'.`);
  }
  const hash = createHash('sha256');
  const items: unknown[] = [];
  for (const relPath of matchedPaths) {
    const raw = await readFile(resolve(hostRoot, relPath), 'utf8');
    hash.update(`${relPath}\0${raw}\0`, 'utf8');
    const parsed = parseMarkdownFrontmatter(raw);
    items.push(buildMarkdownDomainItem({ kind, relPath, parsed }));
  }
  const content = (isCollectionKind ? Object.freeze(items) : items[0]) as T;
  return Object.freeze<ResolvedSourceArtifact<T>>({
    content,
    digest: hash.digest('hex'),
  });
}

/**
 * Executes a `MarkdownSectionSourceNode<T>` against the immutable host repository root (`SPEC.md` §4.5).
 *
 * Reads the Markdown file at `node.path`, extracts the section beneath `node.heading`, and computes its SHA-256 digest.
 *
 * @template T Resolved section content type.
 *
 * @param {MarkdownSectionSourceNode<T>} node   - Passive Markdown section source AST node.
 * @param {unknown}                      _input - Unused executor input parameter.
 * @param {ResolutionContext}            _ctx   - Active source resolution context.
 *
 * @returns {Promise<ResolvedSourceArtifact<T>>} Extracted section text and SHA-256 hex digest.
 */
export async function executeMarkdownSectionSource<T = string>(
  node: MarkdownSectionSourceNode<T>,
  _input: unknown,
  _ctx: ResolutionContext,
): Promise<ResolvedSourceArtifact<T>> {
  const hostRoot = process.cwd();
  const raw = await readFile(resolve(hostRoot, node.path), 'utf8');
  const sectionText = extractMarkdownHeadingSection(raw, node.heading);
  const digest = createHash('sha256').update(sectionText, 'utf8').digest('hex');
  return Object.freeze<ResolvedSourceArtifact<T>>({
    content: sectionText as T,
    digest,
  });
}
