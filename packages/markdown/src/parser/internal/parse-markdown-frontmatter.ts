import type { ParsedMarkdownDocument } from '../parsed-markdown-document.js';

/**
 * Parses a single scalar or inline-array YAML value string into its JavaScript representation.
 *
 * Supports quoted strings, booleans, finite numbers, and bracketed inline arrays (`[a, b]`).
 *
 * @param {string} rawValue - Trimmed YAML value token.
 *
 * @returns {unknown} Parsed primitive or frozen array value.
 */
function parseYamlValueToken(rawValue: string): unknown {
  if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
    const inner = rawValue.slice(1, -1).trim();
    if (inner.length === 0) return Object.freeze([]);
    const items: unknown[] = [];
    for (const part of inner.split(',')) {
      items.push(parseYamlValueToken(part.trim()));
    }
    return Object.freeze(items);
  }
  if (
    (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
    (rawValue.startsWith("'") && rawValue.endsWith("'"))
  ) {
    return rawValue.slice(1, -1);
  }
  if (rawValue === 'true') return true;
  if (rawValue === 'false') return false;
  if (rawValue.length > 0 && /^-?\d+(\.\d+)?$/.test(rawValue)) {
    return Number(rawValue);
  }
  return rawValue;
}

/**
 * Parses leading YAML frontmatter and body content from a raw Markdown string.
 *
 * Recognizes `---` fenced blocks at byte 0 supporting scalar keys, inline arrays, and indented `- item` lists.
 *
 * @param {string} rawMarkdown - Raw UTF-8 Markdown document text.
 *
 * @returns {ParsedMarkdownDocument} Frozen `ParsedMarkdownDocument` containing `frontmatter` and `body`.
 */
export function parseMarkdownFrontmatter(rawMarkdown: string): ParsedMarkdownDocument {
  const normalized = rawMarkdown.replace(/\r\n/g, '\n');
  const endMarkerIdx = normalized.startsWith('---\n') ? normalized.indexOf('\n---', 4) : -1;
  if (endMarkerIdx === -1) {
    return Object.freeze<ParsedMarkdownDocument>({ frontmatter: Object.freeze({}), body: normalized.trim() });
  }
  const yamlBlock = normalized.slice(4, endMarkerIdx);
  const afterFence = normalized.slice(endMarkerIdx + 4).replace(/^\n/, '');
  const frontmatter: Record<string, unknown> = {};
  let activeListKey: string | undefined;
  for (const line of yamlBlock.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith('- ') && activeListKey !== undefined) {
      const existing = frontmatter[activeListKey];
      const nextList = Array.isArray(existing) ? [...existing] : [];
      nextList.push(parseYamlValueToken(trimmed.slice(2).trim()));
      frontmatter[activeListKey] = Object.freeze(nextList);
      continue;
    }
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx <= 0) continue;
    const key = trimmed.slice(0, colonIdx).trim();
    const rest = trimmed.slice(colonIdx + 1).trim();
    activeListKey = rest.length === 0 ? key : undefined;
    frontmatter[key] = rest.length === 0 ? Object.freeze([]) : parseYamlValueToken(rest);
  }
  return Object.freeze<ParsedMarkdownDocument>({ frontmatter: Object.freeze(frontmatter), body: afterFence.trim() });
}

/**
 * Extracts the Markdown body text under a specific ATX heading up to the next heading of equal or higher rank.
 *
 * Strips leading YAML frontmatter before scanning headings and throws if `heading` is not present.
 *
 * @param {string} rawMarkdown - Raw UTF-8 Markdown document text.
 * @param {string} heading     - Target heading title (with or without leading `#` characters).
 *
 * @returns {string} Trimmed Markdown content beneath `heading`.
 */
export function extractMarkdownHeadingSection(rawMarkdown: string, heading: string): string {
  const parsed = parseMarkdownFrontmatter(rawMarkdown);
  const normalizedTarget = heading.replace(/^#+\s*/, '').trim();
  const lines = parsed.body.split('\n');
  let capturedDepth = 0;
  const collected: string[] = [];
  for (const line of lines) {
    const match = /^(#{1,6})\s+(.*)$/.exec(line.trim());
    if (match !== null) {
      const hashes = match[1] ?? '#';
      const title = (match[2] ?? '').trim();
      if (capturedDepth > 0 && hashes.length <= capturedDepth) {
        break;
      }
      if (capturedDepth === 0 && title === normalizedTarget) {
        capturedDepth = hashes.length;
        continue;
      }
    }
    if (capturedDepth > 0) {
      collected.push(line);
    }
  }
  if (capturedDepth === 0) {
    throw new Error(`Markdown section '${heading}' was not found in document.`);
  }
  return collected.join('\n').trim();
}
