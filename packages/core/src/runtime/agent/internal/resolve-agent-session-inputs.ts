import type { AgentNode } from '../../../ast/agent-node.js';
import type { SourceASTNode, StepASTNode, ToolASTNode } from '../../../ast/domain-ast.types.js';
import type { InlineScopedRuleNode } from '../../../ast/inline-scoped-rule-node.js';
import type { InlineSkillNode } from '../../../ast/inline-skill-node.js';
import type { LoopNode } from '../../../ast/loop-node.js';
import type { SourcedScopedRuleNode } from '../../../ast/sourced-scoped-rule-node.js';
import type { SourcedSkillNode } from '../../../ast/sourced-skill-node.js';
import type { ContinuationFrame } from '../../../ports/continuation-frame.types.js';
import type { LessonOutcome } from '../../../ports/lesson-outcome.types.js';
import type { StepExecutionContext } from '../../../ports/step-execution-context.js';
import type { ScopedRule } from '../../../schemas/core-rules.schema.js';
import type { ChildForkExecutionOutcome } from '../../fork/child-fork-execution-outcome.js';
import { executeLoop } from '../../loop/execute-loop.js';
import { resolveSourceStringValue } from '../../prefix/internal/collect-prefix-tools.js';
import { executeStepNode } from '../../step/execute-step-node.js';
import type { AgentTurnSessionState } from '../agent-turn-session-state.js';
import { executeAgent } from '../execute-agent.js';

/**
 * Indexes a single resolved `InlineSkillNode` and its unlocked tools and services into the session lookup maps.
 *
 * Maps unlocked tool schemas to `toolsByName` and `skillOwnerByToolName`, and unlocked service tool schemas
 * to `skillOwnerByToolName` and `serviceByToolName` (`SPEC.md` §3.4.2).
 *
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {InlineSkillNode<THandle>}              skill      - Resolved inline skill node to register.
 * @param {Map<string, InlineSkillNode<THandle>>} skillsById - Mutable skill map keyed by `skill.id`.
 * @param {object}                                toolMaps   - Mutable tool and service lookup maps.
 */
export function registerResolvedInlineSkill<THandle>(
  skill: InlineSkillNode<THandle>,
  skillsById: Map<string, InlineSkillNode<THandle>>,
  toolMaps: { readonly toolsByName: Map<string, ToolASTNode<THandle>>; readonly skillOwnerByToolName: Map<string, string>; readonly serviceByToolName: Map<string, string> },
): void {
  skillsById.set(skill.id, skill);
  for (const st of skill.unlockedTools) {
    toolMaps.toolsByName.set(st.name, st);
    toolMaps.skillOwnerByToolName.set(st.name, skill.id);
  }
  for (const svc of skill.unlockedServices) {
    for (const schema of svc.toolSchemas) {
      toolMaps.skillOwnerByToolName.set(schema.name, skill.id);
      toolMaps.serviceByToolName.set(schema.name, svc.id);
    }
  }
}

/**
 * Resolves all inline, sourced (`SourcedSkillNode`), and dynamic (`SourceASTNode`) skills and tools on `node`.
 *
 * Pre-indexes `toolsByName`, `skillsById`, `skillOwnerByToolName`, and `serviceByToolName` once at session start (`Rule 4.2`).
 *
 * @template TIn     Validated agent input payload type.
 * @template TOut    Validated agent output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {AgentNode<TIn, TOut, THandle>} node - Passive `AgentNode` AST definition.
 * @param {StepExecutionContext<THandle>} ctx  - Active step execution context.
 *
 * @returns {Promise<{ readonly toolsByName: ReadonlyMap<string, ToolASTNode<THandle>>; readonly skillsById: ReadonlyMap<string, InlineSkillNode<THandle>>; readonly skillOwnerByToolName: ReadonlyMap<string, string>; readonly serviceByToolName: ReadonlyMap<string, string> }>} Pre-indexed skill and tool lookup maps.
 */
