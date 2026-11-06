import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AgentNode } from '../../../ast/agent-node.js';
import type { SourceValue } from '../../../ast/ast-foundation.types.js';
import type { SourceASTNode } from '../../../ast/domain-ast.types.js';
import type { InlineSkillNode } from '../../../ast/inline-skill-node.js';
import type { RulesNode } from '../../../ast/rules-node.js';
import type { SkillNode } from '../../../ast/skill-node.types.js';
import type {
  GroundingSnapshotRecord,
  WireToolSchema,
} from '../../../ports/compiled-wire-prefix.js';
import type { ResolutionContext } from '../../../ports/resolution-context.js';
import type { RuntimeExecutorRegistry } from '../../../ports/runtime-executor-registry.js';
import { ResumeForkInputSchema } from '../../../schemas/budget-and-lesson.schema.js';
import type { GlobalRule } from '../../../schemas/core-rules.schema.js';
import { zodToJsonSchema } from '../../../schemas/zod-to-json-schema.js';

/**
 * Resolves a literal string or `SourceASTNode<string>` into a `GroundingSnapshotRecord`.
 *
 * Computes a SHA-256 hex digest for inline strings and delegates `SourceASTNode` descriptors
 * to `registry.sources[node.type]`.
 *
 * @param {SourceValue<string>}     source   - Inline string or source AST node to resolve.
 * @param {RuntimeExecutorRegistry} registry - Runtime executor registry containing source loaders.
 * @param {ResolutionContext}       ctx      - Resolution context for the active run.
 *
 * @returns {Promise<GroundingSnapshotRecord>} Resolved text and SHA-256 digest snapshot.
 */
export async function resolveSourceStringValue(
  source: SourceValue<string>,
  registry: RuntimeExecutorRegistry,
  ctx: ResolutionContext,
): Promise<GroundingSnapshotRecord> {
  if (typeof source === 'string') {
    const digest = createHash('sha256').update(source, 'utf8').digest('hex');
    return Object.freeze<GroundingSnapshotRecord>({ sourceId: 'inline', text: source, digest });
  }
  const sourceExec = registry.sources[source.type];
  if (sourceExec === undefined) throw new Error(`No SourceExecutor registered for '${source.type}' in run '${ctx.runId}'.`);
  const artifact = await sourceExec(source as never, undefined, ctx);
  const obj: object = source;
  const sourceId = 'id' in obj && typeof obj.id === 'string' ? obj.id : ('path' in obj && typeof obj.path === 'string' ? obj.path : source.type);
  return Object.freeze<GroundingSnapshotRecord>({ sourceId, text: String(artifact.content), digest: artifact.digest });
}

/**
 * Resolves all `globalRules` on a `RulesNode` in declaration order into formatted directive lines.
 *
 * Supports both inline `GlobalRule` objects/arrays and `SourceASTNode` loaders returning global rules.
 *
 * @param {RulesNode | undefined}   rulesNode - Optional rules registry node.
 * @param {RuntimeExecutorRegistry} registry  - Runtime executor registry containing source loaders.
 * @param {ResolutionContext}       ctx       - Resolution context for the active run.
 *
 * @returns {Promise<readonly string[]>} Formatted `[ruleId] directive` strings in declaration order.
 */
export async function resolveGlobalRuleDirectives(
  rulesNode: RulesNode | undefined,
  registry: RuntimeExecutorRegistry,
  ctx: ResolutionContext,
): Promise<readonly string[]> {
  if (rulesNode === undefined) return Object.freeze([]);
  const lines: string[] = [];
  for (const entry of rulesNode.globalRules) {
    let loaded: GlobalRule | readonly GlobalRule[];
    if (typeof entry === 'object' && entry !== null && 'type' in entry && typeof entry.type === 'string') {
      const sourceNode = entry as SourceASTNode<GlobalRule | readonly GlobalRule[]>;
      const sourceExec = registry.sources[sourceNode.type];
      if (sourceExec === undefined) throw new Error(`No SourceExecutor registered for global rule source '${sourceNode.type}'.`);
      const artifact = await sourceExec(sourceNode as never, undefined, ctx);
      loaded = artifact.content as GlobalRule | readonly GlobalRule[];
    } else loaded = entry as GlobalRule | readonly GlobalRule[];
    const ruleList = Array.isArray(loaded) ? loaded : [loaded];
    for (const rule of ruleList as readonly GlobalRule[]) lines.push(`[Rule: ${rule.id}] ${rule.directive}`);
  }
  return Object.freeze(lines);
}

/**
 * Compiles the role-scoped `WireToolSchema[]` array for a single `AgentNode`.
 *
 * Includes direct `.tools()`, built-in `activateSkill`/`completeSkill` and skill-unlocked tools/services
 * (suffixed with `[Requires active skill: <id>]`), voluntary `.canRaise()` interrupts, `.capabilities()` tools,
 * and `resumeFork` when `.onChildInterrupt()` is declared.
 *
 * @param {AgentNode<unknown, unknown, unknown>} actor         - Target agent AST node.
 * @param {readonly InlineSkillNode<unknown>[]}  [extraSkills] - Optional pre-resolved source skills.
 *
 * @returns {readonly WireToolSchema[]} Frozen array of JSON-serializable wire tool schemas.
 */
