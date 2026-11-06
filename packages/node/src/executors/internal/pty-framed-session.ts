import type { ChildProcess } from 'node:child_process';
import {
  spawnDetachedSubprocess,
  terminateProcessGroupWithGrace,
} from './process-group-lifecycle.js';
import type { PtyFramedSessionOptions } from './pty-framed-session-options.js';

/**
 * Stateful `ECHO`-disabled interactive session managing framed turn-based CLI communication (`local.daemon.interact`).
 *
 * Spawns the interactive command with terminal `ECHO` disabled (`stty -echo`), drains the initial startup
 * banner until `frameDelimiter` matches and output settles for `idleSettleMs`, and serializes concurrent
 * turns per session within `timeoutSeconds`.
 */
export class PtyFramedInteractiveSession {
  /** Session configuration options. */
  private readonly options: PtyFramedSessionOptions;
  /** Compiled regular expression when `frameDelimiter` is a regex descriptor. */
  private readonly delimiterRegex: RegExp | undefined;
  /** Active child process once spawned. */
  private child: ChildProcess | undefined;
  /** Rolling output buffer for the currently active banner or turn. */
  private currentBuffer = '';
  /** Listener notified whenever new stdout/stderr bytes arrive. */
  private onDataCallback: (() => void) | undefined;
  /** Promise chain serializing turns on this interactive session. */
  private turnChain: Promise<unknown> = Promise.resolve();
  /** Whether the initial startup banner has been drained. */
  private bannerDrained = false;

  /**
   * Initializes a `PtyFramedInteractiveSession` with its command and framing configuration.
   *
   * Pre-compiles the frame delimiter regular expression when configured as a regex descriptor.
   *
   * @param {PtyFramedSessionOptions} options - Interactive command, delimiter, settle, and timeout options.
   */
  constructor(options: PtyFramedSessionOptions) {
    this.options = options;
    this.delimiterRegex =
      typeof options.frameDelimiter === 'string'
        ? undefined
        : new RegExp(options.frameDelimiter.pattern, options.frameDelimiter.flags);
  }

  /**
   * Enqueues and executes a single serialized interactive turn on the session.
   *
   * Lazily spawns the interactive process and drains its startup banner on the first turn,
   * writes `${input}\n`, and resolves once `frameDelimiter` matches and output settles for `idleSettleMs`.
   *
   * @param {string}      input    - Command line input to send to the interactive process.
   * @param {AbortSignal} [signal] - Optional abort signal cancelling the turn.
   *
   * @returns {Promise<string>} Settled output frame with the trailing prompt delimiter stripped.
   */
  sendTurn(input: string, signal?: AbortSignal): Promise<string> {
    const nextTurn = this.turnChain.then(
      () => this.executeSerializedTurn(input, signal),
      () => this.executeSerializedTurn(input, signal),
    );
    this.turnChain = nextTurn.then(
      () => undefined,
      () => undefined,
    );
    return nextTurn;
  }

  /**
   * Terminates the underlying interactive child process group.
   *
   * Sends `SIGTERM` followed by `SIGKILL` after the grace window and clears the process handle.
   *
   * @returns {Promise<void>} Resolves once the interactive subprocess group has exited.
   */
  async close(): Promise<void> {
    if (this.child === undefined) return;
    const activeChild = this.child;
    this.child = undefined;
    this.bannerDrained = false;
    await terminateProcessGroupWithGrace(activeChild);
  }

  /**
   * Executes a single turn after acquiring the session's serialization lock.
   *
   * Ensures the subprocess is started and its startup banner drained before writing `${input}\n`.
   *
   * @param {string}      input    - Command line input for the turn.
   * @param {AbortSignal} [signal] - Optional abort signal.
   *
   * @returns {Promise<string>} Settled output frame for the turn.
   */
  private async executeSerializedTurn(input: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    if (!this.bannerDrained || this.child === undefined || this.child.exitCode !== null) {
      this.spawnInteractiveProcess();
      await this.waitForFrameSettle(signal);
      this.bannerDrained = true;
    }
    this.currentBuffer = '';
    if (this.child?.stdin === null || this.child?.stdin === undefined) {
      throw new Error(`Interactive session '${this.options.toolName}' stdin is not writable.`);
    }
    this.child.stdin.write(`${input}\n`);
    return this.waitForFrameSettle(signal);
  }

