import type { GlobalRule, MarkdownFrontmatterSourceNode, ScopedRule, SkillNode } from '@metaharness/core';
import type { MdFrontmatterSourceBuilder } from './md-frontmatter-source-builder.js';
import type { MdSectionSourceBuilder } from './md-section-source-builder.js';

/**
 * Public builder namespace contract for `@metaharness/markdown` (`md.*`).
 *
 * Exposes pure, side-effect-free builders compiling Markdown files and globs into passive
 * `MarkdownFrontmatterSourceNode` and `MarkdownSectionSourceNode` AST descriptors.
 */
export interface MdNamespace {
  /**
   * Loads always-on `GlobalRule[]` records from Markdown files matching `glob`.
   *
   * Resolves `glob` against the immutable host repository root and validates each file with `GlobalRuleSchema`.
   *
   * @param {string} glob - Host-root-relative path or glob pattern targeting global rule Markdown files.
   *
   * @returns {MdFrontmatterSourceBuilder<readonly GlobalRule[]>} Frozen global rules source builder.
   */
  globalRules(glob: string): MdFrontmatterSourceBuilder<readonly GlobalRule[]>;

  /**
   * Loads a single `ScopedRule` record from a Markdown file at `path`.
   *
   * Translates YAML frontmatter `globs: string[]` into a passive `FsGlobMatcherNode` (`mode: 'write'`)
   * without importing `@metaharness/fs` and validates the rule with `ScopedRuleSchema`.
   *
   * @param {string} path - Host-root-relative path to the scoped rule Markdown file.
   *
   * @returns {MdFrontmatterSourceBuilder<ScopedRule>} Frozen single scoped rule source builder.
   */
  scopedRule(path: string): MdFrontmatterSourceBuilder<ScopedRule>;

  /**
   * Loads `ScopedRule[]` records from all Markdown files matching `glob`.
   *
   * Translates each file's YAML frontmatter `globs: string[]` into passive `FsGlobMatcherNode` descriptors
   * and validates every rule against `ScopedRuleSchema`.
   *
   * @param {string} glob - Host-root-relative glob pattern targeting scoped rule Markdown files.
   *
   * @returns {MdFrontmatterSourceBuilder<readonly ScopedRule[]>} Frozen scoped rules array source builder.
   */
  scopedRules(glob: string): MdFrontmatterSourceBuilder<readonly ScopedRule[]>;

  /**
   * Loads a single `SkillNode` definition from a Markdown file at `path` for `M.skill(md.skill(path))`.
   *
   * Extracts `id`, `description`, optional `partitions`/`globs` trigger predicates, and Markdown body instructions.
   *
   * @template THandle Runtime handle type of the active isolation scope.
   *
   * @param {string} path - Host-root-relative path to the skill Markdown file.
   *
   * @returns {MdFrontmatterSourceBuilder<SkillNode<THandle>>} Frozen single skill source builder.
   */
  skill<THandle = unknown>(path: string): MdFrontmatterSourceBuilder<SkillNode<THandle>>;

  /**
   * Loads `SkillNode[]` definitions from all Markdown files matching `glob`.
   *
   * Allows mounting procedural skill bundles directly via `M.agent(...).skills(md.skills(glob))`.
   *
   * @template THandle Runtime handle type of the active isolation scope.
   *
   * @param {string} glob - Host-root-relative glob pattern targeting skill Markdown files.
   *
   * @returns {MdFrontmatterSourceBuilder<readonly SkillNode<THandle>[]>} Frozen skill bundle source builder.
   */
  skills<THandle = unknown>(glob: string): MdFrontmatterSourceBuilder<readonly SkillNode<THandle>[]>;

  /**
   * Loads raw or typed YAML frontmatter and Markdown body from `pathOrGlob`.
   *
   * Compiles to a passive `MarkdownFrontmatterSourceNode<T>` with `id: "md:${kind}:${pathOrGlob}"`.
   *
   * @template T Resolved frontmatter payload type.
   *
   * @param {string}                                   pathOrGlob - Host-root-relative file path or glob pattern.
   * @param {MarkdownFrontmatterSourceNode<T>['kind']} [kind]     - Optional loader kind discriminant (`'frontmatter'` default).
   *
   * @returns {MdFrontmatterSourceBuilder<T>} Frozen frontmatter source builder.
   */
  frontmatter<T = unknown>(
    pathOrGlob: string,
    kind?: NonNullable<MarkdownFrontmatterSourceNode<T>['kind']>,
  ): MdFrontmatterSourceBuilder<T>;

  /**
   * Extracts the Markdown section under `heading` from the file at `path`.
   *
   * Compiles to a passive `MarkdownSectionSourceNode<T>` resolved relative to the host repository root.
   *
   * @template T Resolved section content type.
   *
   * @param {string} path    - Host-root-relative path to the Markdown document.
   * @param {string} heading - Target heading title to extract.
   *
   * @returns {MdSectionSourceBuilder<T>} Frozen section source builder.
   */
  section<T = string>(path: string, heading: string): MdSectionSourceBuilder<T>;
}
