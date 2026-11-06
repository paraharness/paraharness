import type { InlineSkillNode } from './inline-skill-node.js';
import type { SourcedSkillNode } from './sourced-skill-node.js';

export type { InlineSkillNode } from './inline-skill-node.js';
export type { SourcedSkillNode } from './sourced-skill-node.js';

/**
 * Passive AST node representing an on-demand procedural skill (`H.skill(...)`).
 *
 * @template THandle Runtime handle type of the active isolation scope.
 */
export type SkillNode<THandle = unknown> = InlineSkillNode<THandle> | SourcedSkillNode<THandle>;
