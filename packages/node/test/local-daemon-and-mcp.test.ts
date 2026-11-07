import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import {
  createExecutorRegistry,
  z,
  type ActiveRunSummary,
  type HarnessRuntimeController,
  type RunnerPoolASTNode,
  type RuntimeDriverContext,
  type StepExecutionContext,
} from '@harness-dsl/core';
import { describe, expect, it, vi } from 'vitest';
import {
  NodeRunnerDriver,
  allocateDynamicPorts,
  createLocalServiceToolDriver,
  createNodeHttpControlPlaneAdapter,
  createNodeMcpSseAdapter,
  createNodeMcpStdioAdapter,
  evaluateNodeAllowBinariesGuard,
  evaluateNodeDenyNetworkGuard,
  local,
  mcp,
  nodeExecutors,
  sanitizeDaemonScopeKey,
  startLocalDaemonService,
} from '../src/index.js';
import { ACTIVE_LEASED_DAEMON_PORTS } from '../src/executors/node-subprocess-env.constants.js';
import {
  buildSampleInteractiveReplArgv,
  buildSampleTcpDaemonArgv,
} from './fixtures/sample-node-daemons.js';

interface DriverAndStepContexts {
  readonly driverCtx: RuntimeDriverContext;
  readonly createStepCtx: (
    sessions: ReadonlyMap<string, Awaited<ReturnType<typeof startLocalDaemonService>>>,
  ) => StepExecutionContext;
}

function createDriverAndStepContexts(): DriverAndStepContexts {
  const drivers = new Map<string, NodeRunnerDriver>();
  const registry = createExecutorRegistry(nodeExecutors);
  const driverCtx: RuntimeDriverContext = {
    registry,
    resolveEnv(val) {
      return typeof val === 'string' ? val : undefined;
    },
    getRunner(node: RunnerPoolASTNode) {
      const existing = drivers.get(node.id);
      if (existing !== undefined) return existing;
      const created = new NodeRunnerDriver({
        type: 'node:runner',
        id: node.id,
        slots: node.slots,
        maxDaemons: node.maxDaemons,
      });
      drivers.set(node.id, created);
      return created;
    },
  };
  return {
    driverCtx,
    createStepCtx(sessions) {
      return {
        runId: 'run-daemon-test',
        stepExecId: 'step-daemon-1',
        scopeHandle: { worktreePath: process.cwd() },
        activeServiceSessions: sessions,
        activePartitions: ['db'],
        activeLeases: [],
        observedEffects: [],
        registry,
        resolveEnv: (v) => driverCtx.resolveEnv(v),
        getRunner: (n) => driverCtx.getRunner(n),
        recordEffects() {},
      };
    },
  };
}

