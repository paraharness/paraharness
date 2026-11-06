import { z } from 'zod';

/**
 * Builds the discriminated-union Zod schema for a single candidate branch in a speculative tournament (`COMPLETED` or `PARKED_ON_ESCALATION`).
 *
 * Validates either a completed branch carrying its output, scope receipt, and optional cross-verification report,
 * or a branch parked on an upward escalation carrying its interrupt identifier and escalation payload.
 *
 * @template TIn         Branch input Zod schema type.
 * @template TOut        Branch output Zod schema type.
 * @template TReceipt    Scope receipt Zod schema type.
 * @template TCross      Cross-verifier report Zod schema type.
 * @template TEscPayload Optional escalation payload Zod schema type.
 *
 * @param {TIn}         inSchema           - Zod schema for branch input payloads.
 * @param {TOut}        outSchema          - Zod schema for completed branch outputs.
 * @param {TReceipt}    receiptSchema      - Zod schema for inspected isolation scope receipts.
 * @param {TCross}      crossSchema        - Zod schema for cross-verification reports.
 * @param {TEscPayload} [escalationSchema] - Optional Zod schema for parked escalation payloads.
 *
 * @returns {z.ZodTypeAny} Discriminated union schema for a tournament candidate.
 */
export const SpeculationCandidateSchema = <
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
  z.discriminatedUnion('status', [
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
      escalationPayload: escalationSchema ?? z.unknown(),
    }),
  ]);

/**
 * Builds the complete input Zod schema delivered to a `.speculate()` arbiter agent (`candidates`, `failedBranches`, and `humanRulingsHistory`).
 *
 * Combines the array of surviving or parked tournament candidates with deterministic failure summaries
 * and prior human escalation rulings across multi-round tournament continuations.
 *
 * @template TIn         Branch input Zod schema type.
 * @template TOut        Branch output Zod schema type.
 * @template TReceipt    Scope receipt Zod schema type.
 * @template TCross      Cross-verifier report Zod schema type.
 * @template TEscPayload Optional escalation payload Zod schema type.
 *
 * @param {TIn}         inSchema           - Zod schema for branch input payloads.
 * @param {TOut}        outSchema          - Zod schema for completed branch outputs.
 * @param {TReceipt}    receiptSchema      - Zod schema for inspected isolation scope receipts.
 * @param {TCross}      crossSchema        - Zod schema for cross-verification reports.
 * @param {TEscPayload} [escalationSchema] - Optional Zod schema for parked escalation payloads.
 *
 * @returns {z.ZodTypeAny} Complete arbiter input Zod schema.
 */
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
