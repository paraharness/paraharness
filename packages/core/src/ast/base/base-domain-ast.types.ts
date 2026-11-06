import type { BaseDomainStepASTNode } from './base-domain-step-ast-node.js';

/**
 * Capability tier discriminant for isolation scope AST nodes.
 *
 * Determines at AST compilation time whether a scope supports only root lifecycle (`'scope'`),
 * uncommitted state checkpointing and diffing (`'checkpointable'`), or hierarchical child
 * branching and 3-way reconciliation (`'branchable'`).
 */
export type ScopeCapabilityTier = 'scope' | 'checkpointable' | 'branchable';

/**
 * Alias for `BaseDomainStepASTNode` used by external step adapter packages.
 *
 * @template TType   String-literal discriminant of the domain step node.
 * @template TIn     Validated step input payload type.
 * @template TOut    Validated step output payload type.
 * @template THandle Isolation scope handle type required by the step.
 */
export type BaseStepASTNode<
  TType extends string = string,
  TIn = unknown,
  TOut = unknown,
  THandle = unknown,
> = BaseDomainStepASTNode<TType, TIn, TOut, THandle>;
