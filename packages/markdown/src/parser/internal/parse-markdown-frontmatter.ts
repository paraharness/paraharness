import { frontmatterFromMarkdown } from 'mdast-util-frontmatter';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { toMarkdown } from 'mdast-util-to-markdown';
import { frontmatter } from 'micromark-extension-frontmatter';
import { parse as parseYaml } from 'yaml';
import type { ParsedMarkdownDocument } from '../parsed-markdown-document.js';

/**
 * Recursively freezes arrays and plain object records produced by `yaml.parse`.
 *
 * Ensures that parsed frontmatter metadata on `ParsedMarkdownDocument` cannot be mutated
 * after resolution (`Rule 5.1`).
 *
 * @param {unknown} value - Parsed YAML value to deeply freeze.
 *
 * @returns {unknown} Deeply frozen YAML value.
 */
function freezeFrontmatterValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    for (let idx = 0; idx < value.length; idx += 1) {
      value[idx] = freezeFrontmatterValue(value[idx]);
    }
    return Object.freeze(value);
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      record[key] = freezeFrontmatterValue(record[key]);
    }
    return Object.freeze(record);
  }
  return value;
}

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
  const tree = fromMarkdown(normalized, {
    extensions: [frontmatter(['yaml'])],
    mdastExtensions: [frontmatterFromMarkdown(['yaml'])],
  });
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
 * Extracts the plain text title from an `mdast` `heading` node by walking its phrasing children.
 *
 * Concatenates nested text and inline-code values so ATX headings match target strings accurately.
 *
 * @param {unknown} node - `mdast` node to extract text from.
 *
 * @returns {string} Concatenated plain text content of `node`.
 */
function extractMdastNodeText(node: unknown): string {
  if (typeof node !== 'object' || node === null) return '';
  const record = node as { readonly value?: unknown; readonly children?: readonly unknown[] };
  if (typeof record.value === 'string') return record.value;
  if (!Array.isArray(record.children)) return '';
  let text = '';
  for (const child of record.children) {
    text += extractMdastNodeText(child);
  }
  return text;
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
 */
export function extractMarkdownHeadingSection(rawMarkdown: string, heading: string): string {
  const normalized = rawMarkdown.replace(/\r\n/g, '\n');
  const normalizedTarget = heading.replace(/^#+\s*/, '').trim();
  const tree = fromMarkdown(normalized, {
    extensions: [frontmatter(['yaml'])],
    mdastExtensions: [frontmatterFromMarkdown(['yaml'])],
  });
  let targetDepth = 0;
  const sectionNodes: typeof tree.children = [];
  for (const child of tree.children) {
    if (child.type === 'heading') {
      const title = extractMdastNodeText(child).trim();
      if (targetDepth > 0 && child.depth <= targetDepth) break;
      if (targetDepth === 0 && title === normalizedTarget) {
        targetDepth = child.depth;
        continue;
      }
    }
    if (targetDepth > 0) sectionNodes.push(child);
  }
  if (targetDepth === 0) {
    throw new Error(`Markdown section '${heading}' was not found in document.`);
  }
  if (sectionNodes.length === 0) return '';
  const startOffset = sectionNodes[0]?.position?.start.offset;
  const endOffset = sectionNodes[sectionNodes.length - 1]?.position?.end.offset;
  if (startOffset !== undefined && endOffset !== undefined) {
    return normalized.slice(startOffset, endOffset).trim();
  }
  return toMarkdown({ type: 'root', children: sectionNodes }).trim();
}
