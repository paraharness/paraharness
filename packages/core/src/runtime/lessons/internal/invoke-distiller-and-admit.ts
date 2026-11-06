import { createHash } from 'node:crypto';
import type { ModelASTNode } from '../../../ast/domain-ast.types.js';
import type { ModelDriver } from '../../../ports/model-driver.js';
import type { ModelTurnRequest } from '../../../ports/model-turn-request.js';
import type { RuntimeDriverContext } from '../../../ports/runtime-driver-context.js';
import type { WireFrameRecord } from '../../../ports/wire-frame-record.js';
import { DistilledLessonCandidateSchema } from '../../../schemas/budget-and-lesson.schema.js';
import { resolveSourceStringValue } from '../../prefix/internal/collect-prefix-tools.js';
import type { LessonCreationEpochMetadata } from '../lesson-creation-epoch-metadata.js';
import type { LessonDistillationParams } from '../lesson-distillation-params.js';

/**
 * Resolves the concrete `ModelASTNode` configured on a `LessonsNode.distillation` block.
 *
 * Unwraps a `PoolNode` through `PoolManager.selectModel()` (or falls back to the first pool item)
 * when `distillation.model` is a pool rather than a direct `ModelASTNode`.
 *
 * @param {LessonDistillationParams} params - Distillation execution parameters.
 *
 * @returns {ModelASTNode} Selected `ModelASTNode` for invoking the distiller turn.
 */
export function resolveDistillerModelNode(params: LessonDistillationParams): ModelASTNode {
  const dist = params.lessonsNode.distillation;
  if (dist === undefined) {
    throw new Error(`LessonsNode '${params.lessonsNode.id}' has no distillation configuration.`);
  }
  if (dist.model.type !== 'harness:pool') return dist.model;
  if (params.poolManager !== undefined) {
    return params.poolManager.selectModel(dist.model, params.ctx.runId, 0);
  }
  const fallback = dist.model.items[0];
  if (fallback === undefined) {
    throw new Error(`Distiller PoolNode '${dist.model.id}' contains 0 models.`);
  }
  return fallback;
}

/**
 * Resolves `(epochAtCreation, createdByRunId)` for a newly distilled lesson's target partition.
 *
 * Queries `TopologyStore.getPartitions(runId)` when available so lessons created against a
 * mutated run overlay inherit that overlay's bumped epoch and `lastMutatedByRunId` (`SPEC.md` §3.4.3).
 *
 * @param {LessonDistillationParams} params      - Distillation parameters with optional `topologyStore`.
 * @param {string | undefined}       partitionId - Optional logical partition tag on the distilled lesson.
 *
 * @returns {Promise<LessonCreationEpochMetadata>} Partition epoch metadata.
 */
export async function resolveLessonCreationEpoch(
  params: LessonDistillationParams,
  partitionId: string | undefined,
): Promise<LessonCreationEpochMetadata> {
  if (params.topologyStore === undefined || partitionId === undefined) {
    return { epochAtCreation: 0, createdByRunId: params.ctx.runId };
  }
  const partitions = await params.topologyStore.getPartitions(params.ctx.runId);
  const part = partitions.get(partitionId);
  if (part !== undefined) {
    return {
      epochAtCreation: part.epoch,
      createdByRunId: part.lastMutatedByRunId ?? params.ctx.runId,
    };
  }
  return { epochAtCreation: 0, createdByRunId: params.ctx.runId };
}

/**
 * Builds the `ModelTurnRequest` used to invoke the contrastive lesson distiller model.
 *
 * Resolves distillation guideline sources and packages the trajectory pair as a single
 * user wire frame with `DistilledLessonCandidateSchema`.
 *
 * @param {LessonDistillationParams} params    - Distillation parameters and trajectory pair.
 * @param {ModelASTNode}             modelNode - Resolved distiller model node.
 *
 * @returns {Promise<ModelTurnRequest>} Immutable turn request for `ModelDriver.invokeTurn()`.
 */
export async function buildDistillerTurnRequest(
  params: LessonDistillationParams,
  modelNode: ModelASTNode,
): Promise<ModelTurnRequest> {
  const dist = params.lessonsNode.distillation;
  const resolvedSnap =
    dist?.guidelines !== undefined
      ? await resolveSourceStringValue(dist.guidelines, params.ctx.registry, params.ctx)
      : undefined;
  const systemText = resolvedSnap?.text ?? 'Extract a reusable empirical lesson if applicable.';
  const systemDigest = createHash('sha256').update(systemText, 'utf8').digest('hex');
  const payloadJson = JSON.stringify({ guidelines: systemText, trajectory: params.trajectory });
  const userFrame: WireFrameRecord = Object.freeze({
    messageId: `distill:${params.ctx.stepExecId}:${Date.now()}`,
    parentMessageId: null,
    vendorId: modelNode.type,
    rawWireFrame: new TextEncoder().encode(payloadJson),
    canonical: Object.freeze({ role: 'user', visibleText: payloadJson }),
    prefixDigest: systemDigest,
  });
  return Object.freeze({
    modelId: modelNode.modelId,
    effort: modelNode.effort,
    toolChoice: 'none',
    wirePrefix: Object.freeze({
      prefixGroupId: 'distiller',
      toolsMode: 'role-scoped',
      systemPromptText: systemText,
      systemDigest,
      groundingSnapshots: Object.freeze([]),
      wireToolSchemasByRoleKey: Object.freeze({ '*': Object.freeze([]) }),
    }),
    roleKey: '*',
    history: Object.freeze([userFrame]),
    outputSchema: DistilledLessonCandidateSchema,
    signal: params.ctx.signal,
  });
}

/**
 * Invokes the configured distiller model over a failure-to-pass trajectory pair and admits passing lessons.
 *
 * Validates structured distiller output against `DistilledLessonCandidateSchema`, enforces the
 * `admit: boolean` noise filter, and writes admitted lessons to `LessonStore.admit()`.
 *
 * @param {LessonDistillationParams} params - Distillation parameters, stores, and trajectory pair.
 *
 * @returns {Promise<string | undefined>} Admitted lesson ID, or `undefined` when filtered out.
 */
export async function invokeDistillerAndAdmit(
  params: LessonDistillationParams,
): Promise<string | undefined> {
  if (params.lessonsNode.distillation === undefined) return undefined;
  const modelNode = resolveDistillerModelNode(params);
  const driverFactory = params.ctx.registry.models[modelNode.type] as
    | ((node: ModelASTNode, ctx: RuntimeDriverContext) => ModelDriver)
    | undefined;
  if (driverFactory === undefined) {
    throw new Error(`No ModelDriver registered for '${modelNode.type}' in distiller '${params.lessonsNode.id}'.`);
  }
  const driver = driverFactory(modelNode, {
    registry: params.ctx.registry,
    resolveEnv: (v) => params.ctx.resolveEnv(v),
    getRunner: (r) => params.ctx.getRunner(r),
  });
  const turnRequest = await buildDistillerTurnRequest(params, modelNode);
  const response = await driver.invokeTurn(turnRequest);
  const raw = response.structuredOutput ?? JSON.parse(response.canonical.visibleText || '{}');
  const parsed = DistilledLessonCandidateSchema.parse(raw);
  if (!parsed.admit || parsed.directive === undefined || parsed.directive.length === 0) {
    return undefined;
  }
  const epochMeta = await resolveLessonCreationEpoch(params, parsed.partition);
  return params.lessonStore.admit({
    partition: parsed.partition,
    directive: parsed.directive,
    epochAtCreation: epochMeta.epochAtCreation,
    createdByRunId: epochMeta.createdByRunId,
  });
}
