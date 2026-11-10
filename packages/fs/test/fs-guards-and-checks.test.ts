import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  P,
  type PolicyGuardEvaluationInput,
  type PolicyViolation,
  type QuotaTripwireEvaluationInput,
  type StepExecutionContext,
  type ToolEffect,
  createExecutorRegistry,
} from '@paraharness/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type FsToolEffect,
  collectFsTelemetry,
  evaluateFsAllowOnlyGuard,
  evaluateFsBoundaryGuard,
  evaluateFsGlobEffectMatcher,
  evaluateFsProtectGuard,
  evaluateFsQuotaTripwire,
  evaluateFsReadOnlyGuard,
  evaluateFsRequireReadBeforeWriteGuard,
  evaluateFsScopedWriteGuard,
  evaluateFsSecretLiteralsGuard,
  evaluateFsWriteGuard,
  executeFsRegexCheck,
  extractFsViolatedPaths,
  fs,
  fsExecutors,
  violatedPaths,
} from '../src/index.js';
import { compileActiveLeaseWriteMatcher } from '../src/executors/internal/compile-active-lease-write-matcher.js';
import {
  CACHED_ACTIVE_LEASE_WRITE_MATCHERS,
  CACHED_BOUNDARY_GUARD_MATCHERS,
  CACHED_GLOB_OR_EXACT_MATCHERS,
} from '../src/executors/internal/glob-matcher-cache.constants.js';
import type { TempFsWorkspaceHandle } from './fixtures/temp-fs-workspace-handle.js';
import { createTempFsWorkspace } from './fixtures/temp-fs-workspace.js';

function makeWriteEffect(
  paths: readonly string[],
  existingPathsAtBaseRef: readonly string[] = [],
  proposedContent: Readonly<Record<string, string>> = {},
): FsToolEffect {
  return Object.freeze<FsToolEffect>({
    kind: 'fs:effect',
    mutatesScope: true,
    attributes: Object.freeze({
      mode: 'write',
      paths: Object.freeze([...paths]),
      existingPathsAtBaseRef: Object.freeze([...existingPathsAtBaseRef]),
      proposedContent: Object.freeze({ ...proposedContent }),
    }),
  });
}

function makeReadEffect(paths: readonly string[]): FsToolEffect {
  return Object.freeze<FsToolEffect>({
    kind: 'fs:effect',
    mutatesScope: false,
    attributes: Object.freeze({
      mode: 'read',
      paths: Object.freeze([...paths]),
      existingPathsAtBaseRef: undefined,
      proposedContent: undefined,
    }),
  });
}

function makeGuardInput(
  proposedEffects: readonly ToolEffect[],
  activeLeases: PolicyGuardEvaluationInput['activeLeases'] = Object.freeze([]),
): PolicyGuardEvaluationInput {
  return Object.freeze<PolicyGuardEvaluationInput>({
    toolName: 'write_file',
    proposedEffects,
    activeLeases,
  });
}

function createStepContext(
  worktreePath: string,
  observedEffects: readonly ToolEffect[] = Object.freeze([]),
  activePartitions: readonly string[] = Object.freeze(['api']),
  baseRef = 'HEAD',
): StepExecutionContext {
  return Object.freeze<StepExecutionContext>({
    runId: 'run-guard-test',
    stepExecId: 'step-guard-1',
    activePartitions,
    activeLeases: Object.freeze([]),
    observedEffects,
    scopeHandle: Object.freeze({
      worktreePath,
      branchName: 'harness/test',
      baseRef,
      baseBranch: 'main',
    }),
    signal: new AbortController().signal,
    resolveEnv: () => '',
    getRunner: () => {
      throw new Error('Not needed');
    },
    recordEffects: () => {},
    registry: createExecutorRegistry([fsExecutors]),
  });
}

