import { evaluatePreFlightToolBatch } from '../evaluate-policy-guards.js';
import type { PostFlightSandboxParams } from '../post-flight-sandbox-params.js';
import type { PostFlightSandboxResult } from '../post-flight-sandbox-result.js';

/**
 * Executes a `'subprocess-post-flight'` tool inside a checkpointed sandbox (`SPEC.md` §3.5).
 *
 * Serializes `inFlightPreToolCheckpoint` before running the subprocess, restores the checkpoint
 * on throw/abort or post-flight guard rejection, and records effects only when permitted.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {PostFlightSandboxParams<THandle>} params - Post-flight sandbox parameters and checkpoint scope.
 *
 * @returns {Promise<PostFlightSandboxResult>} Execution result and post-flight verification status.
 */
export async function executePostFlightSandboxedTool<THandle = unknown>(
  params: PostFlightSandboxParams<THandle>,
): Promise<PostFlightSandboxResult> {
  const preToolCkpt = await params.checkpointScope.serializeCheckpoint(params.ctx.scopeHandle);
  await params.persistInFlightCheckpoint(preToolCkpt);
  let rawResult;
  try {
    params.ctx.signal?.throwIfAborted();
    rawResult = await params.toolDriver.execute(params.toolNode, params.parsedArgs, params.ctx);
    params.ctx.signal?.throwIfAborted();
  } catch (err) {
    await params.checkpointScope.restoreCheckpoint(params.ctx.scopeHandle, preToolCkpt);
    await params.persistInFlightCheckpoint(undefined);
    throw err;
  }
  const synthesizedEffects = await params.checkpointScope.diffEffects(
    preToolCkpt,
    params.ctx.scopeHandle,
  );
  const toolsMap = new Map([[params.callRecord.toolName, params.toolNode]]);
  const policyRes = await evaluatePreFlightToolBatch(
    {
      policy: params.policy,
      remainingCalls: [params.callRecord],
      toolsByName: toolsMap,
      activeLeases: params.activeLeases,
      ctx: params.ctx,
    },
    synthesizedEffects,
  );
  if (policyRes.status !== 'allowed') {
    await params.checkpointScope.restoreCheckpoint(params.ctx.scopeHandle, preToolCkpt);
    await params.persistInFlightCheckpoint(undefined);
    const errText =
      policyRes.status === 'denied-with-error'
        ? (policyRes.deniedErrorMessage ??
          `Post-flight policy violation (${policyRes.violatedClauseId ?? 'guard'}): rolled back subprocess changes.`)
        : `[Post-Flight Policy Violation — Workspace Rolled Back: ${policyRes.blockedCalls?.[0]?.violationSummary ?? policyRes.violatedClauseId ?? 'policy guard violation'}]`;
    return Object.freeze<PostFlightSandboxResult>({
      status:
        policyRes.status === 'denied-with-error' ? 'rolled-back-error' : 'rolled-back-interrupt',
      toolResult: Object.freeze({ content: errText, isError: true }),
      synthesizedEffects,
      policyResult: policyRes,
    });
  }
  params.ctx.recordEffects(synthesizedEffects);
  await params.persistInFlightCheckpoint(undefined);
  return Object.freeze<PostFlightSandboxResult>({
    status: 'allowed',
    toolResult: rawResult,
    synthesizedEffects,
  });
}