describe('sanitizeDaemonScopeKey, local.daemon lifecycle, PTY framed turns, guards & MCP control planes', () => {
  it('sanitizes scope keys with a deterministic 8-hex SHA-256 suffix so run#1 and run_1 never collide', () => {
    const keyA = sanitizeDaemonScopeKey('run#1:root');
    const keyB = sanitizeDaemonScopeKey('run_1:root');
    expect(keyA).toMatch(/^run_1_root-[0-9a-f]{8}$/);
    expect(keyB).toMatch(/^run_1_root-[0-9a-f]{8}$/);
    expect(keyA).not.toBe(keyB);
    expect(sanitizeDaemonScopeKey('run#1:root')).toBe(keyA);
  });

  it('executes pre-start .stopCommand(), allocates dynamic ports, verifies readyWhenStdout + TCP readiness, and runs serialized PTY turns without echo', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-node-daemon-'));
    try {
      const markerFile = path.join(tmpDir, 'stop-markers.log');
      const runner = local.runner({ slots: 2, maxDaemons: 2 });

      const daemonBuilder = local
        .daemon('local-pg')
        .runner(runner)
        .lifecycle('skill')
        .port('pgPort')
        .port('adminPort')
        .start(({ ports, scopeKey }) =>
          buildSampleTcpDaemonArgv(
            [ports['pgPort'] ?? 0, ports['adminPort'] ?? 0],
            `listening on IPv4 address "0.0.0.0", scope=${scopeKey}\ndatabase system is ready to accept connections`,
          ),
        )
        .stopCommand(({ scopeKey }) => [
          process.execPath,
          '-e',
          `require("node:fs").appendFileSync(${JSON.stringify(markerFile)}, ${JSON.stringify(`stop:${scopeKey}\n`)});`,
        ])
        .readyWhenStdout(
          /listening on IPv4 address "0\.0\.0\.0"[\s\S]*database system is ready to accept connections/g,
        )
        .interact('psql', {
          command: () => buildSampleInteractiveReplArgv('postgres=# '),
          frameDelimiter: /postgres[=>\-#][#>]\s*$/g,
          idleSettleMs: 10,
          timeoutSeconds: 2,
        })
        .interact('hang-tool', {
          command: () => buildSampleInteractiveReplArgv('cdp> '),
          frameDelimiter: /cdp>\s*$/,
          idleSettleMs: 10,
          timeoutSeconds: 0.05,
        })
        .interact('crash-tool', {
          command: () => [
            process.execPath,
            '-e',
            'process.stdout.write("partial"); process.exit(2);',
          ],
          frameDelimiter: /never-matches>\s*$/,
          idleSettleMs: 10,
          timeoutSeconds: 5,
        });

      const serviceNode = daemonBuilder.toAST();
      expect(serviceNode.toolSchemas).toHaveLength(3);
      expect(serviceNode.toolSchemas[0]?.name).toBe('psql');
      expect(serviceNode.toolSchemas[0]?.description).toBe('Interact with service via psql');
      expect(
        serviceNode.toolSchemas[0]?.inputSchema.safeParse({ input: 'SELECT 1;' }).success,
      ).toBe(true);

      const { driverCtx, createStepCtx } = createDriverAndStepContexts();
      const session = await startLocalDaemonService<unknown>(
        serviceNode,
        { runId: 'run#1', scopeKey: 'run#1:root', scopeHandle: { worktreePath: process.cwd() } },
        driverCtx,
      );

      try {
        const preStartLog = fs.readFileSync(markerFile, 'utf8');
        expect(preStartLog).toContain(`stop:${sanitizeDaemonScopeKey('run#1:root')}`);

        const sessionsMap = new Map([[serviceNode.id, session]]);
        const stepCtx = createStepCtx(sessionsMap);
        const serviceToolDriver = createLocalServiceToolDriver();
        expect('describeEffects' in serviceToolDriver).toBe(false);

        const psqlToolNode = session.tools[0];
        if (psqlToolNode === undefined || psqlToolNode.type !== 'node:service-tool') {
          throw new Error('Missing psql tool node');
        }
        expect(psqlToolNode.type).toBe('node:service-tool');
        expect(psqlToolNode.effectTracking).toBe('subprocess-post-flight');

        const ttyTurn = await serviceToolDriver.execute(psqlToolNode, { input: 'IS_TTY' }, stepCtx);
        expect(ttyTurn.content).toBe('STDIN_TTY=true:STDOUT_TTY=true');

        const [turn1, turn2] = await Promise.all([
          serviceToolDriver.execute(psqlToolNode, { input: 'DELAY:15:first_query' }, stepCtx),
          serviceToolDriver.execute(psqlToolNode, { input: 'second_query' }, stepCtx),
        ]);

        expect(turn1.content).toBe('DELAYED:first_query');
        expect(turn1.content).not.toContain('DELAY:15:first_query');
        expect(turn2.content).toBe('OUT:SECOND_QUERY');
        expect(turn2.content).not.toContain('second_query');

        await expect(
          session.invokeTool('hang-tool', { input: 'HANG' }, stepCtx),
        ).rejects.toThrow(/timed out after 0\.05s/i);

        const crashStart = Date.now();
        await expect(
          session.invokeTool('crash-tool', { input: 'CRASH' }, stepCtx),
        ).rejects.toThrow(/exited prematurely/i);
        expect(Date.now() - crashStart).toBeLessThan(1_000);
      } finally {
        await session.stop();
      }

      const postStopLog = fs.readFileSync(markerFile, 'utf8').trim().split('\n');
      expect(postStopLog).toHaveLength(2);

      const failingDaemonMarker = path.join(tmpDir, 'failed-boot-stop.log');
      const failingDaemon = local
        .daemon('failing-daemon')
        .port('failPort')
        .start(() => [
          process.execPath,
          '-e',
          'process.stderr.write("boot crash"); process.exit(1);',
        ])
        .stopCommand(({ scopeKey }) => [
          process.execPath,
          '-e',
          `require("node:fs").appendFileSync(${JSON.stringify(failingDaemonMarker)}, ${JSON.stringify(`cleanup:${scopeKey}\n`)});`,
        ])
        .readyWhenStdout(/never-ready/)
        .toAST();

      await expect(
        startLocalDaemonService(
          failingDaemon,
          {
            runId: 'run-fail',
            scopeKey: 'run-fail:root',
            scopeHandle: { worktreePath: process.cwd() },
          },
          driverCtx,
        ),
      ).rejects.toThrow(/exited prematurely/i);
      const failStopEntries = fs.readFileSync(failingDaemonMarker, 'utf8').trim().split('\n');
      expect(failStopEntries).toHaveLength(2);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('evaluates local.allowBinaries and local.denyNetwork policy guards accurately', () => {
    const allowGuard = local.allowBinaries(['pnpm', 'git']).toAST();
    const ctx = createDriverAndStepContexts().createStepCtx(new Map());

    const allowedEval = evaluateNodeAllowBinariesGuard(
      allowGuard,
      {
        toolName: 'exec',
        proposedEffects: [
          { kind: 'node:process', attributes: { binary: '/usr/local/bin/pnpm' } },
          { kind: 'node:process', attributes: { argv: ['git', 'status'] } },
        ],
        activeLeases: [],
      },
      ctx,
    );
    expect(allowedEval).toEqual({
      allowed: true,
      violatedEffects: [],
      violationSummary: '',
    });

    const deniedBinaryEffect = {
      kind: 'node:process',
      attributes: { binary: '/usr/bin/curl' },
    };
    const deniedEval = evaluateNodeAllowBinariesGuard(
      allowGuard,
      {
        toolName: 'exec',
        proposedEffects: [deniedBinaryEffect],
        activeLeases: [],
      },
      ctx,
    );
    expect(deniedEval.allowed).toBe(false);
    expect(deniedEval.violatedEffects).toEqual([deniedBinaryEffect]);
    expect(deniedEval.violationSummary).toContain('/usr/bin/curl');

    const denyNetNode = local.denyNetwork().toAST();
    const netEffect = {
      kind: 'node:network',
      attributes: { url: 'https://example.com' },
    };
    const netEval = evaluateNodeDenyNetworkGuard(
      denyNetNode,
      {
        toolName: 'fetch',
        proposedEffects: [netEffect],
        activeLeases: [],
      },
      ctx,
    );
    expect(netEval.allowed).toBe(false);
    expect(netEval.violatedEffects).toEqual([netEffect]);
    expect(netEval.violationSummary).toContain(
      "denied outbound network access for tool 'fetch'",
    );
  });

  it('starts and closes mcp.server, local.mcpSse, and local.mcpStdio control-plane adapters', async () => {
    const ports = await allocateDynamicPorts(['httpPort', 'ssePort']);
    const httpPort = ports['httpPort'] ?? 0;
    const ssePort = ports['ssePort'] ?? 0;

    const httpNode = mcp.server({ port: httpPort }).toAST();
    const sseNode = local.mcpSse({ port: ssePort }).toAST();
    const stdioNode = local.mcpStdio('custom-stdio').toAST();
    expect(httpNode).toEqual({ type: 'node:http-control-plane', port: httpPort });
    expect(sseNode).toEqual({ type: 'node:mcp-sse', port: ssePort });
    expect(stdioNode).toEqual({ type: 'node:mcp-stdio', serverName: 'custom-stdio' });

    const emittedSignals: Array<{ readonly id: string; readonly payload: unknown }> = [];
    const activeRuns: readonly ActiveRunSummary[] = [
      { runId: 'run-1', laneId: 'engineering', itemKey: '#1', status: 'RUNNING' },
    ];
    const controller: HarnessRuntimeController = {
      async emitSignal(signalId, payload) {
        emittedSignals.push({ id: signalId, payload });
      },
      async getActiveRuns() {
        return activeRuns;
      },
    };

    const httpHandle = await createNodeHttpControlPlaneAdapter(httpNode).start(controller);
    const sseHandle = await createNodeMcpSseAdapter(sseNode).start(controller);
    const stdioHandle = await createNodeMcpStdioAdapter(stdioNode).start(controller);

    try {
      const runsResp = await fetch(`http://127.0.0.1:${String(httpPort)}/runs`);
      const runsJson = z
        .object({ runs: z.array(z.unknown()) })
        .parse(await runsResp.json());
      expect(runsJson.runs).toEqual(activeRuns);

      const sigResp = await fetch(`http://127.0.0.1:${String(httpPort)}/signals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ signalId: 'steer', payload: { note: 'focus on db' } }),
      });
      expect(sigResp.status).toBe(200);
      expect(emittedSignals).toEqual([{ id: 'steer', payload: { note: 'focus on db' } }]);

      const sseClient = new Client({ name: 'test-sse-client', version: '0.1.0' });
      const sseTransport = new SSEClientTransport(
        new URL(`http://127.0.0.1:${String(ssePort)}/sse`),
      );
      await sseClient.connect(sseTransport);
      try {
        const listedTools = await sseClient.listTools();
        const toolNames = listedTools.tools.map((t) => t.name);
        expect(toolNames).toContain('getActiveRuns');
        expect(toolNames).toContain('emitSignal');

        const activeRunsToolResult = await sseClient.callTool({
          name: 'getActiveRuns',
          arguments: {},
        });
        expect(activeRunsToolResult.content).toEqual([
          { type: 'text', text: JSON.stringify({ runs: activeRuns }) },
        ]);

        await sseClient.callTool({
          name: 'emitSignal',
          arguments: { signalId: 'sse-signal', payload: { priority: 'high' } },
        });
        expect(emittedSignals).toEqual([
          { id: 'steer', payload: { note: 'focus on db' } },
          { id: 'sse-signal', payload: { priority: 'high' } },
        ]);
      } finally {
        await sseClient.close();
      }

      const capturedStdout: string[] = [];
      const stdoutLatch: { resolve?: () => void } = {};
      const twoMessagesCaptured = new Promise<void>((resolve) => {
        stdoutLatch.resolve = resolve;
      });
      const writeSpy = vi
        .spyOn(process.stdout, 'write')
        .mockImplementation((chunk: string | Uint8Array): boolean => {
          capturedStdout.push(
            typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'),
          );
          if (capturedStdout.length >= 2) {
            stdoutLatch.resolve?.();
          }
          return true;
        });
      try {
        process.stdin.emit(
          'data',
          'not-valid-json\n{"jsonrpc":"2.0","id":7,"method":"initialize"}\n',
        );
        await twoMessagesCaptured;
      } finally {
        writeSpy.mockRestore();
      }
      expect(capturedStdout.length).toBeGreaterThanOrEqual(2);
      expect(JSON.parse(capturedStdout[0] ?? '{}')).toEqual({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      });
      const initReply = z
        .object({
          jsonrpc: z.string(),
          id: z.number(),
          result: z.object({
            serverInfo: z.object({
              name: z.string(),
              version: z.string(),
            }),
          }),
        })
        .parse(JSON.parse(capturedStdout[1] ?? '{}'));
      expect(initReply.jsonrpc).toBe('2.0');
      expect(initReply.id).toBe(7);
      expect(initReply.result.serverInfo).toEqual({ name: 'custom-stdio', version: '0.1.0' });
    } finally {
      await httpHandle.close();
      await sseHandle.close();
      await stdioHandle.close();
      ACTIVE_LEASED_DAEMON_PORTS.delete(httpPort);
      ACTIVE_LEASED_DAEMON_PORTS.delete(ssePort);
    }
  });
});
