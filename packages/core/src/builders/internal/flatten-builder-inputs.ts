import type { AgentNode } from '../../ast/agent-node.js';
import type { MaybeBuilder, MaybeSource, SourceValue } from '../../ast/ast-foundation.types.js';
import type { ASTNode } from '../../ast/ast-node.js';
import { extractAST } from '../../ast/extract-ast.js';
import type { AgentBuilderState } from './agent-builder-state.js';
import { deepFreeze } from './deep-freeze.js';
import { validatePrefixGroupCloneTranscriptMode } from './validate-agent-and-human-capabilities.js';

/**
 * Type guard narrowing a single value or readonly array union to a `ReadonlyArray`.
 *
 * Used when flattening variadic builder arguments that accept either individual items or arrays.
 *
 * @template T Element type.
 *
 * @param {T | ReadonlyArray<T>} value - Candidate value or readonly array.
 *
 * @returns {value is ReadonlyArray<T>} True when `value` is an array.
 */
function isReadonlyArray<T>(value: T | ReadonlyArray<T>): value is ReadonlyArray<T> {
  return Array.isArray(value);
}

/**
 * Flattens and extracts AST nodes from variadic `MaybeBuilder<T>` or `ReadonlyArray<MaybeBuilder<T>>` arguments.
 *
 * Preserves declaration order across single nodes, builders, and nested array bundles.
 *
 * @template TNode Target AST node type.
 *
 * @param {ReadonlyArray<MaybeBuilder<TNode> | ReadonlyArray<MaybeBuilder<TNode>>>} items - Variadic items or arrays.
 *
 * @returns {TNode[]} Flattened array of extracted AST nodes.
 */
export function flattenExtractedNodes<TNode extends ASTNode>(
  items: ReadonlyArray<MaybeBuilder<TNode> | ReadonlyArray<MaybeBuilder<TNode>>>,
): TNode[] {
  const result: TNode[] = [];
  for (const entry of items) {
    if (isReadonlyArray(entry)) {
      for (const nested of entry) result.push(extractAST<TNode>(nested));
    } else result.push(extractAST<TNode>(entry));
  }
  return result;
}

/**
 * Flattens and normalizes variadic `MaybeSource<string>` or `ReadonlyArray<MaybeSource<string>>` arguments.
 *
 * Leaves inline strings unchanged and unwraps `SourceASTNode<string>` builders via `extractAST`.
 *
 * @param {ReadonlyArray<MaybeSource<string> | ReadonlyArray<MaybeSource<string>>>} items - Variadic source strings or AST nodes.
 *
 * @returns {SourceValue<string>[]} Flattened array of `SourceValue<string>` entries.
 */
export function flattenSourceStrings(
  items: ReadonlyArray<MaybeSource<string> | ReadonlyArray<MaybeSource<string>>>,
): SourceValue<string>[] {
  const result: SourceValue<string>[] = [];
  for (const entry of items) {
    if (isReadonlyArray(entry)) {
      for (const nested of entry) {
        result.push(typeof nested === 'string' ? nested : extractAST(nested));
      }
    } else {
      result.push(typeof entry === 'string' ? entry : extractAST(entry));
    }
  }
  return result;
}

/**
 * Validates and compiles an `AgentBuilderState` into a deeply frozen `AgentNode`.
 *
 * Verifies required `.model(...)`, `.input(...)`, and `.output(...)` bindings and checks
 * `clone-transcript` prefix group compatibility before returning the frozen node.
 *
 * @template TIn     Validated actor input payload type.
 * @template TOut    Validated actor output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {AgentBuilderState<TIn, TOut, THandle>} state - Current agent builder state.
 *
 * @returns {AgentNode<TIn, TOut, THandle>} Deeply frozen `AgentNode`.
 *
 * @throws {Error} If required model, inputSchema, or outputSchema configuration is missing.
 */
export function compileAgentStateToNode<TIn, TOut, THandle>(
  state: AgentBuilderState<TIn, TOut, THandle>,
): AgentNode<TIn, TOut, THandle> {
  const missing: string[] = [];
  if (state.model === undefined) missing.push('.model(...)');
  if (state.inputSchema === undefined) missing.push('.input(schema)');
  if (state.outputSchema === undefined) missing.push('.output(schema)');
  if (
    missing.length > 0 ||
    state.model === undefined ||
    state.inputSchema === undefined ||
    state.outputSchema === undefined
  ) {
    throw new Error(
      `Agent '${state.id}' is missing required ${missing.join(', ')} configuration before .toAST().`,
    );
  }
  const node = deepFreeze<AgentNode<TIn, TOut, THandle>>({
    type: 'harness:agent',
    id: state.id,
    roleKey: state.roleKey,
    prefixGroup: state.prefixGroup,
    model: state.model,
    topology: state.topology,
    rules: state.rules,
    lessons: state.lessons,
    skills: state.skills,
    policy: state.policy,
    tools: [...state.baseTools, ...state.extraTools],
    grounding: state.grounding,
    instructions: state.instructions,
    timeoutMinutes: state.timeoutMinutes,
    beforeStopChecks: state.beforeStopChecks,
    inputSchema: state.inputSchema,
    outputSchema: state.outputSchema,
    extractPartitions: state.extractPartitions,
    canRaiseInterrupts: state.canRaiseInterrupts,
    capabilities: state.capabilities,
    onChildInterruptHandlers: state.onChildInterruptHandlers,
    onInterruptHandlers: state.onInterruptHandlers,
  });
  validatePrefixGroupCloneTranscriptMode(node);
  return node;
}
