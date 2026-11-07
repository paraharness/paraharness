import type { ChildProcess } from 'node:child_process';
import type {
  CheckEvaluationResult,
  LocalStreamCheckCircuitBreakerConfig,
} from '@harness-dsl/core';
import { extractCircuitBreakerExcerpt } from './extract-circuit-breaker-excerpt.js';
import { hasCapturedGraceLines } from './has-captured-grace-lines.js';
import {
  spawnDetachedSubprocess,
  terminateProcessGroupWithGrace,
  type ResolvedSubprocessEnvironment,
} from './process-group-lifecycle.js';

/**
 * Parameters for executing a streaming verification check subprocess via `runStreamingCheckSubprocess`.
 *
 * Supplies the check identifier, argument vector, resolved environment, optional rolling-window
 * regex circuit breaker, timeout duration, and abort signal.
 */
export interface RunStreamingCheckSubprocessParams {
  /** Logical identifier of the streaming check. */
  readonly checkId: string;
  /** Command argument vector where index `0` is the executable. */
  readonly argv: readonly string[];
  /** Resolved working directory and environment variables. */
  readonly resolvedEnv: ResolvedSubprocessEnvironment;
  /** Optional rolling-window regex circuit-breaker configuration. */
  readonly circuitBreaker?: LocalStreamCheckCircuitBreakerConfig;
  /** Optional execution timeout in minutes. */
  readonly timeoutMinutes?: number;
  /** Optional abort signal cancelling subprocess execution. */
  readonly signal?: AbortSignal;
}

/**
 * Mutable accumulator tracking rolling output, circuit-breaker match coordinates, and termination state.
 *
 * Encapsulates stream check progress in a single state object rather than mutating outer `let` bindings.
 */
interface StreamCheckCollectorState {
  /** Combined rolling UTF-8 text from `stdout` and `stderr`. */
  combinedOutput: string;
  /** Start and end character offsets once the circuit-breaker regex matches. */
  matchRange?: readonly [number, number];
  /** Whether the check has already tripped via circuit breaker, timeout, or abort. */
  tripped: boolean;
  /** Optional wall-clock timeout handle. */
  timeoutTimer?: ReturnType<typeof setTimeout>;
  /** Callback rejecting the active promise after terminating the process group. */
  abortWithError?: (message: string) => void;
}

/**
 * Parameters for processing a single decoded output chunk in `appendStreamCheckChunk`.
 *
 * Bundles the collector state, decoded chunk text, compiled circuit-breaker regex, grace line count,
 * child process handle, and promise resolver.
 */
interface AppendStreamCheckChunkParams {
  /** Active stream collector state. */
  readonly state: StreamCheckCollectorState;
  /** Decoded UTF-8 chunk from `stdout` or `stderr`. */
  readonly chunkText: string;
  /** Optional pre-compiled circuit-breaker regular expression. */
  readonly breakerRegex: RegExp | undefined;
  /** Number of trailing lines to collect after a regex match. */
  readonly graceLines: number;
  /** Detached child process running the stream check. */
  readonly child: ChildProcess;
  /** Promise resolver for early circuit-breaker completion. */
  readonly resolve: (result: CheckEvaluationResult) => void;
}

/**
 * Parameters for constructing the terminal `CheckEvaluationResult` on normal process close.
 *
 * Bundles the collector state, process exit code, check identifier, and grace line count.
 */
interface BuildStreamCheckCloseResultParams {
  /** Completed stream collector state. */
  readonly state: StreamCheckCollectorState;
  /** Process exit status code from the `'close'` event. */
  readonly exitCode: number | null;
  /** Logical identifier of the streaming check. */
  readonly checkId: string;
  /** Number of trailing lines configured on the circuit breaker. */
  readonly graceLines: number;
}

/**
 * Appends a stream chunk to `params.state`, updates `matchRange`, and triggers early termination once grace lines arrive.
 *
 * Invokes `terminateProcessGroupWithGrace` and resolves `params.resolve` when `hasCapturedGraceLines` returns `true`.
 *
 * @param {AppendStreamCheckChunkParams} params - Collector state, chunk text, regex, child process, and resolver.
 */
