import { z } from 'zod';
import type { CheckASTNode, EffectMatcherASTNode } from '../ast/domain-ast.types.js';

/**
 * Zod schema validating a `ScopePredicate` (`when` filter for scoped rules and skills).
 */
export const ScopePredicateSchema = z.object({
  partitions: z.array(z.string()).default([]),
  effects: z.custom<EffectMatcherASTNode>().optional(),
});

/**
 * Validated scope predicate specifying target partitions and optional reactive effect matchers.
 */
export type ScopePredicate = z.infer<typeof ScopePredicateSchema>;

/**
 * Zod schema validating an always-on global rule (`id` and non-empty `directive`).
 */
export const GlobalRuleSchema = z.object({
  id: z.string(),
  directive: z.string().min(1),
});

/**
 * Validated global rule record injected into the static system prompt or Turn-0 context.
 */
export type GlobalRule = z.infer<typeof GlobalRuleSchema>;

/**
 * Zod schema validating a partition- or effect-scoped rule with optional `beforeStop` checks.
 */
export const ScopedRuleSchema = z.object({
  id: z.string(),
  when: ScopePredicateSchema,
  directive: z.string().min(1),
  checks: z.array(z.custom<CheckASTNode>()).default([]),
});

/**
 * Validated scoped rule record injected when its partition or effect predicate matches.
 */
export type ScopedRule = z.infer<typeof ScopedRuleSchema>;
