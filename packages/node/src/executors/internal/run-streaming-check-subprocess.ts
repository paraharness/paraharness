import type { CheckEvaluationResult } from '@harness-dsl/core';
import {
  spawnDetachedSubprocess,
  terminateProcessGroupWithGrace,
} from './process-group-lifecycle.js';
import type { RunStreamingCheckSubprocessParams } from './run-streaming-check-subprocess-params.js';
import {
  extractCircuitBreakerExcerpt,
  hasCapturedGraceLines,
} from './stream-check-circuit-breaker-helpers.js';

/**
 * Executes a streaming check subprocess with a rolling multi-line `stdout`+`stderr` circuit breaker.
 *
 * Terminates the detached process group (`SIGTERM` -> `SIGKILL`) immediately once the circuit-breaker
 * regex matches and `graceLinesAfterMatch` trailing lines have been collected.
 *
 * @param {RunStreamingCheckSubprocessParams} params - Check `argv`, environment, circuit breaker, and signal.
 *
 * @returns {Promise<CheckEvaluationResult>} Check evaluation result and captured failure deficit.
 */
export async function runStreamingCheckSubprocess(
  params: RunStreamingCheckSubprocessParams,
): Promise<CheckEvaluationResult> {
  params.signal?.throwIfAborted();
  const child = spawnDetachedSubprocess({ argv: params.argv, resolvedEnv: params.resolvedEnv });
  const breakerRegex =
    params.circuitBreaker !== undefined
      ? new RegExp(params.circuitBreaker.pattern, params.circuitBreaker.flags)
      : undefined;
  const graceLines = params.circuitBreaker?.graceLinesAfterMatch ?? 0;
  let combinedOutput = '';
  let matchIndex = -1;
  let matchEndIndex = -1;
  let tripped = false;
  let onAbort: (() => void) | undefined;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<CheckEvaluationResult>((resolve, reject) => {
      const onChunk = (chunk: Buffer): void => {
        if (tripped) return;
        combinedOutput += chunk.toString('utf8');
        if (breakerRegex !== undefined && matchIndex === -1) {
          const match = breakerRegex.exec(combinedOutput);
          if (match !== null) {
            matchIndex = match.index;
            matchEndIndex = match.index + match[0].length;
          }
        }
        if (matchIndex !== -1 && hasCapturedGraceLines(combinedOutput, matchEndIndex, graceLines)) {
          tripped = true;
          const excerpt = extractCircuitBreakerExcerpt(combinedOutput, matchIndex, matchEndIndex, graceLines);
          void terminateProcessGroupWithGrace(child).then(() =>
            resolve(Object.freeze<CheckEvaluationResult>({ ok: false, deficits: Object.freeze([excerpt]) })),
          );
        }
      };
      child.stdout?.on('data', onChunk);
      child.stderr?.on('data', onChunk);
      if (params.signal !== undefined) {
        onAbort = (): void => {
          tripped = true;
          void terminateProcessGroupWithGrace(child).then(() =>
            reject(new Error(`Stream check '${params.checkId}' aborted by AbortSignal.`)),
          );
        };
        params.signal.addEventListener('abort', onAbort, { once: true });
      }
      if (params.timeoutMinutes !== undefined) {
        timeoutTimer = setTimeout(() => {
          tripped = true;
          void terminateProcessGroupWithGrace(child).then(() =>
            reject(new Error(`Stream check '${params.checkId}' timed out after ${String(params.timeoutMinutes)}m.`)),
          );
        }, params.timeoutMinutes * 60_000);
      }
      child.once('error', reject);
      child.once('close', (code) => {
        if (tripped) return;
        if (matchIndex !== -1) {
          const excerpt = extractCircuitBreakerExcerpt(combinedOutput, matchIndex, matchEndIndex, graceLines);
          resolve(Object.freeze<CheckEvaluationResult>({ ok: false, deficits: Object.freeze([excerpt]) }));
          return;
        }
        if (code === 0) {
          resolve(Object.freeze<CheckEvaluationResult>({ ok: true, deficits: Object.freeze([]) }));
          return;
        }
        const deficit = combinedOutput.trim() || `Stream check '${params.checkId}' exited with code ${String(code ?? 1)}.`;
        resolve(Object.freeze<CheckEvaluationResult>({ ok: false, deficits: Object.freeze([deficit]) }));
      });
    });
  } finally {
    if (onAbort !== undefined && params.signal !== undefined) params.signal.removeEventListener('abort', onAbort);
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
  }
}
