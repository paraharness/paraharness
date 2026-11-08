import { createMdFrontmatterBuilder } from './create-md-frontmatter-builder.js';
import { createMdGlobalRulesBuilder } from './create-md-global-rules-builder.js';
import { createMdScopedRuleBuilder } from './create-md-scoped-rule-builder.js';
import { createMdScopedRulesBuilder } from './create-md-scoped-rules-builder.js';
import { createMdSectionBuilder } from './create-md-section-builder.js';
import { createMdSkillBuilder } from './create-md-skill-builder.js';
import { createMdSkillsBuilder } from './create-md-skills-builder.js';
import type { MdNamespace } from './md-namespace-contract.js';

/**
 * Frozen `@metaharness/markdown` builder namespace (`md.*`).
 *
 * Provides pure AST builders for Markdown rules, skills, YAML frontmatter, and heading sections.
 */
export const md: MdNamespace = Object.freeze<MdNamespace>({
  globalRules: createMdGlobalRulesBuilder,
  scopedRule: createMdScopedRuleBuilder,
  scopedRules: createMdScopedRulesBuilder,
  skill: createMdSkillBuilder,
  skills: createMdSkillsBuilder,
  frontmatter: createMdFrontmatterBuilder,
  section: createMdSectionBuilder,
});
