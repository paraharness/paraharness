/**
 * Parsed representation of a Markdown document with optional YAML frontmatter.
 *
 * Separates key-value metadata extracted from the leading `---` YAML block from the remaining Markdown body.
 */
export interface ParsedMarkdownDocument {
  /** Parsed YAML frontmatter key-value record (empty when no leading frontmatter block exists). */
  readonly frontmatter: Readonly<Record<string, unknown>>;
  /** Trimmed Markdown body text following the closing frontmatter delimiter. */
  readonly body: string;
}
