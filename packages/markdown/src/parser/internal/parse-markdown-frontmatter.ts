import { toMarkdown } from 'mdast-util-to-markdown';
import { parse as parseYaml } from 'yaml';
import type { ParsedMarkdownDocument } from '../parsed-markdown-document.js';
import {
  collectHeadingSectionNodes,
  freezeFrontmatterValue,
  parseMarkdownAstWithFrontmatter,
  renderMarkdownSectionNodes,
} from './markdown-frontmatter-parsers.js';

/**
 * Parses leading YAML frontmatter and body content from a raw Markdown string via `mdast` and `yaml`.
 *
 * Uses `mdast-util-from-markdown` with `micromark-extension-frontmatter` and `mdast-util-frontmatter`
 * to isolate the leading `yaml` AST node and parses its contents via `yaml.parse`.
 *
 * @param {string} rawMarkdown - Raw UTF-8 Markdown document text.
 *
 * @returns {ParsedMarkdownDocument} Frozen `ParsedMarkdownDocument` containing `frontmatter` and `body`.
 */
export function parseMarkdownFrontmatter(rawMarkdown: string): ParsedMarkdownDocument {
  const normalized = rawMarkdown.replace(/\r\n/g, '\n');
  const tree = parseMarkdownAstWithFrontmatter(normalized);
  const firstNode = tree.children[0];
  if (firstNode === undefined || firstNode.type !== 'yaml') {
    return Object.freeze<ParsedMarkdownDocument>({
      frontmatter: Object.freeze({}),
      body: normalized.trim(),
    });
  }
  const rawParsed: unknown = parseYaml(firstNode.value);
  const frontmatterRecord =
    typeof rawParsed === 'object' && rawParsed !== null && !Array.isArray(rawParsed)
      ? (freezeFrontmatterValue(rawParsed) as Readonly<Record<string, unknown>>)
      : Object.freeze({});
  const endOffset = firstNode.position?.end.offset;
  const body =
    endOffset !== undefined
      ? normalized.slice(endOffset).trim()
      : toMarkdown({ type: 'root', children: tree.children.slice(1) }).trim();
  return Object.freeze<ParsedMarkdownDocument>({ frontmatter: frontmatterRecord, body });
}

/**
 * Extracts the Markdown body text under a specific ATX heading up to the next heading of equal or higher rank.
 *
 * Walks top-level `mdast` `heading` nodes (ignoring `#` lines inside fenced code blocks) and slices
 * the section content up to the next heading with `depth <= targetDepth`.
 *
 * @param {string} rawMarkdown - Raw UTF-8 Markdown document text.
 * @param {string} heading     - Target heading title (with or without leading `#` characters).
 *
 * @returns {string} Trimmed Markdown content beneath `heading`.
 *
 * @throws {Error} If `heading` is not found in `rawMarkdown`.
 */
export function extractMarkdownHeadingSection(rawMarkdown: string, heading: string): string {
  const normalized = rawMarkdown.replace(/\r\n/g, '\n');
  const tree = parseMarkdownAstWithFrontmatter(normalized);
  const sectionNodes = collectHeadingSectionNodes(tree.children, heading);
  return renderMarkdownSectionNodes(normalized, sectionNodes);
}
