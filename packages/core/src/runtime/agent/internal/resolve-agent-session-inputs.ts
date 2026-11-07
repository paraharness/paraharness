import type { AgentNode } from '../../../ast/agent-node.js';
import type { SourceASTNode, ToolASTNode } from '../../../ast/domain-ast.types.js';
import type { EscalateCapabilityNode } from '../../../ast/escalate-capability-node.js';
import type { ForkCapabilityNode } from '../../../ast/fork-capability-node.js';
import type { InlineScopedRuleNode } from '../../../ast/inline-scoped-rule-node.js';
import type { InlineSkillNode } from '../../../ast/inline-skill-node.js';
import type { InterruptNode } from '../../../ast/interrupt-node.js';
import type { SourcedScopedRuleNode } from '../../../ast/sourced-scoped-rule-node.js';
import type { SourcedSkillNode } from '../../../ast/sourced-skill-node.js';
import type { SpeculateCapabilityNode } from '../../../ast/speculate-capability-node.js';
import type { StepExecutionContext } from '../../../ports/step-execution-context.js';
import type { ScopedRule } from '../../../schemas/core-rules.schema.js';
import { resolveSourceStringValue } from '../../prefix/internal/collect-prefix-tools.js';

/**
 * Mutable tool and service lookup maps populated by `registerResolvedInlineSkill`.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 */
export interface RegisterResolvedInlineSkillToolMapsParams<THandle = unknown> {
  /** Mutable tool map keyed by `tool.name`. */
  readonly toolsByName: Map<string, ToolASTNode<THandle>>;
  /** Mutable map of unlocked tool/service tool name to owning `skill.id`. */
  readonly skillOwnerByToolName: Map<string, string>;
  /** Mutable map of service tool name to owning `service.id`. */
  readonly serviceByToolName: Map<string, string>;
}

/**
 * Indexes a single resolved `InlineSkillNode` and its unlocked tools and services into the session lookup maps.
 *
 * Maps unlocked tool schemas to `toolsByName` and `skillOwnerByToolName`, and unlocked service tool schemas
 * to `skillOwnerByToolName` and `serviceByToolName` (`SPEC.md` §3.4.2).
 *
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {InlineSkillNode<THandle>}                             skill      - Resolved inline skill node to register.
 * @param {Map<string, InlineSkillNode<THandle>>}                skillsById - Mutable skill map keyed by `skill.id`.
 * @param {RegisterResolvedInlineSkillToolMapsParams<THandle>}   toolMaps   - Mutable tool and service lookup maps.
 */