export function collectRoleScopedWireTools(
  actor: AgentNode<unknown, unknown, unknown>,
  extraSkills: readonly InlineSkillNode<unknown>[] = [],
): readonly WireToolSchema[] {
  const schemas: WireToolSchema[] = [], seen = new Set<string>();
  const push = (name: string, desc: string, schema: z.ZodTypeAny): void => {
    if (seen.has(name)) return;
    seen.add(name);
    schemas.push(Object.freeze<WireToolSchema>({ name, description: desc, inputJsonSchema: zodToJsonSchema(schema) }));
  };
  for (const tool of actor.tools) push(tool.name, tool.description, tool.inputSchema);
  const inlineSkills: SkillNode<unknown>[] = [...extraSkills];
  for (const s of actor.skills) if (s.type === 'harness:skill') inlineSkills.push(s);
  if (inlineSkills.length > 0 || actor.skills.length > 0) {
    const skillSchema = z.object({ skillId: z.string() });
    push('activateSkill', 'Activate a mounted procedural skill and unlock its tools and services.', skillSchema);
    push('completeSkill', 'Complete and unmount an active skill, stopping its services.', skillSchema);
    for (const skill of inlineSkills) {
      for (const tool of skill.unlockedTools) push(tool.name, `${tool.description} [Requires active skill: ${skill.id}]`, tool.inputSchema);
      for (const svc of skill.unlockedServices) for (const t of svc.toolSchemas) push(t.name, `${t.description} [Requires active skill: ${skill.id}]`, t.inputSchema);
    }
  }
  for (const intr of actor.canRaiseInterrupts) push(intr.id, `Raise voluntary interrupt ${intr.id}`, intr.schema);
  const caps = actor.capabilities;
  if (caps !== undefined) {
    for (const f of caps.forks) push(f.toolName, `Dispatch downward child fork ${f.toolName}`, f.requestSchema);
    for (const sp of caps.speculations) push(sp.toolName, `Launch speculative tournament ${sp.toolName}`, sp.requestSchema);
    if (caps.mutatePlan?.spawnTasks !== undefined) push('spawnTasks', 'Enqueue prerequisite tasks into the lane.', z.object({ tasks: z.array(caps.mutatePlan.spawnTasks.itemSchema).min(1) }));
    if (caps.mutatePlan?.canAddDependencies) push('addDependencies', 'Add prerequisite item dependencies to the active run.', z.object({ dependsOn: z.array(z.string()).min(1) }));
    if (caps.mutatePlan?.topologyToUpdate !== undefined) push('updatePartitionContract', 'Update partition contract in the run CoW overlay.', z.object({ partitionId: z.string(), newContractText: z.string() }));
    for (const esc of caps.escalations) push(esc.interrupt.id, `Escalate ${esc.interrupt.id} to human ${esc.human.id}`, esc.interrupt.schema);
  }
  if (actor.onChildInterruptHandlers.length > 0) push('resumeFork', 'Resume or abort suspended child forks.', ResumeForkInputSchema);
  return Object.freeze(schemas);
}

/**
 * Compiles the byte-identical `'union'` `WireToolSchema[]` across all member actors in a `PrefixGroupNode`.
 *
 * Tags each tool description with `[Role: <actorId>]` so `wireToolSchemasByRoleKey['*']` remains
 * invariant across parent and child `'clone-transcript'` forks (`SPEC.md` §3.2.1).
 *
 * @param {readonly AgentNode<unknown, unknown, unknown>[]}                      actors          - Member actors bound to the prefix group.
 * @param {ReadonlyMap<string, readonly InlineSkillNode<unknown>[]> | undefined} skillsByRoleKey - Optional pre-resolved skills by `roleKey`.
 *
 * @returns {readonly WireToolSchema[]} Frozen union array of wire tool schemas.
 */
export function collectUnionWireTools(
  actors: readonly AgentNode<unknown, unknown, unknown>[],
  skillsByRoleKey?: ReadonlyMap<string, readonly InlineSkillNode<unknown>[]>,
): readonly WireToolSchema[] {
  const byName = new Map<string, { readonly schema: WireToolSchema; readonly owners: Set<string>; readonly ownerList: string[] }>();
  for (const actor of actors) {
    const tools = collectRoleScopedWireTools(actor, skillsByRoleKey?.get(actor.roleKey));
    for (const tool of tools) {
      const existing = byName.get(tool.name);
      if (existing === undefined) byName.set(tool.name, { schema: tool, owners: new Set([actor.id]), ownerList: [actor.id] });
      else if (!existing.owners.has(actor.id)) {
        existing.owners.add(actor.id);
        existing.ownerList.push(actor.id);
      }
    }
  }
  const unionSchemas: WireToolSchema[] = [];
  for (const entry of byName.values()) {
    const roleTag = `[Role: ${entry.ownerList.join(', ')}]`;
    const description = entry.schema.description.includes('[Role:') ? entry.schema.description : `${entry.schema.description} ${roleTag}`;
    unionSchemas.push(Object.freeze<WireToolSchema>({ name: entry.schema.name, description, inputJsonSchema: entry.schema.inputJsonSchema }));
  }
  return Object.freeze(unionSchemas);
}
