import { frontmatterFromMarkdown } from 'mdast-util-frontmatter';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { toMarkdown } from 'mdast-util-to-markdown';
import { frontmatter } from 'micromark-extension-frontmatter';

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
export function freezeFrontmatterValue(value: unknown): unknown {
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
 * Extracts the plain text title from an `mdast` `heading` node by walking its phrasing children.
 *
 * Concatenates nested text and inline-code values so ATX headings match target strings accurately.
 *
 * @param {unknown} node - `mdast` node to extract text from.
 *
 * @returns {string} Concatenated plain text content of `node`.
 */
export function extractMdastNodeText(node: unknown): string {
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
 * Parses `normalized` Markdown into an `mdast` tree with YAML frontmatter support.
 *
 * @param {string} normalized - LF-normalized Markdown document text.
 *
 * @returns {ReturnType<typeof fromMarkdown>} Parsed `mdast` root node.
 */
export function parseMarkdownAstWithFrontmatter(
  normalized: string,
): ReturnType<typeof fromMarkdown> {
  return fromMarkdown(normalized, {
    extensions: [frontmatter(['yaml'])],
    mdastExtensions: [frontmatterFromMarkdown(['yaml'])],
  });
}

/**
 * Collects top-level `mdast` nodes under `heading` up to the next heading of equal or higher rank.
 *
 * @param {ReturnType<typeof fromMarkdown>['children']} children - Top-level `mdast` children.
 * @param {string}                                      heading  - Target heading title.
 *
 * @returns {ReturnType<typeof fromMarkdown>['children']} Collected section nodes.
 *
 * @throws {Error} If `heading` is not found among top-level `mdast` heading nodes.
 */
export function collectHeadingSectionNodes(
  children: ReturnType<typeof fromMarkdown>['children'],
  heading: string,
): ReturnType<typeof fromMarkdown>['children'] {
  const normalizedTarget = heading.replace(/^#+\s*/, '').trim();
  let targetDepth = 0;
  const sectionNodes: ReturnType<typeof fromMarkdown>['children'] = [];
  for (const child of children) {
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
  return sectionNodes;
}

/**
 * Renders collected `sectionNodes` back to trimmed Markdown text using source offsets or `toMarkdown`.
 *
 * @param {string}                                      normalized   - LF-normalized source Markdown string.
 * @param {ReturnType<typeof fromMarkdown>['children']} sectionNodes - Collected section AST nodes.
 *
 * @returns {string} Trimmed Markdown body of the section.
 */
export function renderMarkdownSectionNodes(
  normalized: string,
  sectionNodes: ReturnType<typeof fromMarkdown>['children'],
): string {
  if (sectionNodes.length === 0) return '';
  const startOffset = sectionNodes[0]?.position?.start.offset;
  const endOffset = sectionNodes[sectionNodes.length - 1]?.position?.end.offset;
  if (startOffset !== undefined && endOffset !== undefined) {
    return normalized.slice(startOffset, endOffset).trim();
  }
  return toMarkdown({ type: 'root', children: sectionNodes }).trim();
}