export async function resolveAgentSkillsAndTools<TIn, TOut, THandle>(
  node: AgentNode<TIn, TOut, THandle>,
  ctx: StepExecutionContext<THandle>,
): Promise<{ readonly toolsByName: ReadonlyMap<string, ToolASTNode<THandle>>; readonly skillsById: ReadonlyMap<string, InlineSkillNode<THandle>>; readonly skillOwnerByToolName: ReadonlyMap<string, string>; readonly serviceByToolName: ReadonlyMap<string, string> }> {
  const toolsByName = new Map<string, ToolASTNode<THandle>>(), skillsById = new Map<string, InlineSkillNode<THandle>>(), skillOwnerByToolName = new Map<string, string>(), serviceByToolName = new Map<string, string>();
  const toolMaps = { toolsByName, skillOwnerByToolName, serviceByToolName };
  for (const t of node.tools) toolsByName.set(t.name, t);
  for (const sEntry of node.skills) {
    const entryType = (sEntry as { readonly type?: string }).type;
    if ((entryType === 'harness:skill' || entryType === 'harness:sourced-skill') && (sEntry as { readonly source?: unknown }).source !== undefined) {
      const sourced = sEntry as SourcedSkillNode<THandle>;
      const srcExec = ctx.registry.sources[sourced.source.type];
      if (srcExec === undefined) throw new Error(`No SourceExecutor registered for skill source '${sourced.source.type}' on agent '${node.id}'.`);
      const art = await srcExec(sourced.source as never, undefined, ctx);
      const loaded = typeof art.content === 'object' && art.content !== null ? (art.content as Partial<InlineSkillNode<THandle>>) : undefined;
      const instrText = sourced.instructions !== undefined ? (await resolveSourceStringValue(sourced.instructions, ctx.registry, ctx)).text : (typeof loaded?.instructions === 'string' ? loaded.instructions : String(art.content));
      registerResolvedInlineSkill(Object.freeze<InlineSkillNode<THandle>>({ type: 'harness:skill', id: sourced.id, description: sourced.description ?? loaded?.description ?? sourced.id, when: sourced.when ?? loaded?.when, instructions: instrText, unlockedTools: sourced.unlockedTools, unlockedServices: sourced.unlockedServices, leaseMode: sourced.leaseMode }), skillsById, toolMaps);
    } else if (entryType === 'harness:skill') {
      registerResolvedInlineSkill(sEntry as InlineSkillNode<THandle>, skillsById, toolMaps);
    } else {
      const sourceNode = sEntry as SourceASTNode<readonly InlineSkillNode<THandle>[]>;
      const sourceExec = ctx.registry.sources[sourceNode.type];
      if (sourceExec === undefined) throw new Error(`No SourceExecutor registered for skill source '${sourceNode.type}' on agent '${node.id}'.`);
      const artifact = await sourceExec(sourceNode as never, undefined, ctx);
      for (const loadedSkill of artifact.content as readonly InlineSkillNode<THandle>[]) registerResolvedInlineSkill(loadedSkill, skillsById, toolMaps);
    }
  }
  return { toolsByName, skillsById, skillOwnerByToolName, serviceByToolName };
}

/**
 * Resolves all scoped rules (`InlineScopedRuleNode`, `SourcedScopedRuleNode`, and `SourceASTNode`), actor `.grounding()`, and `.instructions()`.
 *
 * Evaluates external `SourceASTNode` descriptors via `ctx.registry.sources` so Turn-0 `[ROLE_AND_SCOPE_CONTEXT]`
 * and reactive `when.effects` rule checks receive hydrated text (`SPEC.md` §3.2.1 & §3.4.1).
 *
 * @template TIn     Validated agent input payload type.
 * @template TOut    Validated agent output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {AgentNode<TIn, TOut, THandle>} node - Passive `AgentNode` AST definition.
 * @param {StepExecutionContext<THandle>} ctx  - Active step execution context.
 *
 * @returns {Promise<{ readonly scopedRules: readonly InlineScopedRuleNode[]; readonly actorGroundingTexts: readonly string[]; readonly actorInstructionTexts: readonly string[] }>} Resolved scoped rules, grounding texts, and instruction texts.
 */
