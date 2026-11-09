import {
  createExecutorRegistry,
  z,
  type RunnerPoolASTNode,
  type StepExecutionContext,
} from '@paraharness/core';
import { describe, expect, it } from 'vitest';
import {
  NodeRunnerDriver,
  createLocalStreamCheckToolDriver,
  executeLocalStreamCheck,
  local,
  nodeExecutors,
} from '../src/index.js';
import { buildFailingStreamSuiteArgv } from './fixtures/sample-node-daemons.js';

function createStreamTestContext(): StepExecutionContext {
  const drivers = new Map<string, NodeRunnerDriver>();
  return {
    runId: 'run-stream-test',
    stepExecId: 'step-stream-1',
    scopeHandle: { worktreePath: process.cwd() },
    activePartitions: ['api'],
    activeLeases: [],
    observedEffects: [],
    registry: createExecutorRegistry(nodeExecutors),
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
    recordEffects() {},
  };
}

describe('local.streamCheck rolling multi-line circuit breaker and post-flight tool projection', () => {
  it('trips circuitBreaker across combined stdout/stderr, captures graceLinesAfterMatch: 25, and kills process group immediately', async () => {
    const runner = local.runner({ slots: 2 });
    const verifySuite = local
      .streamCheck('verify-suite')
      .runner(runner)
      .argv(buildFailingStreamSuiteArgv())
      .circuitBreakWhenStdout(/FAIL\s+packages\/.*?\n\s*●/, {
        graceLinesAfterMatch: 25,
      })
      .timeoutMinutes(5)
      .toAST();

    const ctx = createStreamTestContext();
    const startMs = Date.now();
    const result = await executeLocalStreamCheck(verifySuite, undefined, ctx);
    const elapsedMs = Date.now() - startMs;

    expect(result.ok).toBe(false);
    expect(result.deficits).toHaveLength(1);
    const excerpt = result.deficits[0] ?? '';
    expect(excerpt).toContain('FAIL packages/api/broken.test.ts');
    expect(excerpt).toContain('● broken test case');
    expect(excerpt).toContain('trace-line-1');
    expect(excerpt).toContain('trace-line-25');
    expect(excerpt).not.toContain('trace-line-26');
    expect(elapsedMs).toBeLessThan(1_000);
  });

  it('returns ok: true when streaming subprocess exits 0 without matching circuitBreaker', async () => {
    const passingCheck = local
      .streamCheck('passing-stream')
      .argv([process.execPath, '-e', 'console.log("PASS all 12 suites");'])
      .circuitBreakWhenStdout(/FAIL\s+packages\//, { graceLinesAfterMatch: 10 })
      .toAST();

    const ctx = createStreamTestContext();
    const result = await executeLocalStreamCheck(passingCheck, undefined, ctx);
    expect(result).toEqual({ ok: true, deficits: [] });
  });

  it('projects .asTool() with effectTracking: subprocess-post-flight and omitted describeEffects', async () => {
    const verifyToolBuilder = local
      .streamCheck('verify-suite-tool')
      .argv(buildFailingStreamSuiteArgv())
      .circuitBreakWhenStdout(/FAIL\s+packages\/.*?\n\s*●/, {
        graceLinesAfterMatch: 5,
      })
      .asTool();

    const toolNode = verifyToolBuilder.toAST();
    expect(toolNode.type).toBe('node:stream-check-tool');
    expect(toolNode.effectTracking).toBe('subprocess-post-flight');

    const driver = createLocalStreamCheckToolDriver();
    expect('describeEffects' in driver).toBe(false);

    const ctx = createStreamTestContext();
    const toolResult = await driver.execute(toolNode, {}, ctx);
    expect(toolResult.isError).toBe(true);
    const parsed = z
      .object({
        ok: z.boolean(),
        deficits: z.array(z.string()),
      })
      .parse(JSON.parse(toolResult.content));
    expect(parsed.ok).toBe(false);
    expect(parsed.deficits[0]).toContain('trace-line-5');
    expect(parsed.deficits[0]).not.toContain('trace-line-6');
  });

  it('counts graceLinesAfterMatch accurately when the circuit-breaker regex match itself ends with a newline', async () => {
    const newlineEndingCheck = local
      .streamCheck('verify-newline-ending-regex')
      .argv(buildFailingStreamSuiteArgv())
      .circuitBreakWhenStdout(/FAIL\s+packages\/.*?\n/, {
        graceLinesAfterMatch: 2,
      })
      .toAST();

    const ctx = createStreamTestContext();
    const result = await executeLocalStreamCheck(newlineEndingCheck, undefined, ctx);
    expect(result.ok).toBe(false);
    const excerpt = result.deficits[0] ?? '';
    expect(excerpt).toContain('FAIL packages/api/broken.test.ts');
    expect(excerpt).toContain('● broken test case');
    expect(excerpt).toContain('trace-line-1');
    expect(excerpt).not.toContain('trace-line-2');
  });

  it('defaults graceLinesAfterMatch to 25 when options are omitted on circuitBreakWhenStdout', () => {
    const shorthand = local
      .streamCheck('default-grace-check')
      .argv(['pnpm', 'test'])
      .circuitBreakWhenStdout(/FAIL\s+packages\//);
    const explicit = local
      .streamCheck('default-grace-check')
      .argv(['pnpm', 'test'])
      .circuitBreakWhenStdout(/FAIL\s+packages\//, { graceLinesAfterMatch: 25 });

    expect(shorthand.toAST()).toEqual(explicit.toAST());
    expect(shorthand.toAST().circuitBreaker?.graceLinesAfterMatch).toBe(25);
  });
});

