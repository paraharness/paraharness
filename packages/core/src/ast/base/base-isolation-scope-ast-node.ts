import type { z } from 'zod';
import type { BivariantCallback } from '../ast-foundation.types.js';
import type { BaseCheckASTNode } from './base-check-ast-node.js';
import type { ScopeCapabilityTier } from './base-domain-ast.types.js';

/**
 * Domain-agnostic base AST node contract for isolation scopes (`IsolationScopeASTNode`).
 *
 * Carries static capability tier metadata (`capabilityTier`, `supportsCheckpoints`, `supportsBranching`)
 * inspected by `H.flow` at build time without duck-typing runtime driver methods.
 *
 * @template TType    String-literal discriminant of the isolation scope node.
 * @template THandle  Runtime scope handle type acquired by the scope driver.
 * @template TReceipt Validated scope inspection receipt shape.
 * @template TSync    Validated scope synchronization receipt shape.
 * @template TTier    Static capability tier (`'scope' | 'checkpointable' | 'branchable'`).
 */
export interface BaseIsolationScopeASTNode<
  TType extends string = string,
  THandle = unknown,
  TReceipt extends Record<string, unknown> = Record<string, unknown>,
  TSync extends Record<string, unknown> = Record<string, unknown>,
  TTier extends ScopeCapabilityTier = ScopeCapabilityTier,
> {
  /** Unique string-literal discriminant of the isolation scope node. */
  readonly type: TType;
  /** Logical identifier of the isolation scope configuration. */
  readonly id: string;
  /** Declarative capability tier governing allowed flow and actor features. */
  readonly capabilityTier: TTier;
  /** Compile-time boolean brand indicating whether `CheckpointableScope` is supported. */
  readonly supportsCheckpoints: [TTier] extends ['checkpointable' | 'branchable'] ? true : false;
  /** Compile-time boolean brand indicating whether `BranchableScope` is supported. */
  readonly supportsBranching: [TTier] extends ['branchable'] ? true : false;
  /** Zod schema validating scope receipts returned by `inspect()` and `commitChild()`. */
  readonly receiptSchema: z.ZodType<TReceipt, z.ZodTypeDef, unknown>;
  /** Optional Zod schema validating sync receipts returned by `syncChild()` and `syncRoot()`. */
  readonly syncSchema?: z.ZodType<TSync, z.ZodTypeDef, unknown>;
  /** Optional deterministic check enforced after a conflicted merge or rebase. */
  readonly conflictCleanCheck?: BaseCheckASTNode<string, THandle>;
  /** Phantom type brand binding the scope node to its runtime handle type. */
  readonly __handleBrand?: BivariantCallback<[handle: THandle], void>;
}
