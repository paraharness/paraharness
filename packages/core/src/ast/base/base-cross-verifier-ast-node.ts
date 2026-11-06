import type { z } from 'zod';

/**
 * Domain-agnostic base AST node contract for speculative cross-verifiers (`CrossVerifierASTNode`).
 *
 * Compares or cross-tests surviving candidate branches during the `CROSS_VERIFYING` phase of
 * `.speculate()` tournaments before invoking `.arbiter()`.
 *
 * @template TType        String-literal discriminant of the cross-verifier node.
 * @template THandle      Isolation scope handle type of candidate branches.
 * @template TReceipt     Scope receipt type produced by candidate branches.
 * @template TCrossReport Validated cross-verification report type per branch.
 */
export interface BaseCrossVerifierASTNode<
  TType extends string = string,
  THandle = unknown,
  TReceipt extends Record<string, unknown> = Record<string, unknown>,
  TCrossReport = unknown,
> {
  /** Unique string-literal discriminant of the cross-verifier node. */
  readonly type: TType;
  /** Logical identifier of the cross-verifier. */
  readonly id: string;
  /** Zod schema validating the cross-verification report attached to each candidate. */
  readonly reportSchema: z.ZodType<TCrossReport, z.ZodTypeDef, unknown>;
  /** Phantom type brand binding the verifier to its compatible scope handle type. */
  readonly __handleBrand?: THandle;
  /** Phantom type brand binding the verifier to its compatible scope receipt type. */
  readonly __receiptBrand?: TReceipt;
}
