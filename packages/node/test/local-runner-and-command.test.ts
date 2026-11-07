import { getEventListeners } from 'node:events';
import path from 'node:path';
import {
  H,
  createExecutorRegistry,
  z,
  type RunnerPoolASTNode,
  type StepExecutionContext,
} from '@harness-dsl/core';
import { describe, expect, it } from 'vitest';
import {
  NodeRunnerDriver,
  createLocalCommandToolDriver,
  executeLocalCommandCheck,
  executeLocalCommandStep,
  local,
  nodeExecutors,
  resolveWorktreeEnvAndCwd,
  spawnDetachedSubprocess,
  terminateProcessGroupWithGrace,
} from '../src/index.js';
import { buildEnvAndStdinProbeArgv } from './fixtures/sample-node-daemons.js';

function createTestStepContext<THandle = unknown>(
  scopeHandle: THandle,
  options?: {
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly signal?: AbortSignal;
    readonly runnerDrivers?: Map<string, NodeRunnerDriver>;
  },
): StepExecutionContext<THandle> {
  const drivers = options?.runnerDrivers ?? new Map<string, NodeRunnerDriver>();
  const envMap = options?.env ?? {};
  const registry = createExecutorRegistry(nodeExecutors);
  return {
    runId: 'run-node-test',
    stepExecId: 'step-node-1',
    scopeHandle,
    activePartitions: ['api'],
    activeLeases: [],
    observedEffects: [],
    signal: options?.signal,
    registry,
    resolveEnv(val) {
      if (typeof val === 'string') return val;
      return envMap[val.key];
    },
    getRunner(node: RunnerPoolASTNode) {
      let existing = drivers.get(node.id);
      if (existing === undefined) {
        existing = new NodeRunnerDriver({
          type: 'node:runner',
          id: node.id,
          slots: node.slots,
          maxDaemons: node.maxDaemons,
        });
        drivers.set(node.id, existing);
      }
      return existing;
    },
    recordEffects() {},
  };
}

describe('local.runner & NodeRunnerDriver concurrency isolation', () => {
  it('compiles passive NodeRunnerNode with default id and maxDaemons fallback', () => {
    const defaultRunner = local.runner({ slots: 4 }).toAST();
    expect(defaultRunner).toEqual({
      type: 'node:runner',
      id: 'default-runner',
      slots: 4,
      maxDaemons: 4,
    });
    const customRunner = local.runner({ id: 'ci-pool', slots: 8, maxDaemons: 2 }).toAST();
    expect(customRunner).toEqual({
      type: 'node:runner',
      id: 'ci-pool',
      slots: 8,
      maxDaemons: 2,
    });
  });

  it('queues concurrent withSlot callers in FIFO order when slots are full and cancels queued waiters on AbortSignal', async () => {
    const runnerNode = local.runner({ id: 'fifo-pool', slots: 1, maxDaemons: 1 }).toAST();
    const driver = new NodeRunnerDriver(runnerNode);
    const order: string[] = [];
    const firstAbortController = new AbortController();
    let releaseFirst: (() => void) | undefined;
    const firstEntered = new Promise<void>((resolve) => {
      void driver.withSlot(async () => {
        order.push('first-start');
        resolve();
        await new Promise<void>((r) => {
          releaseFirst = r;
        });
        order.push('first-end');
      }, firstAbortController.signal);
    });
    await firstEntered;

    const abortController = new AbortController();
    const abortedWaiter = driver.withSlot(async () => {
      order.push('aborted-waiter');
    }, abortController.signal);
    const secondWaiter = driver.withSlot(async () => {
      order.push('second');
      return 'ok-2';
    });

    abortController.abort();
    await expect(abortedWaiter).rejects.toThrow(/Aborted while waiting for slot in runner 'fifo-pool'/);
    expect(getEventListeners(abortController.signal, 'abort')).toHaveLength(0);
    firstAbortController.abort();
    await Promise.resolve();
    expect(order).toEqual(['first-start']);

    releaseFirst?.();
    await expect(secondWaiter).resolves.toBe('ok-2');
    expect(order).toEqual(['first-start', 'first-end', 'second']);
  });

  it('separates one-shot slots from maxDaemons so active daemons never starve one-shot commands', async () => {
    const runnerNode = local.runner({ id: 'isolated-pool', slots: 1, maxDaemons: 1 }).toAST();
    const driver = new NodeRunnerDriver(runnerNode);
    const events: string[] = [];
    let releaseDaemon: (() => void) | undefined;

    await driver.withDaemonSlot(async (release) => {
      releaseDaemon = release;
      events.push('daemon-acquired');
    });

    const commandResult = await driver.withSlot(async () => {
      events.push('one-shot-executed-while-daemon-active');
      return 42;
    });
    expect(commandResult).toBe(42);
    expect(events).toEqual(['daemon-acquired', 'one-shot-executed-while-daemon-active']);

    let secondDaemonAcquired = false;
    const secondDaemonPromise = driver.withDaemonSlot(async (release) => {
      secondDaemonAcquired = true;
      events.push('second-daemon-acquired');
      release();
    });
    await Promise.resolve();
    expect(secondDaemonAcquired).toBe(false);

    releaseDaemon?.();
    await secondDaemonPromise;
    expect(secondDaemonAcquired).toBe(true);
    expect(events).toEqual([
      'daemon-acquired',
      'one-shot-executed-while-daemon-active',
      'second-daemon-acquired',
    ]);
  });
});

