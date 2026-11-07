import type { LocalDaemonRegexDescriptor } from '../../builders/local-daemon-builder.js';
import { matchesPtyFrameDelimiter } from './matches-pty-frame-delimiter.js';
import { stripPtyFrameDelimiter } from './strip-pty-frame-delimiter.js';

/**
 * Snapshot of the PTY process exit state inspected before and during frame settlement.
 *
 * Indicates whether the PTY process has exited and records its exit code and optional signal.
 */
export interface PtyFrameExitState {
  /** Whether the spawned PTY process has exited. */
  readonly exited: boolean;
  /** Exit code recorded from the most recent PTY exit event. */
  readonly exitCode: number;
  /** Signal number recorded from the most recent PTY exit event, if any. */
  readonly exitSignal?: number;
}

/**
 * Parameters for awaiting a settled output frame on an interactive PTY session.
 *
 * Supplies the framing configuration, optional `AbortSignal`, buffer accessors, and PTY lifecycle callbacks.
 */
export interface WaitForPtyFrameSettleParams {
  /** Unique interaction tool name for diagnostic messages. */
  readonly toolName: string;
  /** Prompt delimiter string or regex descriptor marking the end of each output frame. */
  readonly frameDelimiter: string | LocalDaemonRegexDescriptor;
  /** Pre-compiled regular expression when `frameDelimiter` is a regex descriptor. */
  readonly delimiterRegex: RegExp | undefined;
  /** Quiet window in milliseconds after `frameDelimiter` matches before settling a frame. */
  readonly idleSettleMs: number;
  /** Maximum timeout in seconds for draining the startup banner or completing a turn. */
  readonly timeoutSeconds: number;
  /** Optional abort signal cancelling the frame-settle wait. */
  readonly signal?: AbortSignal;
  /** Reader returning the current rolling PTY output buffer. */
  readonly getBuffer: () => string;
  /** Callback clearing the rolling PTY output buffer once a frame is consumed. */
  readonly clearBuffer: () => void;
  /** Reader returning the current PTY process exit state. */
  readonly getExitState: () => PtyFrameExitState;
  /** Callback registering or clearing the active PTY data and exit listeners. */
  readonly setListeners: (
    onData: (() => void) | undefined,
    onExit: ((code: number, sig?: number) => void) | undefined,
  ) => void;
  /** Callback invoked when the PTY process exits prematurely before matching `frameDelimiter`. */
  readonly onPrematureExit: () => void;
  /** Callback closing and reaping the PTY process tree on timeout or abort. */
  readonly closeSession: () => Promise<void>;
}

/**
 * Waits until the rolling PTY output buffer matches `frameDelimiter` and remains quiet for `idleSettleMs`.
 *
 * Enforces `timeoutSeconds`, premature process exit detection, and immediate `AbortSignal` cancellation
 * (including when `signal` is already aborted upon entry), stripping the trailing prompt delimiter on settle.
 *
 * @param {WaitForPtyFrameSettleParams} params - Framing options, abort signal, buffer accessors, and lifecycle callbacks.
 *
 * @returns {Promise<string>} Settled output frame string with the trailing delimiter removed.
 *
 * @throws {Error} If the PTY process exits prematurely, `signal` aborts, or `timeoutSeconds` elapses.
 */
export function waitForPtyFrameSettle(params: WaitForPtyFrameSettleParams): Promise<string> {
  const {
    toolName,
    frameDelimiter,
    delimiterRegex,
    idleSettleMs,
    timeoutSeconds,
    signal,
    getBuffer,
    clearBuffer,
    getExitState,
    setListeners,
    onPrematureExit,
    closeSession,
  } = params;
  const timeoutMs = timeoutSeconds * 1000;
  const settleMs = Math.max(1, idleSettleMs);
  const timers: {
    settleTimer?: ReturnType<typeof setTimeout>;
    timeoutTimer?: ReturnType<typeof setTimeout>;
  } = {};
  return new Promise<string>((resolve, reject) => {
    const cleanup = (): void => {
      setListeners(undefined, undefined);
      if (timers.settleTimer !== undefined) clearTimeout(timers.settleTimer);
      if (timers.timeoutTimer !== undefined) clearTimeout(timers.timeoutTimer);
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      void closeSession().finally(() =>
        reject(new Error(`Interactive tool '${toolName}' aborted by AbortSignal.`)),
      );
    };
    const onPrematureClose = (code: number, sig?: number): void => {
      cleanup();
      onPrematureExit();
      reject(
        new Error(
          `Interactive tool '${toolName}' exited prematurely (code ${String(code)}, signal ${String(sig ?? null)}) before matching frame delimiter.`,
        ),
      );
    };
    const scheduleCheck = (): void => {
      if (timers.settleTimer !== undefined) clearTimeout(timers.settleTimer);
      if (!matchesPtyFrameDelimiter(getBuffer(), frameDelimiter, delimiterRegex)) return;
      timers.settleTimer = setTimeout(() => {
        const bufferSnapshot = getBuffer();
        if (!matchesPtyFrameDelimiter(bufferSnapshot, frameDelimiter, delimiterRegex)) return;
        const output = stripPtyFrameDelimiter(bufferSnapshot, frameDelimiter, delimiterRegex);
        clearBuffer();
        cleanup();
        resolve(output);
      }, settleMs);
    };
    setListeners(scheduleCheck, onPrematureClose);
    const exitState = getExitState();
    if (exitState.exited) {
      onPrematureClose(exitState.exitCode, exitState.exitSignal);
      return;
    }
    if (signal?.aborted === true) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    timers.timeoutTimer = setTimeout(() => {
      cleanup();
      void closeSession().finally(() =>
        reject(
          new Error(
            `Interactive tool '${toolName}' timed out after ${String(timeoutSeconds)}s waiting for frame delimiter.`,
          ),
        ),
      );
    }, timeoutMs);
    scheduleCheck();
  });
}