export async function resolveAgentScopedRulesAndDirectives<TIn, TOut, THandle>(
  node: AgentNode<TIn, TOut, THandle>,
  ctx: StepExecutionContext<THandle>,
): Promise<{ readonly scopedRules: readonly InlineScopedRuleNode[]; readonly actorGroundingTexts: readonly string[]; readonly actorInstructionTexts: readonly string[] }> {
  const scopedRules: InlineScopedRuleNode[] = [];
  for (const rEntry of node.rules?.scopedRules ?? []) {
    const entryObj = rEntry as { readonly type?: string };
    if ((entryObj.type === 'harness:scoped-rule' || entryObj.type === 'harness:sourced-scoped-rule') && (rEntry as { readonly source?: unknown }).source !== undefined) {
      const sourced = rEntry as SourcedScopedRuleNode;
      const srcExec = ctx.registry.sources[sourced.source.type];
      if (srcExec === undefined) throw new Error(`No SourceExecutor registered for scoped rule source '${sourced.source.type}' on agent '${node.id}'.`);
      const art = await srcExec(sourced.source as never, undefined, ctx);
      const loaded = typeof art.content === 'object' && art.content !== null ? (art.content as Partial<ScopedRule>) : undefined;
      const dirText = sourced.directive !== undefined ? (await resolveSourceStringValue(sourced.directive, ctx.registry, ctx)).text : (loaded?.directive ?? String(art.content));
      scopedRules.push(Object.freeze<InlineScopedRuleNode>({ type: 'harness:scoped-rule', id: sourced.id, when: sourced.when ?? loaded?.when ?? Object.freeze({ partitions: [] }), directive: dirText, enforceBeforeStopChecks: sourced.enforceBeforeStopChecks }));
    } else if (entryObj.type === 'harness:scoped-rule') {
      scopedRules.push(rEntry as InlineScopedRuleNode);
    } else if (typeof rEntry === 'object' && rEntry !== null && 'type' in rEntry && typeof entryObj.type === 'string') {
      const srcNode = rEntry as SourceASTNode<ScopedRule | readonly ScopedRule[]>;
      const srcExec = ctx.registry.sources[srcNode.type];
      if (srcExec === undefined) throw new Error(`No SourceExecutor registered for scoped rule source '${srcNode.type}' on agent '${node.id}'.`);
      const artifact = await srcExec(srcNode as never, undefined, ctx);
      const list = Array.isArray(artifact.content) ? artifact.content : [artifact.content];
      for (const item of list as ReadonlyArray<ScopedRule & { readonly partitions?: readonly string[] }>) {
        scopedRules.push(Object.freeze<InlineScopedRuleNode>({ type: 'harness:scoped-rule', id: item.id, when: item.when ?? Object.freeze({ partitions: [...(item.partitions ?? [])] }), directive: item.directive, enforceBeforeStopChecks: item.checks ?? Object.freeze([]) }));
      }
    }
  }
  const actorGroundingTexts: string[] = [];
  for (const gSource of node.grounding) actorGroundingTexts.push((await resolveSourceStringValue(gSource, ctx.registry, ctx)).text);
  const actorInstructionTexts: string[] = [];
  for (const iSource of node.instructions) actorInstructionTexts.push((await resolveSourceStringValue(iSource, ctx.registry, ctx)).text);
  return { scopedRules: Object.freeze(scopedRules), actorGroundingTexts: Object.freeze(actorGroundingTexts), actorInstructionTexts: Object.freeze(actorInstructionTexts) };
}

