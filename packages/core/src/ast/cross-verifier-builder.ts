import type { z } from 'zod';
import type { AstBuilder } from './ast-builder.js';
import type { CrossVerifierASTNode } from './domain-ast.types.js';

/**
 * Fluent builder contract for cross-candidate verification primitives (`git.patchEquivalence`, `git.publicSurfaceCrossTester`).
 *
 * Exposes `id` and `reportSchema` directly on the builder instance so downstream `.speculate()` arbiter
 * schemas (`H.SpeculationInputSchema(..., crossTester.reportSchema)`) can reference `reportSchema` without calling `.toAST()`.
 *
 * @template THandle      Isolation scope runtime handle type.
 * @template TReceipt     Inspected scope receipt record type.
 * @template TCrossReport Structured cross-verification report type.
 * @template TNode        Concrete `CrossVerifierASTNode` produced by `.toAST()`.
 */
export interface CrossVerifierBuilder<
  THandle = unknown,
  TReceipt extends Record<string, unknown> = Record<string, unknown>,
  TCrossReport = unknown,
  TNode extends CrossVerifierASTNode<THandle, TReceipt, TCrossReport> = CrossVerifierASTNode<
    THandle,
    TReceipt,
    TCrossReport
  >,
> extends AstBuilder<TNode> {
  /** Unique identifier of the cross-verifier primitive. */
  readonly id: string;
  /** Zod schema validating each candidate branch's cross-verification report. */
  readonly reportSchema: z.ZodType<TCrossReport>;
}