describe('@paraharness/fs guards, matchers, checks, tripwires, and telemetry', () => {
  const workspaces: TempFsWorkspaceHandle[] = [];

  afterEach(async () => {
    while (workspaces.length > 0) {
      const ws = workspaces.pop();
      if (ws !== undefined) await ws.cleanup();
    }
  });

  it('builds partitionMap, inPartition predicate, and boundaryGuard blocking unleased boundary writes', () => {
    const topology = P.topology('repo-topology')
      .store({ type: 'sqlite:topology', uri: ':memory:' })
      .partitions({
        db: { dependsOn: [] },
        api: { dependsOn: ['db'] },
      })
      .toAST();

    const partMap = fs.partitionMap(topology, {
      db: {
        globs: ['packages/db/**'],
        boundaryGlobs: ['packages/db/src/index.ts'],
      },
      api: {
        globs: ['packages/api/**'],
        boundaryGlobs: ['packages/api/src/index.ts'],
      },
    });
    expect(partMap.type).toBe('fs:partition-map');

    const apiPredicate = fs.inPartition(partMap, 'api');
    expect(apiPredicate.partitions).toEqual(['api']);
    expect(apiPredicate.effects).toEqual({
      type: 'fs:match-globs',
      id: 'fs:match-globs:any:packages/api/**',
      globs: ['packages/api/**'],
      mode: 'any',
    });

    const ctx = createStepContext('/tmp/ws');
    const boundaryGuard = fs.boundaryGuard(partMap);
    const mixedEffect = makeWriteEffect([
      'packages/api/src/internal/handler.ts',
      'packages/api/src/index.ts',
    ]);
    const blockedVerdict = evaluateFsBoundaryGuard(boundaryGuard, makeGuardInput([mixedEffect]), ctx);
    expect(blockedVerdict.allowed).toBe(false);
    expect(blockedVerdict.violatedEffects).toEqual([makeWriteEffect(['packages/api/src/index.ts'])]);

    const lease = fs.allowWriteGlobs(['packages/api/src/index.ts']);
    const allowedVerdict = evaluateFsBoundaryGuard(
      boundaryGuard,
      makeGuardInput([mixedEffect], [lease]),
      ctx,
    );
    expect(allowedVerdict.allowed).toBe(true);
    expect(CACHED_BOUNDARY_GUARD_MATCHERS.has(boundaryGuard)).toBe(true);
    expect(CACHED_GLOB_OR_EXACT_MATCHERS.has(partMap.mapping.db.boundaryGlobs)).toBe(true);
    expect(CACHED_GLOB_OR_EXACT_MATCHERS.has(partMap.mapping.api.boundaryGlobs)).toBe(true);
    const leaseMatcher = lease.grantedMatchers[0];
    if (leaseMatcher === undefined || leaseMatcher.type !== 'fs:match-globs') {
      throw new Error('Expected fs:match-globs matcher on lease');
    }
    expect(CACHED_GLOB_OR_EXACT_MATCHERS.has(leaseMatcher.globs)).toBe(true);
    const frozenLeases = Object.freeze([lease]);
    expect(compileActiveLeaseWriteMatcher(frozenLeases)).toBe(
      compileActiveLeaseWriteMatcher(frozenLeases),
    );
    expect(CACHED_ACTIVE_LEASE_WRITE_MATCHERS.has(frozenLeases)).toBe(true);
  });

  it('enforces fs.writeGuard with onlyExistingAtBaseRef and matches bracketed paths via fs.allowWriteGlobs', () => {
    const ctx = createStepContext('/tmp/ws');
    const existingTestGuard = fs.writeGuard({
      denyGlobs: ['**/*.test.ts', '**/*.test.tsx'],
      onlyExistingAtBaseRef: true,
    });

    const newAndExistingTests = makeWriteEffect(
      ['app/users/new.test.tsx', 'app/users/[id]/page.test.tsx'],
      ['app/users/[id]/page.test.tsx'],
    );
    const initialEval = evaluateFsWriteGuard(
      existingTestGuard,
      makeGuardInput([newAndExistingTests]),
      ctx,
    );
    expect(initialEval.allowed).toBe(false);
    expect(initialEval.violatedEffects).toEqual([
      makeWriteEffect(['app/users/[id]/page.test.tsx'], ['app/users/[id]/page.test.tsx']),
    ]);

    const newOnlyEval = evaluateFsWriteGuard(
      existingTestGuard,
      makeGuardInput([makeWriteEffect(['app/users/new.test.tsx'], [])]),
      ctx,
    );
    expect(newOnlyEval.allowed).toBe(true);

    const bracketLease = fs.allowWriteGlobs(['app/users/[id]/page.test.tsx']);
    const firstMatcher = bracketLease.grantedMatchers[0];
    if (firstMatcher === undefined) throw new Error('Expected granted matcher');
    expect(firstMatcher.id).toBe('fs:match-globs:write:app/users/[id]/page.test.tsx');
    expect(
      evaluateFsGlobEffectMatcher(
        firstMatcher,
        makeWriteEffect(['app/users/[id]/page.test.tsx']),
        ctx,
      ),
    ).toBe(true);

    const leasedEval = evaluateFsWriteGuard(
      existingTestGuard,
      makeGuardInput([newAndExistingTests], [bracketLease]),
      ctx,
    );
    expect(leasedEval.allowed).toBe(true);
  });

  it('enforces protect, readOnly, allowOnly, requireReadBeforeWrite, scopedWrite, and secretLiterals guards', () => {
    const topology = P.topology('t2')
      .store({ type: 'sqlite:topology', uri: ':memory:' })
      .partitions({
        db: { dependsOn: [] },
        api: { dependsOn: ['db'] },
      })
      .toAST();
    const partMap = fs.partitionMap(topology, {
      db: { globs: ['packages/db/**'], boundaryGlobs: [] },
      api: { globs: ['packages/api/**'], boundaryGlobs: [] },
    });
    const ctx = createStepContext('/tmp/ws');

    const protectVerdict = evaluateFsProtectGuard(
      fs.protect(['.env', '.harness/**']),
      makeGuardInput([makeWriteEffect(['.harness/config.json'])]),
      ctx,
    );
    expect(protectVerdict.allowed).toBe(false);

    const readOnlyVerdict = evaluateFsReadOnlyGuard(
      fs.readOnly(),
      makeGuardInput([makeWriteEffect(['packages/api/a.ts'])]),
      ctx,
    );
    expect(readOnlyVerdict.allowed).toBe(false);

    const allowOnlyVerdict = evaluateFsAllowOnlyGuard(
      fs.allowOnly(['packages/{api,web}/**', '!packages/api/internal/**']),
      makeGuardInput([
        makeWriteEffect([
          'packages/db/schema.ts',
          'packages/api/internal/secret.ts',
          'packages/web/index.tsx',
        ]),
      ]),
      ctx,
    );
    expect(allowOnlyVerdict.allowed).toBe(false);
    expect(allowOnlyVerdict.violatedEffects).toEqual([
      makeWriteEffect(['packages/db/schema.ts', 'packages/api/internal/secret.ts']),
    ]);

    const rrbwGuard = fs.requireReadBeforeWrite();
    const unreadExisting = makeWriteEffect(
      ['packages/api/existing.ts'],
      ['packages/api/existing.ts'],
    );
    const rrbwDenied = evaluateFsRequireReadBeforeWriteGuard(
      rrbwGuard,
      makeGuardInput([unreadExisting]),
      createStepContext('/tmp/ws', []),
    );
    expect(rrbwDenied.allowed).toBe(false);

    const rrbwAllowed = evaluateFsRequireReadBeforeWriteGuard(
      rrbwGuard,
      makeGuardInput([unreadExisting]),
      createStepContext('/tmp/ws', [makeReadEffect(['packages/api/existing.ts'])]),
    );
    expect(rrbwAllowed.allowed).toBe(true);

    const scopedGuard = fs.scopedWrite(partMap);
    const outOfPartition = evaluateFsScopedWriteGuard(
      scopedGuard,
      makeGuardInput([makeWriteEffect(['packages/db/schema.ts'])]),
      createStepContext('/tmp/ws', [], ['api']),
    );
    expect(outOfPartition.allowed).toBe(false);
    expect(CACHED_GLOB_OR_EXACT_MATCHERS.has(partMap.mapping.api.globs)).toBe(true);
    const inPartition = evaluateFsScopedWriteGuard(
      scopedGuard,
      makeGuardInput([makeWriteEffect(['packages/api/routes.ts'])]),
      createStepContext('/tmp/ws', [], ['api']),
    );
    expect(inPartition.allowed).toBe(true);

    const secretGuard = fs.secretLiterals();
    const fakeSecretToken = `ghp_${'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'}`;
    const secretEffect = makeWriteEffect(['packages/api/config.ts'], [], {
      'packages/api/config.ts': `export const token = "${fakeSecretToken}";`,
    });
    const secretVerdict = evaluateFsSecretLiteralsGuard(
      secretGuard,
      makeGuardInput([secretEffect]),
      ctx,
    );
    expect(secretVerdict.allowed).toBe(false);
  });

  it('evaluates fs.maxFilesMutated, fs.telemetry, and fs.regexCheck strictly over mutated files', async () => {
    const ws = await createTempFsWorkspace({
      files: {
        'packages/api/untouched.ts': "import { sql } from 'drizzle-orm';\n",
        'packages/api/mutated-clean.ts': "import { repo } from '@acme/db';\n",
        'packages/api/mutated-dirty.ts': "import { eq } from 'drizzle-orm';\n",
      },
    });
    workspaces.push(ws);

    const effects: readonly ToolEffect[] = [
      makeReadEffect(['packages/api/untouched.ts']),
      makeWriteEffect(['packages/api/mutated-clean.ts']),
    ];
    const cleanCheckCtx = createStepContext(ws.worktreePath, effects);

    const tripwire = fs.maxFilesMutated(1);
    const notTripped = evaluateFsQuotaTripwire(
      tripwire,
      Object.freeze<QuotaTripwireEvaluationInput>({
        accumulatedEffects: [makeReadEffect(['packages/api/untouched.ts'])],
        newEffects: [makeWriteEffect(['packages/api/mutated-clean.ts'])],
      }),
      cleanCheckCtx,
    );
    expect(notTripped.tripped).toBe(false);

    const twoMutatedEffects: readonly ToolEffect[] = [
      ...effects,
      makeWriteEffect(['packages/api/mutated-dirty.ts']),
    ];
    const dirtyCheckCtx = createStepContext(ws.worktreePath, twoMutatedEffects);
    const tripped = evaluateFsQuotaTripwire(
      tripwire,
      Object.freeze<QuotaTripwireEvaluationInput>({
        accumulatedEffects: effects,
        newEffects: [makeWriteEffect(['packages/api/mutated-dirty.ts'])],
      }),
      dirtyCheckCtx,
    );
    expect(tripped.tripped).toBe(true);

    const checkNode = fs.regexCheck('forbid-drizzle-in-api', {
      targetGlobs: ['packages/api/**/*.ts'],
      forbidPattern: /from\s+['"]drizzle-orm['"]/,
      violationMessage: 'Direct drizzle-orm imports are forbidden in packages/api.',
    });

    const cleanResult = await executeFsRegexCheck(checkNode, undefined, cleanCheckCtx);
    expect(cleanResult.ok).toBe(true);
    expect(cleanResult.deficits).toEqual([]);

    const dirtyResult = await executeFsRegexCheck(checkNode, undefined, dirtyCheckCtx);
    expect(dirtyResult.ok).toBe(false);
    expect(dirtyResult.deficits[0]).toContain('packages/api/mutated-dirty.ts:');

    const telemetry = collectFsTelemetry(fs.telemetry(), twoMutatedEffects, dirtyCheckCtx);
    expect(telemetry).toEqual({
      filesRead: ['packages/api/untouched.ts'],
      filesMutated: ['packages/api/mutated-clean.ts', 'packages/api/mutated-dirty.ts'],
    });

    const gitWs = await createTempFsWorkspace({
      files: {
        'packages/api/untouched.ts': "import { sql } from 'drizzle-orm';\n",
        'packages/api/mutated-clean.ts': "import { repo } from '@acme/db';\n",
        'packages/api/git-dirty.ts': "import { repo } from '@acme/db';\n",
      },
      initGit: true,
    });
    workspaces.push(gitWs);
    await writeFile(
      join(gitWs.rootDir, 'packages/api/git-dirty.ts'),
      "import { eq } from 'drizzle-orm';\n",
      'utf8',
    );

    const gitEmptyEffectsCtx = createStepContext(
      gitWs.worktreePath,
      [],
      ['api'],
      gitWs.baseRef,
    );
    const gitDiffOnlyResult = await executeFsRegexCheck(checkNode, undefined, gitEmptyEffectsCtx);
    expect(gitDiffOnlyResult.ok).toBe(false);
    expect(gitDiffOnlyResult.deficits).toEqual([
      'packages/api/git-dirty.ts: Direct drizzle-orm imports are forbidden in packages/api.',
    ]);

    const gitCombinedCtx = createStepContext(
      gitWs.worktreePath,
      [makeWriteEffect(['packages/api/mutated-clean.ts'])],
      ['api'],
      gitWs.baseRef,
    );
    const gitUnionResult = await executeFsRegexCheck(checkNode, undefined, gitCombinedCtx);
    expect(gitUnionResult.ok).toBe(false);
    expect(gitUnionResult.deficits).toEqual([
      'packages/api/git-dirty.ts: Direct drizzle-orm imports are forbidden in packages/api.',
    ]);
  });

  it('extracts deduplicated first-seen filesystem paths via fs.violatedPaths and ignores non-fs or malformed effects', () => {
    const violation: PolicyViolation = {
      blockedCalls: [],
      violatedEffects: [
        makeWriteEffect(['packages/api/a.test.ts', 'packages/api/b.test.ts']),
        {
          kind: 'billing:effect',
          mutatesScope: true,
          attributes: { paths: ['ignored/non-fs.ts'] },
        },
        {
          kind: 'fs:effect',
          mutatesScope: true,
          attributes: { paths: 'not-an-array' },
        },
        {
          kind: 'fs:effect',
          mutatesScope: true,
        },
        {
          kind: 'fs:effect',
          mutatesScope: true,
          attributes: {
            paths: ['packages/api/b.test.ts', 42, 'packages/db/c.test.ts', 'packages/api/a.test.ts'],
          },
        },
      ],
      violationSummary: 'Write blocked by fs.writeGuard',
    };

    const expectedPaths = [
      'packages/api/a.test.ts',
      'packages/api/b.test.ts',
      'packages/db/c.test.ts',
    ];
    expect(fs.violatedPaths(violation)).toEqual(expectedPaths);
    expect(violatedPaths(violation)).toEqual(expectedPaths);
    expect(extractFsViolatedPaths(violation)).toEqual(expectedPaths);
  });
});