describe('local.command execution, worktree GIT_* isolation, AbortSignal cleanup, and .unrepeatable()', () => {
  it('injects cwd: worktreePath, all 9 isolated GIT_* env vars, resolved H.env() secrets, and stdin payload', async () => {
    const runner = local.runner({ slots: 2 });
    const worktreePath = process.cwd();
    const probeSchema = z.object({
      cwd: z.string(),
      env: z.record(z.string(), z.string().optional()),
      stdin: z.string(),
    });
    const probeCmd = local
      .command('env-probe')
      .runner(runner)
      .input(z.object({ body: z.string() }))
      .output(probeSchema)
      .stdin((input) => input.body)
      .env({
        STATIC_FLAG: 'enabled',
        SECRET_TOKEN: H.env('TEST_SECRET_TOKEN'),
      })
      .argv(buildEnvAndStdinProbeArgv())
      .toAST();

    const ctx = createTestStepContext(
      { worktreePath },
      { env: { TEST_SECRET_TOKEN: 'sec-xyz-999' } },
    );
    const output = await executeLocalCommandStep(probeCmd, { body: 'hello-stdin' }, ctx);

    expect(output.cwd).toBe(path.resolve(worktreePath));
    expect(output.stdin).toBe('hello-stdin');
    expect(output.env['STATIC_FLAG']).toBe('enabled');
    expect(output.env['SECRET_TOKEN']).toBe('sec-xyz-999');
    expect(output.env['GIT_CEILING_DIRECTORIES']).toBe(path.dirname(path.resolve(worktreePath)));
    expect(output.env['GIT_CONFIG_NOSYSTEM']).toBe('1');
    expect(output.env['GIT_OPTIONAL_LOCKS']).toBe('0');
    expect(output.env['GIT_TERMINAL_PROMPT']).toBe('0');
    expect(output.env['GIT_CONFIG_COUNT']).toBe('2');
    expect(output.env['GIT_CONFIG_KEY_0']).toBe('commit.gpgsign');
    expect(output.env['GIT_CONFIG_VALUE_0']).toBe('false');
    expect(output.env['GIT_CONFIG_KEY_1']).toBe('core.hooksPath');
    expect(output.env['GIT_CONFIG_VALUE_1']).toBe('/dev/null');
  });

  it('enforces stdin: closed so subprocesses reading stdin receive immediate EOF without hanging', async () => {
    const cmd = local
      .command('closed-stdin-check')
      .stdin('closed')
      .output(z.object({ stdin: z.string() }).passthrough())
      .argv(buildEnvAndStdinProbeArgv())
      .toAST();
    const ctx = createTestStepContext({});
    const res = await executeLocalCommandStep(cmd, undefined, ctx);
    expect(res.stdin).toBe('');
  });

  it('terminates detached process group on AbortSignal and removes abort listener in finally (Rule 5.3)', async () => {
    const controller = new AbortController();
    const sleepCmd = local
      .command('abortable-sleep')
      .argv([
        process.execPath,
        '-e',
        'process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 1000);',
      ])
      .toAST();
    const ctx = createTestStepContext({}, { signal: controller.signal });

    const runPromise = executeLocalCommandStep(sleepCmd, undefined, ctx);
    setImmediate(() => controller.abort());
    await expect(runPromise).rejects.toThrow(/aborted by AbortSignal/i);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('skips main command execution when .unrepeatable(preCheckCmd, { key }) pre-check returns true', async () => {
    let mainInvocations = 0;
    let preCheckState = true;
    const inputSchema = z.object({ ref: z.string() });

    const preCheckCmd = local
      .command('check-existing')
      .input(inputSchema)
      .output(z.boolean())
      .argv(() => [
        process.execPath,
        '-e',
        `console.log(${JSON.stringify(preCheckState)});`,
      ]);

    const publishCmd = local
      .command('publish-pr')
      .input(inputSchema)
      .output(z.string().optional())
      .argv(({ ref }) => {
        mainInvocations += 1;
        return [process.execPath, '-e', `console.log(${JSON.stringify(`published:${ref}`)});`];
      })
      .unrepeatable(preCheckCmd, { key: ({ ref }) => ref })
      .toAST();

    const ctx = createTestStepContext({});
    const skippedResult = await executeLocalCommandStep(publishCmd, { ref: 'PR-1' }, ctx);
    expect(skippedResult).toBeUndefined();
    expect(mainInvocations).toBe(0);

    preCheckState = false;
    const executedNode = local
      .command('publish-pr-run')
      .input(inputSchema)
      .output(z.string().optional())
      .argv(({ ref }) => {
        mainInvocations += 1;
        return [process.execPath, '-e', `console.log(${JSON.stringify(`published:${ref}`)});`];
      })
      .unrepeatable(
        local
          .command('check-existing-false')
          .input(inputSchema)
          .output(z.boolean())
          .argv(() => [process.execPath, '-e', 'console.log(false);']),
        { key: ({ ref }) => ref },
      )
      .toAST();

    const executedResult = await executeLocalCommandStep(executedNode, { ref: 'PR-2' }, ctx);
    expect(executedResult).toBe('published:PR-2');
    expect(mainInvocations).toBe(1);

    let preCheckRunsOnEmptyKey = 0;
    const emptyKeyCmd = local
      .command('publish-empty-key')
      .argv(() => [process.execPath, '-e', 'console.log("ok");'])
      .stdin((val: { readonly ref: string }) => val.ref)
      .unrepeatable(
        local
          .command('precheck-should-not-run')
          .output(z.boolean())
          .argv(() => {
            preCheckRunsOnEmptyKey += 1;
            return [process.execPath, '-e', 'console.log(true);'];
          }),
        { key: ({ ref }: { readonly ref: string }) => ref },
      )
      .input(inputSchema)
      .output(z.string().optional())
      .toAST();

    expect(emptyKeyCmd.stdinMode).not.toBe('closed');
    expect(emptyKeyCmd.unrepeatable).toBeDefined();
    await expect(executeLocalCommandStep(emptyKeyCmd, { ref: '   ' }, ctx)).rejects.toThrow(
      /empty unrepeatable idempotency key/i,
    );
    expect(preCheckRunsOnEmptyKey).toBe(0);
  });

  it('reaps surviving background descendant processes across process groups in terminateProcessGroupWithGrace', async () => {
    const resolvedEnv = resolveWorktreeEnvAndCwd({}, undefined, (v) =>
      typeof v === 'string' ? v : undefined,
    );
    const leader = spawnDetachedSubprocess({
      argv: [
        process.execPath,
        '-e',
        'const { spawn } = require("node:child_process"); const bg = spawn(process.execPath, ["-e", "process.on(\\"SIGTERM\\", () => {}); setInterval(() => {}, 1000);"], { detached: true, stdio: "ignore" }); console.log(String(bg.pid)); setInterval(() => {}, 1000);',
      ],
      resolvedEnv,
    });
    const bgPid = await new Promise<number>((resolve) => {
      leader.stdout?.on('data', (chunk: Buffer) => {
        const parsed = Number(chunk.toString('utf8').trim());
        if (Number.isInteger(parsed) && parsed > 0) resolve(parsed);
      });
    });
    expect(Number.isInteger(bgPid) && bgPid > 0).toBe(true);

    try {
      await terminateProcessGroupWithGrace(leader);
      let bgAlive = true;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        try {
          process.kill(bgPid, 0);
          await new Promise<void>((r) => setTimeout(r, 5));
        } catch {
          bgAlive = false;
          break;
        }
      }
      expect(bgAlive).toBe(false);
    } finally {
      try {
        process.kill(bgPid, 'SIGKILL');
      } catch {}
    }
  });

  it('throws diagnostic error with exitCode, stdout, and stderr on non-zero exit and supports .asCheck() / .asTool()', async () => {
    const failingBuilder = local
      .command('failing-cmd')
      .argv([
        process.execPath,
        '-e',
        'process.stdout.write("out-msg"); process.stderr.write("err-msg"); process.exit(3);',
      ]);
    const ctx = createTestStepContext({});

    await expect(executeLocalCommandStep(failingBuilder.toAST(), undefined, ctx)).rejects.toThrow(
      /Command 'failing-cmd' exited with code 3\. stdout: out-msg stderr: err-msg/,
    );

    const checkResult = await executeLocalCommandCheck(failingBuilder.asCheck().toAST(), undefined, ctx);
    expect(checkResult.ok).toBe(false);
    expect(checkResult.deficits[0]).toContain("Command 'failing-cmd' exited with code 3");

    const passingBuilder = local
      .command('passing-cmd')
      .argv([process.execPath, '-e', 'console.log(JSON.stringify({ status: "green" }));']);
    const passCheck = await executeLocalCommandCheck(passingBuilder.asCheck().toAST(), undefined, ctx);
    expect(passCheck).toEqual({ ok: true, deficits: [] });

    const toolNode = passingBuilder.asTool().toAST();
    expect(toolNode.type).toBe('node:command-tool');
    expect(toolNode.effectTracking).toBe('subprocess-post-flight');
    expect(toolNode.inputSchema.safeParse({}).success).toBe(true);

    const toolDriver = createLocalCommandToolDriver();
    expect('describeEffects' in toolDriver).toBe(false);
    const toolRes = await toolDriver.execute(toolNode, {}, ctx);
    expect(toolRes).toEqual({ content: '{"status":"green"}' });
  });
});
