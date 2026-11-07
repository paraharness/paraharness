import * as pty from 'node-pty';
import PQueue from 'p-queue';
import type { LocalDaemonRegexDescriptor } from '../../builders/local-daemon-builder.js';
import { enqueueWithQueuedAbortSignal } from './enqueue-with-queued-abort-signal.js';
import { ensureNodePtySpawnHelperExecutable } from './ensure-node-pty-spawn-helper.js';
import { matchesPtyFrameDelimiter } from './matches-pty-frame-delimiter.js';
import {
  terminatePidTreeWithGrace,
  type ResolvedSubprocessEnvironment,
} from './process-group-lifecycle.js';
import { stripPtyFrameDelimiter } from './strip-pty-frame-delimiter.js';

/**
 * Configuration options for initializing a `PtyFramedInteractiveSession`.
 *
 * Supplies the tool name, interactive CLI `argv`, resolved environment, frame delimiter,
 * output settle quiet window, and per-turn timeout.
 */
export interface PtyFramedSessionOptions {
  /** Unique interaction tool name for diagnostic messages. */
  readonly toolName: string;
  /** Command argument vector spawned inside the `ECHO`-disabled wrapper. */
  readonly argv: readonly string[];
  /** Resolved working directory and environment variables. */
  readonly resolvedEnv: ResolvedSubprocessEnvironment;
  /** Prompt delimiter string or regex descriptor marking the end of each output frame. */
  readonly frameDelimiter: string | LocalDaemonRegexDescriptor;
  /** Quiet window in milliseconds after `frameDelimiter` matches before settling a frame. */
  readonly idleSettleMs: number;
  /** Maximum timeout in seconds for draining the startup banner or completing a turn. */
  readonly timeoutSeconds: number;
}

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
        : new RegExp(
            options.frameDelimiter.pattern,
            (options.frameDelimiter.flags ?? '').replace(/[gy]/g, ''),
          );
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
    return enqueueWithQueuedAbortSignal<string>({
      queue: this.turnQueue,
      runnerId: this.options.toolName,
      resourceLabel: 'pty-turn',
      signal,
      task: () => this.executeSerializedTurn(input, signal),
    });
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
    if (this.ptyProcess === undefined) {
      return;
    }
    const activePty = this.ptyProcess;
    this.ptyProcess = undefined;
    this.bannerDrained = false;
    try {
      activePty.kill();
    } catch {
      return;
    } finally {
      await terminatePidTreeWithGrace(activePty.pid);
    }
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
   *
   * @throws {Error} If the PTY process is not writable or frame settlement fails.
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
    const wrappedArgv = [
      'sh',
      '-c',
      'stty -echo -onlcr 2>/dev/null || true; exec "$@"',
      '_',
      ...this.options.argv,
    ];
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
    const timers: {
      settleTimer?: ReturnType<typeof setTimeout>;
      timeoutTimer?: ReturnType<typeof setTimeout>;
    } = {};
    return new Promise<string>((resolve, reject) => {
      const onAbort = (): void => {
        cleanup();
        void this.close().finally(() =>
          reject(new Error(`Interactive tool '${this.options.toolName}' aborted by AbortSignal.`)),
        );
      };
      const cleanup = (): void => {
        this.onDataCallback = undefined;
        this.onExitCallback = undefined;
        if (timers.settleTimer !== undefined) clearTimeout(timers.settleTimer);
        if (timers.timeoutTimer !== undefined) clearTimeout(timers.timeoutTimer);
        signal?.removeEventListener('abort', onAbort);
      };
      const onPrematureClose = (code: number, sig?: number): void => {
        cleanup();
        this.ptyProcess = undefined;
        this.bannerDrained = false;
        reject(
          new Error(
            `Interactive tool '${this.options.toolName}' exited prematurely (code ${String(code)}, signal ${String(sig ?? null)}) before matching frame delimiter.`,
          ),
        );
      };
      const scheduleCheck = (): void => {
        if (timers.settleTimer !== undefined) clearTimeout(timers.settleTimer);
        if (!matchesPtyFrameDelimiter(this.currentBuffer, this.options.frameDelimiter, this.delimiterRegex)) return;
        timers.settleTimer = setTimeout(() => {
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
      signal?.addEventListener('abort', onAbort, { once: true });
      timers.timeoutTimer = setTimeout(() => {
        cleanup();
        void this.close().finally(() =>
          reject(
            new Error(
              `Interactive tool '${this.options.toolName}' timed out after ${String(this.options.timeoutSeconds)}s waiting for frame delimiter.`,
            ),
          ),
        );
      }, timeoutMs);
      scheduleCheck();
    });
  }
}