export function registerResolvedInlineSkill<THandle>(
  skill: InlineSkillNode<THandle>,
  skillsById: Map<string, InlineSkillNode<THandle>>,
  toolMaps: RegisterResolvedInlineSkillToolMapsParams<THandle>,
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
 * Resolves all inline, sourced (`SourcedSkillNode`), and dynamic (`SourceASTNode`) skills, tools, capabilities, and interrupts on `node`.
 *
 * Pre-indexes `toolsByName`, `skillsById`, `skillOwnerByToolName`, `serviceByToolName`, `forksByToolName`,
 * `speculationsByToolName`, `escalationsByInterruptId`, and `canRaiseInterruptsById` once at session start (`Rule 4.2`).
 *
 * @template TIn     Validated agent input payload type.
 * @template TOut    Validated agent output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {AgentNode<TIn, TOut, THandle>} node - Passive `AgentNode` AST definition.
 * @param {StepExecutionContext<THandle>} ctx  - Active step execution context.
 *
 * @returns {Promise<{ readonly toolsByName: ReadonlyMap<string, ToolASTNode<THandle>>; readonly skillsById: ReadonlyMap<string, InlineSkillNode<THandle>>; readonly skillOwnerByToolName: ReadonlyMap<string, string>; readonly serviceByToolName: ReadonlyMap<string, string>; readonly forksByToolName: ReadonlyMap<string, ForkCapabilityNode<TIn, unknown, unknown, unknown, THandle>>; readonly speculationsByToolName: ReadonlyMap<string, SpeculateCapabilityNode<TIn, unknown, unknown, unknown, THandle, unknown, unknown>>; readonly escalationsByInterruptId: ReadonlyMap<string, EscalateCapabilityNode<unknown, unknown>>; readonly canRaiseInterruptsById: ReadonlyMap<string, InterruptNode<unknown>> }>} Pre-indexed skill, tool, and capability lookup maps.
 */
export async function resolveAgentSkillsAndTools<TIn, TOut, THandle>(
  node: AgentNode<TIn, TOut, THandle>,
  ctx: StepExecutionContext<THandle>,
): Promise<{
  readonly toolsByName: ReadonlyMap<string, ToolASTNode<THandle>>;
  readonly skillsById: ReadonlyMap<string, InlineSkillNode<THandle>>;
  readonly skillOwnerByToolName: ReadonlyMap<string, string>;
  readonly serviceByToolName: ReadonlyMap<string, string>;
  readonly forksByToolName: ReadonlyMap<
    string,
    ForkCapabilityNode<TIn, unknown, unknown, unknown, THandle>
  >;
  readonly speculationsByToolName: ReadonlyMap<
    string,
    SpeculateCapabilityNode<TIn, unknown, unknown, unknown, THandle, unknown, unknown>
  >;
  readonly escalationsByInterruptId: ReadonlyMap<string, EscalateCapabilityNode<unknown, unknown>>;
  readonly canRaiseInterruptsById: ReadonlyMap<string, InterruptNode<unknown>>;
}> {
  const toolsByName = new Map<string, ToolASTNode<THandle>>();
  const skillsById = new Map<string, InlineSkillNode<THandle>>();
  const skillOwnerByToolName = new Map<string, string>();
  const serviceByToolName = new Map<string, string>();
  const forksByToolName = new Map<
    string,
    ForkCapabilityNode<TIn, unknown, unknown, unknown, THandle>
  >();
  const speculationsByToolName = new Map<
    string,
    SpeculateCapabilityNode<TIn, unknown, unknown, unknown, THandle, unknown, unknown>
  >();
  const escalationsByInterruptId = new Map<string, EscalateCapabilityNode<unknown, unknown>>();
  const canRaiseInterruptsById = new Map<string, InterruptNode<unknown>>();
  const toolMaps = { toolsByName, skillOwnerByToolName, serviceByToolName };
  for (const tool of node.tools) {
    toolsByName.set(tool.name, tool);
  }
  for (const forkCap of node.capabilities?.forks ?? []) {
    forksByToolName.set(forkCap.toolName, forkCap);
  }
  for (const specCap of node.capabilities?.speculations ?? []) {
    speculationsByToolName.set(specCap.toolName, specCap);
  }
  for (const escCap of node.capabilities?.escalations ?? []) {
    escalationsByInterruptId.set(escCap.interrupt.id, escCap);
  }
  for (const intr of node.canRaiseInterrupts) {
    canRaiseInterruptsById.set(intr.id, intr);
  }
  for (const sEntry of node.skills) {
    const entryType = (sEntry as { readonly type?: string }).type;
    if (
      (entryType === 'harness:skill' || entryType === 'harness:sourced-skill') &&
      (sEntry as { readonly source?: unknown }).source !== undefined
    ) {
      const sourced = sEntry as SourcedSkillNode<THandle>;
      const srcExec = ctx.registry.sources[sourced.source.type];
      if (srcExec === undefined) {
        throw new Error(
          `No SourceExecutor registered for skill source '${sourced.source.type}' on agent '${node.id}'.`,
        );
      }
      const art = await srcExec(sourced.source as never, undefined, ctx);
      const loaded =
        typeof art.content === 'object' && art.content !== null
          ? (art.content as Partial<InlineSkillNode<THandle>>)
          : undefined;
      let instrText = String(art.content);
      if (sourced.instructions !== undefined) {
        instrText = (await resolveSourceStringValue(sourced.instructions, ctx.registry, ctx)).text;
      } else if (typeof loaded?.instructions === 'string') {
        instrText = loaded.instructions;
      }
      registerResolvedInlineSkill(
        Object.freeze<InlineSkillNode<THandle>>({
          type: 'harness:skill',
          id: sourced.id,
          description: sourced.description ?? loaded?.description ?? sourced.id,
          when: sourced.when ?? loaded?.when,
          instructions: instrText,
          unlockedTools: sourced.unlockedTools,
          unlockedServices: sourced.unlockedServices,
          leaseMode: sourced.leaseMode,
        }),
        skillsById,
        toolMaps,
      );
    } else if (entryType === 'harness:skill') {
      registerResolvedInlineSkill(sEntry as InlineSkillNode<THandle>, skillsById, toolMaps);
    } else {
      const sourceNode = sEntry as SourceASTNode<readonly InlineSkillNode<THandle>[]>;
      const sourceExec = ctx.registry.sources[sourceNode.type];
      if (sourceExec === undefined) {
        throw new Error(
          `No SourceExecutor registered for skill source '${sourceNode.type}' on agent '${node.id}'.`,
        );
      }
      const artifact = await sourceExec(sourceNode as never, undefined, ctx);
      for (const loadedSkill of artifact.content as readonly InlineSkillNode<THandle>[]) {
        registerResolvedInlineSkill(loadedSkill, skillsById, toolMaps);
      }
    }
  }
  return {
    toolsByName,
    skillsById,
    skillOwnerByToolName,
    serviceByToolName,
    forksByToolName,
    speculationsByToolName,
    escalationsByInterruptId,
    canRaiseInterruptsById,
  };
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
): Promise<{
  readonly scopedRules: readonly InlineScopedRuleNode[];
  readonly actorGroundingTexts: readonly string[];
  readonly actorInstructionTexts: readonly string[];
}> {
  const scopedRules: InlineScopedRuleNode[] = [];
  for (const rEntry of node.rules?.scopedRules ?? []) {
    const entryObj = rEntry as { readonly type?: string };
    if (
      (entryObj.type === 'harness:scoped-rule' ||
        entryObj.type === 'harness:sourced-scoped-rule') &&
      (rEntry as { readonly source?: unknown }).source !== undefined
    ) {
      const sourced = rEntry as SourcedScopedRuleNode;
      const srcExec = ctx.registry.sources[sourced.source.type];
      if (srcExec === undefined) {
        throw new Error(
          `No SourceExecutor registered for scoped rule source '${sourced.source.type}' on agent '${node.id}'.`,
        );
      }
      const art = await srcExec(sourced.source as never, undefined, ctx);
      const loaded =
        typeof art.content === 'object' && art.content !== null
          ? (art.content as Partial<ScopedRule>)
          : undefined;
      const dirText =
        sourced.directive !== undefined
          ? (await resolveSourceStringValue(sourced.directive, ctx.registry, ctx)).text
          : (loaded?.directive ?? String(art.content));
      scopedRules.push(
        Object.freeze<InlineScopedRuleNode>({
          type: 'harness:scoped-rule',
          id: sourced.id,
          when: sourced.when ?? loaded?.when ?? Object.freeze({ partitions: [] }),
          directive: dirText,
          enforceBeforeStopChecks: sourced.enforceBeforeStopChecks,
        }),
      );
    } else if (entryObj.type === 'harness:scoped-rule') {
      scopedRules.push(rEntry as InlineScopedRuleNode);
    } else if (
      typeof rEntry === 'object' &&
      rEntry !== null &&
      'type' in rEntry &&
      typeof entryObj.type === 'string'
    ) {
      const srcNode = rEntry as SourceASTNode<ScopedRule | readonly ScopedRule[]>;
      const srcExec = ctx.registry.sources[srcNode.type];
      if (srcExec === undefined) {
        throw new Error(
          `No SourceExecutor registered for scoped rule source '${srcNode.type}' on agent '${node.id}'.`,
        );
      }
      const artifact = await srcExec(srcNode as never, undefined, ctx);
      const list = Array.isArray(artifact.content) ? artifact.content : [artifact.content];
      for (const item of list as ReadonlyArray<
        ScopedRule & { readonly partitions?: readonly string[] }
      >) {
        scopedRules.push(
          Object.freeze<InlineScopedRuleNode>({
            type: 'harness:scoped-rule',
            id: item.id,
            when:
              item.when ??
              Object.freeze({ partitions: [...(item.partitions ?? [])] }),
            directive: item.directive,
            enforceBeforeStopChecks: item.checks ?? Object.freeze([]),
          }),
        );
      }
    }
  }
  const actorGroundingTexts: string[] = [];
  for (const gSource of node.grounding) {
    const resolved = await resolveSourceStringValue(gSource, ctx.registry, ctx);
    actorGroundingTexts.push(resolved.text);
  }
  const actorInstructionTexts: string[] = [];
  for (const iSource of node.instructions) {
    const resolved = await resolveSourceStringValue(iSource, ctx.registry, ctx);
    actorInstructionTexts.push(resolved.text);
  }
  return {
    scopedRules: Object.freeze(scopedRules),
    actorGroundingTexts: Object.freeze(actorGroundingTexts),
    actorInstructionTexts: Object.freeze(actorInstructionTexts),
  };
}
