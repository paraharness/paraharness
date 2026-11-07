import * as pty from 'node-pty';
import PQueue from 'p-queue';
import {
  ensureNodePtySpawnHelperExecutable,
  matchesPtyFrameDelimiter,
  stripPtyFrameDelimiter,
} from './ensure-node-pty-spawn-helper.js';
import { terminatePidTreeWithGrace } from './process-group-lifecycle.js';
import type { PtyFramedSessionOptions } from './pty-framed-session-options.js';

/**
 * Stateful `ECHO`-disabled OS pseudo-terminal session managing framed turn-based CLI communication (`local.daemon.interact`).
 *
 * Spawns the interactive command inside a real `node-pty` pseudo-terminal (`xterm-256color`, `120x40`) with
 * terminal `ECHO` disabled (`stty -echo`), drains the initial startup banner until `frameDelimiter` matches
 * and output settles for `idleSettleMs`, and serializes concurrent turns via `PQueue({ concurrency: 1 })`.
 */
export class PtyFramedInteractiveSession {
  /** Session configuration options. */
  private readonly options: PtyFramedSessionOptions;
  /** Compiled regular expression when `frameDelimiter` is a regex descriptor. */
  private readonly delimiterRegex: RegExp | undefined;
  /** Serialized 1-concurrency queue governing turn execution on this PTY session. */
  private readonly turnQueue = new PQueue({ concurrency: 1 });
  /** Active `node-pty` pseudo-terminal instance once spawned. */
  private ptyProcess: pty.IPty | undefined;
  /** Disposable for the active `ptyProcess.onData` listener. */
  private dataDisposable: pty.IDisposable | undefined;
  /** Disposable for the active `ptyProcess.onExit` listener. */
  private exitDisposable: pty.IDisposable | undefined;
  /** Rolling output buffer for the currently active banner or turn. */
  private currentBuffer = '';
  /** Listener notified whenever new PTY output arrives. */
  private onDataCallback: (() => void) | undefined;
  /** Listener notified if the PTY process exits while awaiting frame settlement. */
  private onExitCallback: ((code: number, sig?: number) => void) | undefined;
  /** Whether the spawned PTY process has exited. */
  private ptyExited = false;
  /** Exit code recorded from the most recent PTY exit event. */
  private lastExitCode = 0;
  /** Signal number recorded from the most recent PTY exit event. */
  private lastExitSignal: number | undefined;
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
        : new RegExp(options.frameDelimiter.pattern, (options.frameDelimiter.flags ?? '').replace(/[gy]/g, ''));
  }

  /**
   * Enqueues and executes a single serialized interactive turn on the PTY session via `PQueue`.
   *
   * Lazily spawns the PTY process and drains its startup banner on the first turn, writes `${input}\n`,
   * and resolves once `frameDelimiter` matches and output settles for `idleSettleMs`.
   *
   * @param {string}      input    - Command line input to send to the interactive PTY process.
   * @param {AbortSignal} [signal] - Optional abort signal cancelling the turn.
   *
   * @returns {Promise<string>} Settled output frame with the trailing prompt delimiter stripped.
   */
  async sendTurn(input: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const waitController = new AbortController();
    let onWaitAbort: (() => void) | undefined;
    if (signal !== undefined) {
      onWaitAbort = (): void => waitController.abort();
      signal.addEventListener('abort', onWaitAbort, { once: true });
    }
    try {
      return await this.turnQueue.add<string>(
        async () => {
          if (onWaitAbort !== undefined && signal !== undefined) {
            signal.removeEventListener('abort', onWaitAbort);
            onWaitAbort = undefined;
          }
          return this.executeSerializedTurn(input, signal);
        },
        { signal: waitController.signal },
      );
    } finally {
      if (onWaitAbort !== undefined && signal !== undefined) {
        signal.removeEventListener('abort', onWaitAbort);
      }
    }
  }

  /**
   * Terminates the underlying `node-pty` pseudo-terminal and its descendant process tree.
   *
   * Disposes PTY listeners, kills the PTY master/child, and reaps any surviving descendants via `pidtree` + `fkill`.
   *
   * @returns {Promise<void>} Resolves once the interactive PTY process tree has exited.
   */
  async close(): Promise<void> {
    this.dataDisposable?.dispose();
    this.exitDisposable?.dispose();
    this.dataDisposable = undefined;
    this.exitDisposable = undefined;
    if (this.ptyProcess === undefined) return;
    const activePty = this.ptyProcess;
    this.ptyProcess = undefined;
    this.bannerDrained = false;
    try {
      activePty.kill();
    } catch {}
    await terminatePidTreeWithGrace(activePty.pid);
  }

  /**
   * Executes a single turn after acquiring the session's `turnQueue` serialization slot.
   *
   * Ensures the PTY process is started and its startup banner drained before writing `${input}\n`.
   *
   * @param {string}      input    - Command line input for the turn.
   * @param {AbortSignal} [signal] - Optional abort signal.
   *
   * @returns {Promise<string>} Settled output frame for the turn.
   */
  private async executeSerializedTurn(input: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    if (!this.bannerDrained || this.ptyProcess === undefined || this.ptyExited) {
      await this.close();
      this.spawnInteractiveProcess();
      await this.waitForFrameSettle(signal);
      this.bannerDrained = true;
    }
    this.currentBuffer = '';
    if (this.ptyProcess === undefined) {
      throw new Error(`Interactive session '${this.options.toolName}' PTY is not writable.`);
    }
    this.ptyProcess.write(`${input}\n`);
    return this.waitForFrameSettle(signal);
  }

  /**
   * Spawns the interactive command inside a real `node-pty` terminal (`xterm-256color`) with `ECHO` disabled.
   *
   * Streams PTY output into `this.currentBuffer` and notifies the active frame waiter.
   */
  private spawnInteractiveProcess(): void {
    ensureNodePtySpawnHelperExecutable();
    const wrappedArgv = ['sh', '-c', 'stty -echo -onlcr 2>/dev/null || true; exec "$@"', '_', ...this.options.argv];
    this.currentBuffer = '';
    this.ptyExited = false;
    const ptyProc = pty.spawn(wrappedArgv[0] ?? 'sh', wrappedArgv.slice(1), {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd: this.options.resolvedEnv.cwd,
      env: { ...this.options.resolvedEnv.env, NO_COLOR: '1' },
    });
    this.dataDisposable = ptyProc.onData((chunk: string) => {
      this.currentBuffer += chunk.replace(/\r\n/g, '\n');
      this.onDataCallback?.();
    });
    this.exitDisposable = ptyProc.onExit(({ exitCode, signal }) => {
      this.ptyExited = true;
      this.lastExitCode = exitCode;
      this.lastExitSignal = signal;
      this.onExitCallback?.(exitCode, signal);
    });
    this.ptyProcess = ptyProc;
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
        this.onExitCallback = undefined;
        if (settleTimer !== undefined) clearTimeout(settleTimer);
        if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
        if (onAbort !== undefined && signal !== undefined) signal.removeEventListener('abort', onAbort);
      };
      const onPrematureClose = (code: number, sig?: number): void => {
        cleanup();
        this.ptyProcess = undefined;
        this.bannerDrained = false;
        reject(new Error(`Interactive tool '${this.options.toolName}' exited prematurely (code ${String(code)}, signal ${String(sig ?? null)}) before matching frame delimiter.`));
      };
      const scheduleCheck = (): void => {
        if (settleTimer !== undefined) clearTimeout(settleTimer);
        if (!matchesPtyFrameDelimiter(this.currentBuffer, this.options.frameDelimiter, this.delimiterRegex)) return;
        settleTimer = setTimeout(() => {
          if (!matchesPtyFrameDelimiter(this.currentBuffer, this.options.frameDelimiter, this.delimiterRegex)) return;
          const output = stripPtyFrameDelimiter(this.currentBuffer, this.options.frameDelimiter, this.delimiterRegex);
          this.currentBuffer = '';
          cleanup();
          resolve(output);
        }, settleMs);
      };
      this.onDataCallback = scheduleCheck;
      this.onExitCallback = onPrematureClose;
      if (this.ptyExited) {
        onPrematureClose(this.lastExitCode, this.lastExitSignal);
        return;
      }
      if (signal !== undefined) {
        onAbort = (): void => {
          cleanup();
          void this.close().finally(() => reject(new Error(`Interactive tool '${this.options.toolName}' aborted by AbortSignal.`)));
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }
      timeoutTimer = setTimeout(() => {
        cleanup();
        void this.close().finally(() => reject(new Error(`Interactive tool '${this.options.toolName}' timed out after ${String(this.options.timeoutSeconds)}s waiting for frame delimiter.`)));
      }, timeoutMs);
      scheduleCheck();
    });
  }
}
