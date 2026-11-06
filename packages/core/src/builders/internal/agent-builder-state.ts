import type { z } from 'zod';
import type { AgentCapabilitiesNode } from '../../ast/agent-capabilities-node.js';
import type { AgentLessonsMount } from '../../ast/agent-node.js';
import type { SourceValue } from '../../ast/ast-foundation.types.js';
import type { ChildInterruptHandlerNode } from '../../ast/child-interrupt-handler-node.js';
import type {
  CheckASTNode,
  ModelASTNode,
  SourceASTNode,
  ToolASTNode,
} from '../../ast/domain-ast.types.js';
import type { InterruptHandlerNode } from '../../ast/interrupt-handler-node.js';
import type { InterruptNode } from '../../ast/interrupt-node.js';
import type { PolicyNode } from '../../ast/policy-node.js';
import type { PoolNode } from '../../ast/pool-node.js';
import type { PrefixGroupNode } from '../../ast/prefix-group-node.js';
import type { RulesNode } from '../../ast/rules-node.js';
import type { SkillNode } from '../../ast/skill-node.js';
import type { TopologyNode } from '../../ast/topology-node.js';

/**
 * Immutable copy-on-write state snapshot backing `AgentBuilder`.
 *
 * Accumulates prompt prefix bindings, model selection, rules, lessons, skills, tools,
 * policies, schemas, capabilities, and interrupt handlers before `.toAST()` compilation.
 *
 * @template TIn     Validated actor input payload type.
 * @template TOut    Validated actor output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 */
export interface AgentBuilderState<TIn = unknown, TOut = unknown, THandle = unknown> {
  /** Base actor identifier passed to `H.agent(id)`. */
  readonly id: string;
  /** Canonical order-independent role key indexing compiled wire tool schemas. */
  readonly roleKey: string;
  /** Optional shared KV-cache prefix group node. */
  readonly prefixGroup?: PrefixGroupNode;
  /** Bound model or model pool AST node. */
  readonly model?: ModelASTNode | PoolNode<ModelASTNode>;
  /** Optional relational topology AST node. */
  readonly topology?: TopologyNode;
  /** Optional global and scoped rules registry node. */
  readonly rules?: RulesNode;
  /** Optional empirical lessons mount descriptor. */
  readonly lessons?: AgentLessonsMount;
  /** Mounted inline skills and source-backed skill bundles. */
  readonly skills: ReadonlyArray<SkillNode<THandle> | SourceASTNode<readonly SkillNode<THandle>[]>>;
  /** Optional capability and sandbox policy node. */
  readonly policy?: PolicyNode<THandle>;
  /** Base tools mounted directly via `.tools(...)`. */
  readonly baseTools: readonly ToolASTNode<THandle>[];
  /** Additional tools appended via `.withTools(...)` clones. */
  readonly extraTools: readonly ToolASTNode<THandle>[];
  /** Grounding strings and source AST nodes. */
  readonly grounding: readonly SourceValue<string>[];
  /** Role instruction strings and source AST nodes. */
  readonly instructions: readonly SourceValue<string>[];
  /** Optional wall-clock timeout in minutes. */
  readonly timeoutMinutes?: number;
  /** Deterministic `beforeStop` verification checks. */
  readonly beforeStopChecks: readonly CheckASTNode<THandle>[];
  /** Zod schema validating actor input payloads. */
  readonly inputSchema?: z.ZodType<TIn, z.ZodTypeDef, unknown>;
  /** Zod schema validating actor output payloads. */
  readonly outputSchema?: z.ZodType<TOut, z.ZodTypeDef, unknown>;
  /** Optional synchronous partition extractor mapping `TIn` to active partition IDs. */
  readonly extractPartitions?: (input: TIn) => readonly string[];
  /** Voluntary interrupts the actor is permitted to raise. */
  readonly canRaiseInterrupts: readonly InterruptNode<unknown>[];
  /** Optional hierarchical orchestration capabilities container. */
  readonly capabilities?: AgentCapabilitiesNode<TIn, THandle>;
  /** Upward child-interrupt handlers registered on this parent actor. */
  readonly onChildInterruptHandlers: readonly ChildInterruptHandlerNode<unknown>[];
  /** Actor-level default interrupt handlers preserved across clones. */
  readonly onInterruptHandlers: readonly InterruptHandlerNode<TIn, unknown, THandle>[];
}