  /**
   * Spawns the interactive command inside an `ECHO`-disabled shell wrapper (`stty -echo`).
   *
   * Pipes `stdout` and `stderr` into `this.currentBuffer` and notifies the active frame waiter.
   */
  private spawnInteractiveProcess(): void {
    const wrappedArgv = [
      'sh',
      '-c',
      'stty -echo 2>/dev/null || true; exec "$@"',
      '_',
      ...this.options.argv,
    ];
    this.currentBuffer = '';
    const child = spawnDetachedSubprocess({
      argv: wrappedArgv,
      resolvedEnv: {
        ...this.options.resolvedEnv,
        env: { ...this.options.resolvedEnv.env, TERM: 'dumb', NO_COLOR: '1' },
      },
      stdinStdio: 'pipe',
    });
    const appendChunk = (chunk: Buffer): void => {
      this.currentBuffer += chunk.toString('utf8');
      this.onDataCallback?.();
    };
    child.stdout?.on('data', appendChunk);
    child.stderr?.on('data', appendChunk);
    this.child = child;
  }

  /**
   * Waits until `this.currentBuffer` matches `frameDelimiter` and remains quiet for `idleSettleMs`.
   *
   * Enforces `timeoutSeconds` and `signal` cancellation and strips the trailing prompt delimiter.
   *
   * @param {AbortSignal} [signal] - Optional abort signal.
   *
   * @returns {Promise<string>} Settled output frame string.
   */
  private waitForFrameSettle(signal?: AbortSignal): Promise<string> {
    const timeoutMs = this.options.timeoutSeconds * 1000;
    const settleMs = Math.max(1, this.options.idleSettleMs);
    return new Promise<string>((resolve, reject) => {
      let settleTimer: ReturnType<typeof setTimeout> | undefined;
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      const cleanup = (): void => {
        this.onDataCallback = undefined;
        if (settleTimer !== undefined) clearTimeout(settleTimer);
        if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
        if (onAbort !== undefined && signal !== undefined) signal.removeEventListener('abort', onAbort);
      };
      const scheduleCheck = (): void => {
        if (settleTimer !== undefined) clearTimeout(settleTimer);
        if (!this.matchesDelimiter(this.currentBuffer)) return;
        settleTimer = setTimeout(() => {
          if (!this.matchesDelimiter(this.currentBuffer)) return;
          const output = this.stripDelimiter(this.currentBuffer);
          this.currentBuffer = '';
          cleanup();
          resolve(output);
        }, settleMs);
      };
      this.onDataCallback = scheduleCheck;
      if (signal !== undefined) {
        onAbort = (): void => {
          cleanup();
          reject(new Error(`Interactive tool '${this.options.toolName}' aborted by AbortSignal.`));
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }
      timeoutTimer = setTimeout(() => {
        cleanup();
        reject(new Error(`Interactive tool '${this.options.toolName}' timed out after ${String(this.options.timeoutSeconds)}s waiting for frame delimiter.`));
      }, timeoutMs);
      scheduleCheck();
    });
  }

  /**
   * Checks whether `buffer` currently satisfies `frameDelimiter`.
   *
   * Evaluates either string inclusion or `this.delimiterRegex.test(buffer)`.
   *
   * @param {string} buffer - Accumulated frame output text.
   *
   * @returns {boolean} True when the delimiter matches `buffer`.
   */
  private matchesDelimiter(buffer: string): boolean {
    if (typeof this.options.frameDelimiter === 'string') {
      return buffer.includes(this.options.frameDelimiter);
    }
    return this.delimiterRegex !== undefined && this.delimiterRegex.test(buffer);
  }

  /**
   * Strips the trailing prompt delimiter from a settled frame buffer.
   *
   * Removes the last occurrence of a string delimiter or regex delimiter match and trims whitespace.
   *
   * @param {string} buffer - Settled frame output text.
   *
   * @returns {string} Cleaned turn output without the trailing prompt.
   */
  private stripDelimiter(buffer: string): string {
    if (typeof this.options.frameDelimiter === 'string') {
      const idx = buffer.lastIndexOf(this.options.frameDelimiter);
      return (idx !== -1 ? buffer.slice(0, idx) : buffer).trim();
    }
    if (this.delimiterRegex !== undefined) {
      return buffer.replace(this.delimiterRegex, '').trim();
    }
    return buffer.trim();
  }
}
