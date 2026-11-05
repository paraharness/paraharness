import { z } from 'zod';
import type { Check, EffectMatcher, MaybeSource, Service, ToolDefinition } from './ports.js';

export const ScopePredicateSchema = z.object({
  partitions: z.array(z.string()).default([]),
  effects: z.custom<EffectMatcher>().optional(),
});
export type ScopePredicate = z.infer<typeof ScopePredicateSchema>;

export const GlobalRuleSchema = z.object({
  id: z.string(),
  directive: z.string().min(1),
});
export type GlobalRule = z.infer<typeof GlobalRuleSchema>;

export const ScopedRuleSchema = z.object({
  id: z.string(),
  when: ScopePredicateSchema,
  directive: z.string().min(1),
  checks: z.array(z.custom<Check>()).default([]),
});
export type ScopedRule = z.infer<typeof ScopedRuleSchema>;

export const SkillDefinitionSchema = z.object({
  id: z.string(),
  description: z.string(),
  when: ScopePredicateSchema.optional(),
  instructions: z.custom<MaybeSource<string>>(),
  tools: z.array(z.custom<ToolDefinition>()).default([]),
  services: z.array(z.custom<Service>()).default([]),
  lease: z.literal('until-completed-or-fork-exit').default('until-completed-or-fork-exit'),
});
export type SkillDefinition = z.infer<typeof SkillDefinitionSchema>;

export function SpeculationCandidateSchema<
  TIn extends z.ZodTypeAny,
  TOut extends z.ZodTypeAny,
  TReceipt extends z.ZodTypeAny,
  TCross extends z.ZodTypeAny,
  TEscPayload extends z.ZodTypeAny = z.ZodTypeAny,
>(
  inSchema: TIn,
  outSchema: TOut,
  receiptSchema: TReceipt,
  crossSchema: TCross,
  escalationSchema?: TEscPayload,
): z.ZodDiscriminatedUnion<
  'status',
  [
    z.ZodObject<{
      status: z.ZodLiteral<'COMPLETED'>;
      branchIndex: z.ZodNumber;
      input: TIn;
      output: TOut;
      scopeReceipt: TReceipt;
      crossVerifyReport: z.ZodOptional<TCross>;
    }>,
    z.ZodObject<{
      status: z.ZodLiteral<'PARKED_ON_ESCALATION'>;
      branchIndex: z.ZodNumber;
      input: TIn;
      scopeReceipt: TReceipt;
      interruptId: z.ZodString;
      escalationPayload: TEscPayload;
    }>,
  ]
>;
export function SpeculationCandidateSchema(
  inSchema: z.ZodTypeAny,
  outSchema: z.ZodTypeAny,
  receiptSchema: z.ZodTypeAny,
  crossSchema: z.ZodTypeAny,
  escalationSchema: z.ZodTypeAny = z.unknown(),
) {
  return z.discriminatedUnion('status', [
    z.object({
      status: z.literal('COMPLETED'),
      branchIndex: z.number(),
      input: inSchema,
      output: outSchema,
      scopeReceipt: receiptSchema,
      crossVerifyReport: crossSchema.optional(),
    }),
    z.object({
      status: z.literal('PARKED_ON_ESCALATION'),
      branchIndex: z.number(),
      input: inSchema,
      scopeReceipt: receiptSchema,
      interruptId: z.string(),
      escalationPayload: escalationSchema,
    }),
  ]);
}

export const SpeculationInputSchema = <
  TIn extends z.ZodTypeAny,
  TOut extends z.ZodTypeAny,
  TReceipt extends z.ZodTypeAny,
  TCross extends z.ZodTypeAny,
  TEscPayload extends z.ZodTypeAny = z.ZodTypeAny,
>(
  inSchema: TIn,
  outSchema: TOut,
  receiptSchema: TReceipt,
  crossSchema: TCross,
  escalationSchema?: TEscPayload,
) =>
  z.object({
    candidates: z.array(
      SpeculationCandidateSchema(inSchema, outSchema, receiptSchema, crossSchema, escalationSchema),
    ),
    failedBranches: z
      .array(
        z.object({
          branchIndex: z.number(),
          errorSummary: z.string(),
        }),
      )
      .default([]),
    humanRulingsHistory: z
      .array(
        z.object({
          branchIndex: z.number(),
          interruptId: z.string(),
          rulingSummary: z.string(),
        }),
      )
      .default([]),
  });

export const ResumeForkInputSchema = z.object({
  suspendedForkIds: z.array(z.string()).min(1),
  action: z.enum(['resume', 'abort']).default('resume'),
  resolutionSummary: z.string(),
});
export type ResumeForkInput = z.infer<typeof ResumeForkInputSchema>;

export const BudgetApprovalSchema = z.object({
  approved: z.boolean(),
  increaseLimitToUsd: z.number().optional(),
});
export type BudgetApproval = z.infer<typeof BudgetApprovalSchema>;

export const DistilledLessonCandidateSchema = z.object({
  admit: z.boolean(),
  partition: z.string().optional(),
  directive: z.string().optional(),
});