function appendStreamCheckChunk(params: AppendStreamCheckChunkParams): void {
  const { state, chunkText, breakerRegex, graceLines, child, resolve } = params;
  if (state.tripped) return;
  state.combinedOutput += chunkText;
  if (breakerRegex !== undefined && state.matchRange === undefined) {
    const match = breakerRegex.exec(state.combinedOutput);
    if (match !== null) {
      state.matchRange = [match.index, match.index + match[0].length];
    }
  }
  if (state.matchRange === undefined) return;
  if (!hasCapturedGraceLines(state.combinedOutput, state.matchRange, graceLines)) return;
  state.tripped = true;
  const excerpt = extractCircuitBreakerExcerpt(state.combinedOutput, state.matchRange, graceLines);
  void terminateProcessGroupWithGrace(child).then(() =>
    resolve(Object.freeze<CheckEvaluationResult>({ ok: false, deficits: Object.freeze([excerpt]) })),
  );
}

/**
 * Produces the final `CheckEvaluationResult` when a streaming check subprocess closes normally.
 *
 * Prioritizes any buffered circuit-breaker match before evaluating the process exit status code.
 *
 * @param {BuildStreamCheckCloseResultParams} params - Collector state, exit code, check ID, and grace lines.
 *
 * @returns {CheckEvaluationResult} Frozen check evaluation outcome.
 */
function buildStreamCheckCloseResult(
  params: BuildStreamCheckCloseResultParams,
): CheckEvaluationResult {
  const { state, exitCode, checkId, graceLines } = params;
  if (state.matchRange !== undefined) {
    const excerpt = extractCircuitBreakerExcerpt(state.combinedOutput, state.matchRange, graceLines);
    return Object.freeze<CheckEvaluationResult>({ ok: false, deficits: Object.freeze([excerpt]) });
  }
  if (exitCode === 0) {
    return Object.freeze<CheckEvaluationResult>({ ok: true, deficits: Object.freeze([]) });
  }
  const deficit =
    state.combinedOutput.trim() ||
    `Stream check '${checkId}' exited with code ${String(exitCode ?? 1)}.`;
  return Object.freeze<CheckEvaluationResult>({ ok: false, deficits: Object.freeze([deficit]) });
}

/**
 * Executes a streaming check subprocess with a rolling multi-line `stdout`+`stderr` circuit breaker.
 *
 * Terminates the detached process group (`SIGTERM` -> `SIGKILL`) immediately once the circuit-breaker
 * regex matches and `graceLinesAfterMatch` trailing lines have been collected.
 *
 * @param {RunStreamingCheckSubprocessParams} params - Check `argv`, environment, circuit breaker, and signal.
 *
 * @returns {Promise<CheckEvaluationResult>} Check evaluation result and captured failure deficit.
 *
 * @throws {Error} If `params.signal` aborts, the check times out, or spawning fails.
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
  const state: StreamCheckCollectorState = { combinedOutput: '', tripped: false };
  const onAbort = (): void => {
    state.abortWithError?.(`Stream check '${params.checkId}' aborted by AbortSignal.`);
  };
  params.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    return await new Promise<CheckEvaluationResult>((resolve, reject) => {
      state.abortWithError = (message: string): void => {
        if (state.tripped) return;
        state.tripped = true;
        void terminateProcessGroupWithGrace(child).then(() => reject(new Error(message)));
      };
      const onChunk = (chunk: Buffer): void =>
        appendStreamCheckChunk({
          state,
          chunkText: chunk.toString('utf8'),
          breakerRegex,
          graceLines,
          child,
          resolve,
        });
      child.stdout?.on('data', onChunk);
      child.stderr?.on('data', onChunk);
      if (params.timeoutMinutes !== undefined) {
        state.timeoutTimer = setTimeout(
          () =>
            state.abortWithError?.(
              `Stream check '${params.checkId}' timed out after ${String(params.timeoutMinutes)}m.`,
            ),
          params.timeoutMinutes * 60_000,
        );
      }
      child.once('error', reject);
      child.once('close', (code) => {
        if (state.tripped) return;
        resolve(
          buildStreamCheckCloseResult({
            state,
            exitCode: code,
            checkId: params.checkId,
            graceLines,
          }),
        );
      });
    });
  } finally {
    params.signal?.removeEventListener('abort', onAbort);
    if (state.timeoutTimer !== undefined) clearTimeout(state.timeoutTimer);
  }
}