/**
 * Default child step runner dispatching `AgentNode`, `LoopNode`, or domain `StepASTNode` instances and capturing upward interrupts (`SPEC.md` §3.7.2).
 *
 * Propagates shared stores, managers, and continuation stacks between parent and child executions.
 *
 * @template TIn     Parent agent input payload type.
 * @template TOut    Parent agent output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {StepASTNode<unknown, unknown, THandle>}    childNode - Child step AST node to execute.
 * @param {unknown}                                   childIn   - Child step input payload.
 * @param {StepExecutionContext<THandle>}             childCtx  - Child step execution context.
 * @param {AgentTurnSessionState<TIn, TOut, THandle>} parent    - Enclosing parent agent session state.
 *
 * @returns {Promise<ChildForkExecutionOutcome<unknown>>} Completed child output or upward interrupt outcome.
 */
export async function executeDefaultChildStep<TIn, TOut, THandle>(
  childNode: StepASTNode<unknown, unknown, THandle>,
  childIn: unknown,
  childCtx: StepExecutionContext<THandle>,
  parent: AgentTurnSessionState<TIn, TOut, THandle>,
): Promise<ChildForkExecutionOutcome<unknown>> {
  const existingRuntime = (childCtx as StepExecutionContext<THandle> & { readonly _runtime?: Record<string, unknown> })._runtime ?? {};
  const childOutcomeSink: { continuationStack?: readonly ContinuationFrame[]; leafMessageId?: string | null; accumulatedLessonOutcomes?: Readonly<Record<string, LessonOutcome>>; raisedByPhase?: 'act' | 'evaluate'; suspendedAtCallId?: string } = {};
  const enrichedCtx = Object.freeze({ ...childCtx, _runtime: { ledgerStore: parent.ledgerStore, topologyStore: parent.topologyStore, lessonStore: parent.lessonStore, lockManager: parent.lockManager, continuationQueue: parent.continuationQueue, poolManager: parent.poolManager, serviceRegistry: parent.serviceRegistry, humanAdaptersById: parent.humanAdaptersById, ...existingRuntime, childOutcomeSink } });
  try {
    const nodeType = (childNode as { readonly type: string }).type;
    const output = nodeType === 'harness:agent' ? await executeAgent(childNode as AgentNode<unknown, unknown, THandle>, childIn, enrichedCtx) : nodeType === 'harness:loop' ? await executeLoop(childNode as LoopNode<unknown, unknown, THandle>, childIn, enrichedCtx) : await executeStepNode(childNode, childIn, enrichedCtx);
    return Object.freeze<ChildForkExecutionOutcome<unknown>>({ status: 'completed', output, leafMessageId: childOutcomeSink.leafMessageId, accumulatedLessonOutcomes: childOutcomeSink.accumulatedLessonOutcomes, continuationStack: childOutcomeSink.continuationStack ?? Object.freeze([]) });
  } catch (err) {
    const intrErr = err as { readonly interruptResolution?: { readonly interruptId: string; readonly payload: unknown }; readonly raisedByPhase?: 'act' | 'evaluate'; readonly suspendedAtCallId?: string };
    if (intrErr.interruptResolution !== undefined) {
      return Object.freeze<ChildForkExecutionOutcome<unknown>>({ status: 'interrupt-raised', interruptId: intrErr.interruptResolution.interruptId, interruptPayload: intrErr.interruptResolution.payload, raisedByPhase: intrErr.raisedByPhase ?? childOutcomeSink.raisedByPhase ?? 'act', suspendedAtCallId: intrErr.suspendedAtCallId ?? childOutcomeSink.suspendedAtCallId, leafMessageId: childOutcomeSink.leafMessageId, accumulatedLessonOutcomes: childOutcomeSink.accumulatedLessonOutcomes, continuationStack: childOutcomeSink.continuationStack ?? Object.freeze([]) });
    }
    throw err;
  }
}
