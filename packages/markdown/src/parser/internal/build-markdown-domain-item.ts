import { basename, extname } from 'node:path';
import {
  GlobalRuleSchema,
  type InlineSkillNode,
  ScopedRuleSchema,
} from '@harness-dsl/core';
import type { ParsedMarkdownDocument } from '../parsed-markdown-document.js';
import { buildScopePredicateFromFrontmatter } from './build-scope-predicate-from-frontmatter.js';

/**
 * Parameters for {@link buildMarkdownDomainItem}.
 */
export interface BuildMarkdownDomainItemParams {
  /** Loader kind discriminant (`'global-rules'`, `'scoped-rule'`, etc.). */
  readonly kind: string;

  /** Host-root-relative POSIX file path. */
  readonly relPath: string;

  /** Parsed frontmatter and Markdown body. */
  readonly parsed: ParsedMarkdownDocument;
}

/**
 * Converts a single `ParsedMarkdownDocument` into a validated rule, skill, or frontmatter record.
 *
 * Dispatches on `params.kind` to validate `GlobalRuleSchema`, `ScopedRuleSchema`, `InlineSkillNode`, or raw metadata.
 *
 * @param {BuildMarkdownDomainItemParams} params - Loader kind, relative file path, and parsed Markdown document.
 *
 * @returns {unknown} Validated domain rule, skill node, or frontmatter record.
 */
export function buildMarkdownDomainItem(params: BuildMarkdownDomainItemParams): unknown {
  const { kind, relPath, parsed } = params;
  const fallbackId = basename(relPath, extname(relPath));
  const id = typeof parsed.frontmatter['id'] === 'string' ? parsed.frontmatter['id'] : fallbackId;
  const rawDirective = parsed.frontmatter['directive'];
  let directiveText = '';
  if (parsed.body.length > 0) {
    directiveText = parsed.body;
  } else if (typeof rawDirective === 'string') {
    directiveText = rawDirective;
  }
  const when = buildScopePredicateFromFrontmatter(parsed.frontmatter);
  if (kind === 'global-rules') {
    return Object.freeze(GlobalRuleSchema.parse({ id, directive: directiveText }));
  }
  if (kind === 'scoped-rule' || kind === 'scoped-rules') {
    return Object.freeze(
      ScopedRuleSchema.parse({ id, when, directive: directiveText, checks: [] }),
    );
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
  return Object.freeze({
    ...parsed.frontmatter,
    id,
    when,
    directive: directiveText,
    frontmatter: parsed.frontmatter,
    body: parsed.body,
  });
}
