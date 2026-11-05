# Milestone 1 (`M1`): Monorepo Bootstrap & `@harness-dsl/core` Contracts, Schemas, AST & Fluent Builders

## 1. Scope & Package Directory

- **Milestone Wave:** Sequential Core Spine (`b`) — Wave 1a (Contracts, Schemas, AST & Builders)
- **Owned Files & Directories:**
  - Root workspace configuration: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`
  - Package manifests and TypeScript configs pre-created for all 14 workspace packages so Wave 1b (`M2`), Wave 2 (`M3a..M3f`), and Wave 3 (`M4`) builders never mutate `pnpm-lock.yaml` or root configs:
    - `packages/core/package.json`, `packages/core/tsconfig.json`
    - `packages/sqlite/package.json`, `packages/sqlite/tsconfig.json`
    - `packages/postgres/package.json`, `packages/postgres/tsconfig.json`
    - `packages/fs/package.json`, `packages/fs/tsconfig.json`
    - `packages/markdown/package.json`, `packages/markdown/tsconfig.json`
    - `packages/node/package.json`, `packages/node/tsconfig.json`
    - `packages/git/package.json`, `packages/git/tsconfig.json`
    - `packages/claude/package.json`, `packages/claude/tsconfig.json`
    - `packages/openai/package.json`, `packages/openai/tsconfig.json`
    - `packages/github/package.json`, `packages/github/tsconfig.json`
    - `packages/slack/package.json`, `packages/slack/tsconfig.json`
    - `packages/stripe/package.json`, `packages/stripe/tsconfig.json`
    - `packages/netsuite/package.json`, `packages/netsuite/tsconfig.json`
    - `packages/integration/package.json`, `packages/integration/tsconfig.json`
  - `@harness-dsl/core` contract, schema, AST, and builder source files:
    - `packages/core/src/ports.ts`
    - `packages/core/src/schemas.ts`
    - `packages/core/src/ast.ts`
    - `packages/core/src/json-schema.ts`
    - `packages/core/src/builders.ts`
    - `packages/core/src/runtime/index.ts`
    - `packages/core/src/index.ts`
  - `@harness-dsl/core` contract and builder test suite:
    - `packages/core/test/builders.test.ts`
- **Forbidden Directories:**
  - Do not modify `infra/**`, `.claude/**`, `.agents/**`, `scripts/**`, or `docs/**`.
  - Do not create `src/` or `test/` files inside `packages/sqlite`, `packages/postgres`, `packages/fs`, `packages/markdown`, `packages/node`, `packages/git`, `packages/claude`, `packages/openai`, `packages/github`, `packages/slack`, `packages/stripe`, `packages/netsuite`, or `packages/integration`.

---

## 2. Exact Spec Grounding Table

Read the following sections in full before authoring any file in `M1`:

| Document | Section | Line Range | Key Contracts Covered |
| :--- | :--- | :--- | :--- |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §1. Scope, Design Principles & Package Topology | `1–34` | Domain-purity of `@harness-dsl/core`, 6 declarative compilation & serialization invariants |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §2.1–§2.7 Port Interfaces & Data Contracts | `36–869` | All port interfaces (`EnvRef`, `ResolutionContext`, `Source`, `ToolEffect`, `EffectMatcher`, `LeaseDelta`, `PolicyGuard`, `QuotaTripwire`, `TelemetryCollector`, `AbortHook`, `ScopeRewindHook`, `ExecutionContext`, `StepExecutable`, `Check`, `ToolDefinition`, `ServiceSession`, `Service`, `IsolationScope`, `CheckpointableScope`, `BranchableScope`, `CrossVerifier`, `ModelDriver`, `ContinuationFrame`, `SuspendedForkRecord`, `LedgerStore`, `TopologyStore`, `LessonStore`, `TrackerAdapter`, `StreamSource`, `HumanAdapter`, `ControlPlaneAdapter`) |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §3.1–§3.10 `@harness-dsl/core` Primitives | `873–1325` | Builder signatures and static AST compilation rules for `H.signal`, `H.interrupt`, `H.stream`, `H.pool`, `H.prefixGroup`, `H.topology`, `H.rules`, `H.scopedRule`, `H.skill`, `H.lessons`, `H.policy`, `H.human`, `H.agent`, `H.loop`, `H.flow`, `H.lane`, `H.harness` |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §5. Non-Coding Financial Harness Example | `1438–1547` | End-to-end builder chain usage for `H.policy`, `H.agent`, `H.flow` over Tier-1 `IsolationScope` |
| [`docs/CODING_SAMPLE.md`](file:///Users/torniketsomaia/projects/metaharness/docs/CODING_SAMPLE.md) | §6. Complete Production Implementation (`engineering-harness.ts`) | `176–1208` | Full builder surface exercised by `acme-engineering` across all 17 `H.*` primitives and schema factories |

---

## 3. File-by-File Architecture & Exported Symbols

### 3.1 Workspace Configuration Files

1. **Root `package.json`:**
   - Preserve existing `name`, `private`, `version`, `engines`, and existing `scripts` (`explore`, `lesson`, `grounding`, `last-messages`).
   - Update `"packageManager"` to `"pnpm@10.34.9"` (matching the local Corepack cache).
   - Add root workspace scripts `"typecheck": "pnpm -r typecheck"`, `"test": "pnpm -r test"`, and `"check:comments"` (implemented via an inline zero-comment Node.js script using `typescript`'s `ts.createScanner` to scan all `packages/**/*.{ts,tsx,js,mjs}` files and exit with code `1` if any `SingleLineCommentTrivia` or `MultiLineCommentTrivia` token is found):

```json
{
  "name": "wg-monorepo",
  "private": true,
  "version": "0.1.0",
  "packageManager": "pnpm@10.34.9",
  "engines": {
    "node": ">=22.0.0",
    "pnpm": ">=10.0.0"
  },
  "scripts": {
    "explore": "bash infra/scripts/explore.sh",
    "lesson": "bash .claude/scripts/lesson.sh",
    "grounding": "node .claude/scripts/grounding.mjs",
    "last-messages": "node .claude/hooks/last-messages.mjs",
    "typecheck": "pnpm -r typecheck",
    "test": "pnpm -r test",
    "check:comments": "node -e \"const fs=require('node:fs'),path=require('node:path'),ts=require('typescript');const walk=(d)=>fs.existsSync(d)?fs.readdirSync(d,{withFileTypes:true}).flatMap((e)=>{const p=path.join(d,e.name);return e.isDirectory()?walk(p):/\\.(ts|tsx|js|mjs)$/.test(e.name)?[p]:[];}):[];const bad=[];for(const f of walk('packages')){const src=fs.readFileSync(f,'utf8');const sc=ts.createScanner(ts.ScriptTarget.Latest,false,ts.LanguageVariant.Standard,src);let tok;while((tok=sc.scan())!==ts.SyntaxKind.EndOfFileToken){if(tok===ts.SyntaxKind.SingleLineCommentTrivia||tok===ts.SyntaxKind.MultiLineCommentTrivia){bad.push(f+':'+sc.getTokenPos());break;}}}if(bad.length){console.error('Comments found:',bad.join(', '));process.exit(1);}\""
  },
  "dependencies": {
    "better-sqlite3": "^12.11.1",
    "picomatch": "^4.0.2",
    "zod": "^3.24.2"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^9.6.0",
    "@types/node": "^22.9.0",
    "@types/picomatch": "^4.0.2",
    "typescript": "^5.8.2",
    "vitest": "^3.2.0"
  }
}
```

2. **`pnpm-workspace.yaml`:**

```yaml
packages:
  - packages/*
```

3. **`tsconfig.base.json`:**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2023"],
    "strict": true,
    "exactOptionalPropertyTypes": false,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "baseUrl": ".",
    "paths": {
      "@harness-dsl/core": ["packages/core/src/index.ts"],
      "@harness-dsl/sqlite": ["packages/sqlite/src/index.ts"],
      "@harness-dsl/postgres": ["packages/postgres/src/index.ts"],
      "@harness-dsl/fs": ["packages/fs/src/index.ts"],
      "@harness-dsl/markdown": ["packages/markdown/src/index.ts"],
      "@harness-dsl/node": ["packages/node/src/index.ts"],
      "@harness-dsl/git": ["packages/git/src/index.ts"],
      "@harness-dsl/claude": ["packages/claude/src/index.ts"],
      "@harness-dsl/openai": ["packages/openai/src/index.ts"],
      "@harness-dsl/github": ["packages/github/src/index.ts"],
      "@harness-dsl/slack": ["packages/slack/src/index.ts"],
      "@harness-dsl/stripe": ["packages/stripe/src/index.ts"],
      "@harness-dsl/netsuite": ["packages/netsuite/src/index.ts"]
    }
  }
}
```

4. **Each `packages/<pkg>/package.json` (14 packages total):**
   - `"name": "@harness-dsl/<pkg>"`, `"version": "0.1.0"`, `"private": true`, `"type": "module"`.
   - `"exports": { ".": "./src/index.ts" }`, `"main": "./src/index.ts"`, `"types": "./src/index.ts"`.
   - `"scripts": { "typecheck": "tsc --noEmit", "test": "vitest run" }`.
   - Complete per-package `"dependencies"` and `"devDependencies"` table across all 14 packages:

| Package | `dependencies` | `devDependencies` |
| :--- | :--- | :--- |
| `@harness-dsl/core` | `"zod": "^3.24.2"` | `"@types/node": "^22.9.0"`, `"typescript": "^5.8.2"`, `"vitest": "^3.2.0"` |
| `@harness-dsl/sqlite` | `"@harness-dsl/core": "workspace:*"`, `"better-sqlite3": "^12.11.1"`, `"zod": "^3.24.2"` | `"@types/better-sqlite3": "^9.6.0"`, `"@types/node": "^22.9.0"`, `"typescript": "^5.8.2"`, `"vitest": "^3.2.0"` |
| `@harness-dsl/postgres` | `"@harness-dsl/core": "workspace:*"`, `"zod": "^3.24.2"` | `"@types/node": "^22.9.0"`, `"typescript": "^5.8.2"`, `"vitest": "^3.2.0"` |
| `@harness-dsl/fs` | `"@harness-dsl/core": "workspace:*"`, `"picomatch": "^4.0.2"`, `"zod": "^3.24.2"` | `"@types/node": "^22.9.0"`, `"@types/picomatch": "^4.0.2"`, `"typescript": "^5.8.2"`, `"vitest": "^3.2.0"` |
| `@harness-dsl/markdown` | `"@harness-dsl/core": "workspace:*"`, `"@harness-dsl/fs": "workspace:*"`, `"picomatch": "^4.0.2"`, `"zod": "^3.24.2"` | `"@types/node": "^22.9.0"`, `"@types/picomatch": "^4.0.2"`, `"typescript": "^5.8.2"`, `"vitest": "^3.2.0"` |
| `@harness-dsl/node` | `"@harness-dsl/core": "workspace:*"`, `"zod": "^3.24.2"` | `"@types/node": "^22.9.0"`, `"typescript": "^5.8.2"`, `"vitest": "^3.2.0"` |
| `@harness-dsl/git` | `"@harness-dsl/core": "workspace:*"`, `"picomatch": "^4.0.2"`, `"zod": "^3.24.2"` | `"@types/node": "^22.9.0"`, `"@types/picomatch": "^4.0.2"`, `"typescript": "^5.8.2"`, `"vitest": "^3.2.0"` |
| `@harness-dsl/claude` | `"@harness-dsl/core": "workspace:*"`, `"zod": "^3.24.2"` | `"@types/node": "^22.9.0"`, `"typescript": "^5.8.2"`, `"vitest": "^3.2.0"` |
| `@harness-dsl/openai` | `"@harness-dsl/core": "workspace:*"`, `"zod": "^3.24.2"` | `"@types/node": "^22.9.0"`, `"typescript": "^5.8.2"`, `"vitest": "^3.2.0"` |
| `@harness-dsl/github` | `"@harness-dsl/core": "workspace:*"`, `"zod": "^3.24.2"` | `"@types/node": "^22.9.0"`, `"typescript": "^5.8.2"`, `"vitest": "^3.2.0"` |
| `@harness-dsl/slack` | `"@harness-dsl/core": "workspace:*"`, `"zod": "^3.24.2"` | `"@types/node": "^22.9.0"`, `"typescript": "^5.8.2"`, `"vitest": "^3.2.0"` |
| `@harness-dsl/stripe` | `"@harness-dsl/core": "workspace:*"`, `"zod": "^3.24.2"` | `"@types/node": "^22.9.0"`, `"typescript": "^5.8.2"`, `"vitest": "^3.2.0"` |
| `@harness-dsl/netsuite` | `"@harness-dsl/core": "workspace:*"`, `"zod": "^3.24.2"` | `"@types/node": "^22.9.0"`, `"typescript": "^5.8.2"`, `"vitest": "^3.2.0"` |
| `@harness-dsl/integration` | `"@harness-dsl/core": "workspace:*"`, `"@harness-dsl/sqlite": "workspace:*"`, `"@harness-dsl/postgres": "workspace:*"`, `"@harness-dsl/fs": "workspace:*"`, `"@harness-dsl/markdown": "workspace:*"`, `"@harness-dsl/node": "workspace:*"`, `"@harness-dsl/git": "workspace:*"`, `"@harness-dsl/claude": "workspace:*"`, `"@harness-dsl/openai": "workspace:*"`, `"@harness-dsl/github": "workspace:*"`, `"@harness-dsl/slack": "workspace:*"`, `"@harness-dsl/stripe": "workspace:*"`, `"@harness-dsl/netsuite": "workspace:*"`, `"zod": "^3.24.2"` | `"@types/node": "^22.9.0"`, `"typescript": "^5.8.2"`, `"vitest": "^3.2.0"` |

5. **Each `packages/<pkg>/tsconfig.json`:**
   - Extends `"../../tsconfig.base.json"`, with `"include": ["src/**/*.ts", "test/**/*.ts"]`.

### 3.2 `packages/core/src/ports.ts`

Exports 100% of `@harness-dsl/core` port interfaces and data contracts from `SPEC.md` §2.1–§2.7 verbatim:

```ts
import { z } from 'zod';

export interface EnvRef {
  readonly kind: 'harness:env-ref';
  readonly key: string;
}

export interface ResolutionContext {
  readonly runId: string;
  readonly activePartitions: readonly string[];
  readonly observedEffects: readonly ToolEffect[];
  readonly scopeHandle?: unknown;
}

export interface Source<T> {
  readonly kind: 'harness:source';
  readonly id: string;
  load(ctx: ResolutionContext): Promise<{
    readonly data: T;
    readonly digest: string;
  }>;
}

export type MaybeSource<T> = T | Source<T>;

export interface ToolEffect {
  readonly kind: string;
  readonly mutatesScope?: boolean;
  readonly attributes?: Readonly<Record<string, unknown>>;
}

export interface EffectMatcher {
  readonly kind: 'harness:effect-matcher';
  readonly id: string;
  matches(effect: ToolEffect): boolean;
}

export interface LeaseDelta {
  readonly kind: 'harness:lease-delta';
  readonly id: string;
  readonly grantedMatchers: readonly EffectMatcher[];
}

export interface PolicyGuard {
  readonly kind: 'harness:policy-guard';
  readonly id: string;
  evaluate(op: {
    readonly toolName: string;
    readonly proposedEffects: readonly ToolEffect[];
    readonly activeLeases: readonly LeaseDelta[];
  }): {
    readonly allowed: boolean;
    readonly violatedEffects: readonly ToolEffect[];
    readonly violationSummary: string;
  };
}

export interface QuotaTripwire {
  readonly kind: 'harness:quota-tripwire';
  readonly id: string;
  onToolEffects(
    accumulatedEffects: readonly ToolEffect[],
    newEffects: readonly ToolEffect[],
  ): {
    readonly tripped: boolean;
    readonly reason?: string;
  };
}

export interface TelemetryCollector<TMetrics extends Record<string, unknown> = Record<string, unknown>> {
  readonly kind: 'harness:telemetry-collector';
  readonly id: string;
  readonly schema: z.ZodType<TMetrics, z.ZodTypeDef, any>;
  collect(effects: readonly ToolEffect[]): TMetrics;
}

export interface AbortHook<THandle = any, TAbortMeta extends Record<string, unknown> = Record<string, unknown>> {
  readonly kind: 'harness:abort-hook';
  readonly id: string;
  readonly metaSchema: z.ZodType<TAbortMeta, z.ZodTypeDef, any>;
  execute(handle: THandle, runId: string, stepExecId?: string): Promise<TAbortMeta>;
}

export interface ScopeRewindHook<THandle = any> {
  readonly kind: 'harness:scope-rewind-hook';
  readonly id: string;
  onRewind(handle: THandle, targetCheckpoint?: string): Promise<void>;
}

export interface ExecutionContext<THandle = any> {
  readonly runId: string;
  readonly stepExecId: string;
  readonly scopeHandle: THandle;
  readonly activePartitions: readonly string[];
  readonly activeLeases: readonly LeaseDelta[];
  readonly seededHistory?: readonly WireFrameRecord[];
  readonly resumeContinuationStack?: readonly ContinuationFrame[];
  recordEffects(effects: readonly ToolEffect[]): void;
}

export type StepContext<THandle = any> = ExecutionContext<THandle>;

export interface StepExecutable<TIn = any, TOut = any, THandle = any> {
  readonly kind: 'harness:step-executable';
  readonly id: string;
  readonly inputSchema: z.ZodType<TIn, z.ZodTypeDef, any>;
  readonly outputSchema: z.ZodType<TOut, z.ZodTypeDef, any>;
  extractPartitions?(input: TIn): readonly string[];
  execute(input: TIn, ctx: ExecutionContext<THandle>): Promise<TOut>;
}

export interface Check<THandle = any> {
  readonly kind: 'harness:check';
  readonly id: string;
  run(ctx: {
    readonly scopeHandle: THandle;
    readonly observedEffects: readonly ToolEffect[];
  }): Promise<{
    readonly ok: boolean;
    readonly deficits: readonly string[];
  }>;
}

export interface ToolDefinition<THandle = any> {
  readonly kind: 'harness:tool';
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodTypeAny;
  describeEffects?(args: unknown, scopeHandle: THandle): readonly ToolEffect[] | Promise<readonly ToolEffect[]>;
  execute(args: unknown, ctx: ExecutionContext<THandle>): Promise<{
    readonly content: string;
    readonly isError?: boolean;
  }>;
}

export interface ServiceSession<THandle = any> {
  readonly id: string;
  readonly tools: readonly ToolDefinition<THandle>[];
  stop(): Promise<void>;
}

export interface Service<THandle = any> {
  readonly kind: 'harness:service';
  readonly id: string;
  readonly lifecycle: 'scope' | 'fork' | 'skill';
  readonly toolSchemas: ReadonlyArray<{
    readonly name: string;
    readonly description: string;
    readonly inputSchema: z.ZodTypeAny;
  }>;
  acquire(ctx: {
    readonly runId: string;
    readonly scopeKey: string;
    readonly scopeHandle: THandle;
  }): Promise<ServiceSession<THandle>>;
}

export type ReconcileResult<TData> =
  | {
      readonly status: 'clean';
      readonly data: TData;
    }
  | {
      readonly status: 'conflict';
      readonly conflictedSummary: string;
      readonly conflictedPaths?: readonly string[];
      readonly data: TData;
    };

export interface IsolationScope<
  THandle = any,
  TReceipt extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly kind: 'harness:isolation-scope';
  readonly id: string;
  readonly receiptSchema: z.ZodType<TReceipt, z.ZodTypeDef, any>;
  acquireRoot(runId: string): Promise<THandle>;
  reattachRoot(runId: string, checkpoint?: string): Promise<THandle>;
  inspect(handle: THandle): Promise<TReceipt>;
  release(handle: THandle): Promise<void>;
}

export interface CheckpointableScope<
  THandle = any,
  TReceipt extends Record<string, unknown> = Record<string, unknown>,
> extends IsolationScope<THandle, TReceipt> {
  readonly supportsCheckpoints: true;
  serializeCheckpoint(handle: THandle): Promise<string>;
  restoreCheckpoint(handle: THandle, checkpoint: string): Promise<void>;
  diffEffects(fromCheckpoint: string, handle: THandle): Promise<readonly ToolEffect[]>;
}

export interface BranchableScope<
  THandle = any,
  TReceipt extends Record<string, unknown> = Record<string, unknown>,
  TSync extends Record<string, unknown> = Record<string, unknown>,
> extends IsolationScope<THandle, TReceipt> {
  readonly supportsBranching: true;
  readonly syncSchema: z.ZodType<TSync, z.ZodTypeDef, any>;
  forkChild(parent: THandle, forkId: string): Promise<THandle>;
  reattachChild(parent: THandle, forkId: string, checkpoint?: string): Promise<THandle>;
  commitChild(child: THandle, parent: THandle): Promise<ReconcileResult<TReceipt>>;
  syncChild(parent: THandle, pausedChild: THandle): Promise<ReconcileResult<TSync>>;
  syncRoot(rootHandle: THandle, prerequisiteReceipts: readonly TReceipt[]): Promise<ReconcileResult<TSync>>;
  conflictCleanCheck?: Check<THandle>;
}

export interface CrossVerifier<
  THandle = any,
  TReceipt extends Record<string, unknown> = Record<string, unknown>,
  TCrossReport = unknown,
> {
  readonly kind: 'harness:cross-verifier';
  readonly reportSchema: z.ZodType<TCrossReport, z.ZodTypeDef, any>;
  verifyCandidates(
    candidates: ReadonlyArray<{
      readonly branchIndex: number;
      readonly scopeHandle: THandle;
      readonly receipt: TReceipt;
    }>,
  ): Promise<ReadonlyArray<TCrossReport>>;
}

export interface PartitionGlobEntry {
  readonly globs: readonly string[];
  readonly boundaryGlobs: readonly string[];
}

export interface PartitionMap<TPartition extends string = string> {
  readonly kind: 'fs:partition-map';
  readonly topologyId: string;
  readonly partitions: Readonly<Record<TPartition, PartitionGlobEntry>>;
  getPartitionForPath(relativePath: string): TPartition | undefined;
  isBoundaryPath(relativePath: string): { readonly isBoundary: boolean; readonly partition?: TPartition };
}

export interface AccountSeatDescriptor {
  readonly kind: 'harness:account-seat' | 'claude:account-seat' | 'openai:account-seat';
  readonly id: string;
  readonly configDirPath?: string;
  readonly apiKeyRef?: EnvRef | string;
}

export interface ModelDescriptor {
  readonly kind: 'harness:model';
  readonly alias: string;
  readonly modelId: string;
  readonly driver: ModelDriver;
  readonly accountPoolDef?: unknown;
}

export interface PoolCandidateState<TItem = unknown> {
  readonly item: TItem;
  readonly index: number;
  readonly id: string;
  readonly rateLimitedUntilMs?: number;
  readonly usageCount: number;
  readonly lastUsedAtMs?: number;
  readonly successCount: number;
  readonly sampleCount: number;
  readonly empiricalSuccessRate: number;
}

export interface PoolSelectionContext {
  readonly poolId: string;
  readonly runId: string;
  readonly retryAttempt: number;
  readonly nowMs: number;
  readonly stickyCandidateId?: string;
}

export type PoolSelectorFn<TItem = unknown> = (
  candidates: readonly PoolCandidateState<TItem>[],
  ctx: PoolSelectionContext,
) => TItem | undefined;

export interface PoolStrategyPort<TItem = unknown> {
  readonly kind: 'harness:pool-strategy';
  readonly id: string;
  select(
    candidates: readonly PoolCandidateState<TItem>[],
    ctx: PoolSelectionContext,
  ): TItem | undefined;
}

export interface CanonicalMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly visibleText: string;
  readonly toolCalls?: ReadonlyArray<{ id: string; name: string; argsJson: string }>;
  readonly toolResults?: ReadonlyArray<{ callId: string; content: string; isError: boolean }>;
}

export interface WireFrameRecord {
  readonly messageId: string;
  readonly parentMessageId: string | null;
  readonly vendorId: string;
  readonly rawWireFrame: Uint8Array;
  readonly canonical: CanonicalMessage;
  readonly prefixDigest: string;
  readonly compactedTombstones?: Readonly<Record<string, string>>;
}

export interface WireToolSchema {
  readonly name: string;
  readonly description: string;
  readonly inputJsonSchema: Readonly<Record<string, unknown>>;
}

export interface CompiledWirePrefix {
  readonly prefixGroupId: string;
  readonly toolsMode: 'role-scoped' | 'union';
  readonly systemPromptText: string;
  readonly systemDigest: string;
  readonly groundingSnapshots: ReadonlyArray<{
    readonly sourceId: string;
    readonly text: string;
    readonly digest: string;
  }>;
  readonly wireToolSchemasByRoleKey: Readonly<Record<string, readonly WireToolSchema[]>>;
}

export interface ForkContext {
  readonly historyMode: 'shared-prefix-only' | 'clone-transcript';
  readonly parentChain: readonly WireFrameRecord[];
  readonly forkPointMessageId: string | null;
  readonly wirePrefix?: CompiledWirePrefix;
  readonly roleKey?: string;
  readonly childRoleContextFrameText?: string;
  readonly forkCallId?: string;
  readonly siblingForkCallIds?: readonly string[];
  readonly precedingCompletedResults?: ReadonlyArray<{
    readonly callId: string;
    readonly content: string;
    readonly isError?: boolean;
  }>;
  readonly childTaskPromptText?: string;
}

export interface ModelDriver {
  readonly kind: 'harness:model-driver';
  readonly vendorId: string;
  invokeTurn(req: {
    readonly modelId: string;
    readonly accountConfig?: unknown;
    readonly effort?: 'low' | 'medium' | 'high';
    readonly toolChoice?: 'auto' | 'none';
    readonly wirePrefix?: CompiledWirePrefix;
    readonly roleKey?: string;
    readonly history: readonly WireFrameRecord[];
    readonly wireToolSchemas?: readonly WireToolSchema[];
    readonly outputSchema?: z.ZodTypeAny;
  }): Promise<{
    readonly wireFrame: Uint8Array;
    readonly canonical: CanonicalMessage;
    readonly structuredOutput?: unknown;
    readonly usage: {
      readonly inputTokens: number;
      readonly cachedInputTokens: number;
      readonly outputTokens: number;
      readonly costUsd: number;
    };
  }>;
  prepareFork(
    ctx: ForkContext,
    target: {
      readonly modelId: string;
      readonly accountConfig?: unknown;
      readonly effort?: 'low' | 'medium' | 'high';
      readonly substituteTombstones: boolean;
    },
  ): Promise<readonly WireFrameRecord[]>;
  appendToolResultNotes(
    frame: WireFrameRecord,
    notes: readonly string[],
    targetCallId?: string,
    opts?: { readonly isError?: boolean },
  ): Promise<WireFrameRecord>;
}

export interface UniversalStepTelemetry<
  TCustomMetrics extends Record<string, unknown> = Record<string, unknown>,
  TAbortMeta extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly turnsTaken: number;
  readonly costUsd: number;
  readonly durationMs: number;
  readonly custom: TCustomMetrics;
  readonly abortMeta?: TAbortMeta;
}

export interface PendingPreFlightCall {
  readonly callId: string;
  readonly toolName: string;
  readonly argsJson: string;
  readonly violatedEffects: readonly ToolEffect[];
  readonly violationSummary: string;
}

export interface PendingToolBatch {
  readonly completedResults: ReadonlyArray<{
    readonly callId: string;
    readonly content: string;
    readonly isError?: boolean;
  }>;
  readonly blockedCalls: readonly PendingPreFlightCall[];
  readonly activeInterruptCallId?: string;
  readonly adjudicationFeedback?: string;
  readonly remainingCalls: ReadonlyArray<{
    readonly callId: string;
    readonly toolName: string;
    readonly argsJson: string;
    readonly blockedPreFlight?: boolean;
    readonly adjudicatedClauseIds?: readonly string[];
  }>;
}

export type ContinuationFrame =
  | {
      readonly kind: 'agent-frame';
      readonly agentId: string;
      readonly roleKey: string;
      readonly modelId: string;
      readonly stepExecId: string;
      readonly inputJson: string;
      readonly leafMessageId: string | null;
      readonly turnsTaken: number;
      readonly costUsd: number;
      readonly elapsedDurationMs: number;
      readonly activeLeases: readonly LeaseDelta[];
      readonly activeSkillIds: readonly string[];
      readonly activeSkillActivations: Readonly<Record<string, { readonly messageId: string; readonly callId: string }>>;
      readonly observedEffects: readonly ToolEffect[];
      readonly injectedScopedRuleIds: readonly string[];
      readonly pausedAtPhase: 'TOOL_BOUNDARY' | 'BEFORE_STOP_GATE' | 'LIMIT_EXCEEDED_FLUSH';
      readonly limitExceededInterruptId?: string;
      readonly flushedInterruptPayloadJson?: string;
      readonly conflictCheckArmed?: boolean;
      readonly neutralSyncContinuation?: boolean;
      readonly syncedToPrerequisiteCheckpoint?: string;
      readonly pendingToolBatch?: PendingToolBatch;
      readonly inFlightPreToolCheckpoint?: string;
      readonly lastGateFailureJson?: string;
      readonly bufferedGateRecoveries?: ReadonlyArray<unknown>;
      readonly accumulatedLessonOutcomes?: Readonly<Record<string, LessonOutcome>>;
      readonly pendingAdjudication?: {
        readonly interruptId: string;
        readonly interruptPayloadJson: string;
        readonly humanRequestId?: string;
        readonly adjudicatorStack?: readonly ContinuationFrame[];
      };
    }
  | {
      readonly kind: 'loop-frame';
      readonly loopId: string;
      readonly roleKey: string;
      readonly lastActModelId?: string;
      readonly stepExecId: string;
      readonly loopInputJson: string;
      readonly iteration: number;
      readonly phase: 'act' | 'evaluate';
      readonly preservedActLeafMessageId: string | null;
      readonly turnsTaken: number;
      readonly costUsd: number;
      readonly elapsedDurationMs: number;
      readonly actTurnsTaken: number;
      readonly actCostUsd: number;
      readonly actElapsedDurationMs: number;
      readonly grantedLoopLeases: readonly LeaseDelta[];
      readonly activeSkillIds: readonly string[];
      readonly activeSkillActivations: Readonly<Record<string, { readonly messageId: string; readonly callId: string }>>;
      readonly observedEffects: readonly ToolEffect[];
      readonly injectedScopedRuleIds: readonly string[];
      readonly conflictCheckArmed?: boolean;
      readonly recalledLessons: ReadonlyArray<{
        readonly id: string;
        readonly partition?: string;
        readonly directive: string;
      }>;
      readonly lastRejectedIterationJson?: string;
      readonly bufferedGateRecoveries?: ReadonlyArray<unknown>;
      readonly accumulatedLessonOutcomes: Readonly<Record<string, LessonOutcome>>;
    }
  | {
      readonly kind: 'fork-batch-frame';
      readonly parentStepExecId: string;
      readonly pendingPauseTrigger?: {
        readonly triggeredByForkId: string;
        readonly interruptId: string;
        readonly interruptPayloadJson: string;
        readonly affectedPartitions: readonly string[];
      };
      readonly forks: ReadonlyArray<{
        readonly forkId: string;
        readonly suspendedForkId?: string;
        readonly callId: string;
        readonly toolName: string;
        readonly activePartitions: readonly string[];
        readonly status: 'RUNNING' | 'CHILD_COMMITTED' | 'COMPLETED' | 'SUSPENDED' | 'FAILED' | 'ABORTED';
        readonly conflictRetryCount: number;
        readonly conflictCheckArmed: boolean;
        readonly suspensionEpoch: number;
        readonly syncedToParentCheckpoint?: string;
        readonly syncResultJson?: string;
        readonly resumeFrameInjected?: boolean;
        readonly childScopeCheckpoint?: string;
        readonly outputJson?: string;
        readonly committedReceiptJson?: string;
        readonly toolResultJson?: string;
        readonly lessonsFlushed?: boolean;
        readonly continuationStack: readonly ContinuationFrame[];
      }>;
    }
  | {
      readonly kind: 'speculate-frame';
      readonly parentStepExecId: string;
      readonly callId: string;
      readonly toolName: string;
      readonly phase: 'RACING' | 'CROSS_VERIFYING' | 'ARBITRATING' | 'REFINING_WINNER' | 'COMMITTING';
      readonly winnerBranchIndex?: number;
      readonly preRefinementCheckpoint?: string;
      readonly conflictRetryCount: number;
      readonly conflictCheckArmed: boolean;
      readonly lessonsFlushed?: boolean;
      readonly activeSubStack?: readonly ContinuationFrame[];
      readonly branches: ReadonlyArray<{
        readonly branchIndex: number;
        readonly forkId: string;
        readonly status:
          | 'RUNNING'
          | 'COMPLETED'
          | 'FAILED'
          | 'PARKED_ON_ESCALATION'
          | 'WINNER_COMMITTED';
        readonly childScopeCheckpoint?: string;
        readonly outputJson?: string;
        readonly scopeReceiptJson?: string;
        readonly errorSummary?: string;
        readonly parkedInterruptId?: string;
        readonly parkedEscalationPayloadJson?: string;
        readonly continuationStack: readonly ContinuationFrame[];
      }>;
      readonly humanRulingsHistory: ReadonlyArray<{
        readonly branchIndex: number;
        readonly interruptId: string;
        readonly rulingSummary: string;
      }>;
      readonly bufferedLessonOutcomes?: ReadonlyArray<{
        readonly branchIndex: number;
        readonly outcomes: ReadonlyArray<{ readonly lessonId: string; readonly outcome: LessonOutcome }>;
      }>;
    };

export interface SuspendedForkRecord {
  readonly suspendedForkId: string;
  readonly forkId: string;
  readonly suspensionEpoch: number;
  readonly runId: string;
  readonly parentStepExecId: string;
  readonly forkToolName: string;
  readonly activePartitions: readonly string[];
  readonly suspensionReason: 'INTERRUPT_RAISED' | 'PAUSED_BY_SIBLING_INTERRUPT';
  readonly triggeredByForkId?: string;
  readonly raisedByPhase?: 'act' | 'evaluate';
  readonly conflictRetryCount: number;
  readonly conflictCheckArmed: boolean;
  readonly syncedToParentCheckpoint?: string;
  readonly syncResultJson?: string;
  readonly resumeFrameInjected?: boolean;
  readonly interruptId?: string;
  readonly interruptPayloadJson?: string;
  readonly suspendedAtCallId?: string;
  readonly childScopeCheckpoint?: string;
  readonly continuationStack: readonly ContinuationFrame[];
}

export interface LedgerStore {
  readonly kind: 'harness:ledger-store';
  createOrResumeRun(run: {
    readonly runId: string;
    readonly laneId: string;
    readonly itemKey: string;
    readonly inputJson: string;
    readonly compiledPrefixesJson?: Readonly<Record<string, string>>;
    readonly costUsd?: number;
    readonly approvedMaxCostUsd?: number;
  }): Promise<{
    readonly status: string;
    readonly currentStepId: string | null;
    readonly inputJson: string;
    readonly rewindPendingToStepId?: string;
    readonly compiledPrefixesJson?: Readonly<Record<string, string>>;
    readonly costUsd: number;
    readonly approvedMaxCostUsd?: number;
    readonly completedStepOutputsJson: ReadonlyMap<string, string>;
  }>;
  recordStepStart(step: {
    readonly stepExecId: string;
    readonly runId: string;
    readonly stepId: string;
    readonly inputMsgId: string | null;
    readonly baseScopeCheckpoint?: string;
    readonly continuationStack: readonly ContinuationFrame[];
  }): Promise<void>;
  updateContinuationStack(
    runId: string,
    stepExecId: string,
    continuationStack: readonly ContinuationFrame[],
  ): Promise<void>;
  appendMessageFrame(runId: string, frame: WireFrameRecord): Promise<void>;
  replaceMessageFrame(runId: string, frame: WireFrameRecord): Promise<void>;
  markFrameTombstone(
    runId: string,
    messageId: string,
    callId: string,
    compactedTombstone: string,
  ): Promise<void>;
  getMessageChain(leafMessageId: string): Promise<readonly WireFrameRecord[]>;
  recordForkSuspension(record: SuspendedForkRecord): Promise<void>;
  getSuspendedForks(
    runId: string,
    opts?: { readonly forkIds?: readonly string[]; readonly parentStepExecId?: string },
  ): Promise<readonly SuspendedForkRecord[]>;
  resolveSuspendedFork(suspendedForkId: string, status: 'RESUMED' | 'ABORTED'): Promise<void>;
  recordStepTransition(transition: {
    readonly stepExecId: string;
    readonly status: 'COMPLETED' | 'INTERRUPTED' | 'FAILED' | 'SUSPENDED';
    readonly outputJson?: string;
    readonly headScopeCheckpoint?: string;
    readonly telemetryJson: string;
    readonly pendingToolBatch?: PendingToolBatch;
  }): Promise<void>;
  recordRunTerminalReceipt(
    runId: string,
    itemKey: string,
    terminalState: string,
    scopeReceiptJson?: string,
  ): Promise<void>;
  getRunTerminalReceipts(
    itemKeys: readonly string[],
  ): Promise<ReadonlyMap<string, { readonly runId: string; readonly terminalState: string; readonly scopeReceiptJson?: string }>>;
  getInterruptedStepsOnBoot(): Promise<
    ReadonlyArray<{
      readonly runId: string;
      readonly stepExecId: string | null;
      readonly stepId: string | null;
      readonly baseScopeCheckpoint?: string;
      readonly headScopeCheckpoint?: string;
      readonly continuationStack: readonly ContinuationFrame[];
    }>
  >;
  compactRunFrames(runId: string): Promise<void>;
}

export interface CompactionSignalRuleConfig<TPayload = any> {
  readonly signal: {
    readonly kind: 'harness:signal';
    readonly id: string;
    readonly schema: z.ZodType<TPayload, z.ZodTypeDef, any>;
  };
  readonly correlateBy: (sig: TPayload) => string;
  readonly afterGracePeriodHours: number;
}

export interface CompactionRuleConfig {
  readonly signalRules: readonly CompactionSignalRuleConfig<any>[];
  readonly terminalExitRules: ReadonlyArray<{
    readonly states: readonly string[];
    readonly afterGracePeriodHours: number;
  }>;
  readonly retainFailedRunsDays?: number;
}

export interface LedgerCompactionBuilder {
  onSignal<TPayload>(
    signal: {
      readonly kind: 'harness:signal';
      readonly id: string;
      readonly schema: z.ZodType<TPayload, z.ZodTypeDef, any>;
    },
    opts: {
      readonly correlateBy: (sig: TPayload) => string;
      readonly afterGracePeriodHours: number;
    },
  ): LedgerCompactionBuilder;
  onTerminalExit(
    states: readonly string[],
    opts: { readonly afterGracePeriodHours: number },
  ): LedgerCompactionBuilder;
  retainFailedRunsForDays(days: number): LedgerCompactionBuilder;
}

export interface ConfigurableLedgerStore extends LedgerStore {
  readonly compactionConfig?: CompactionRuleConfig;
  compactWhen(configure: ($c: LedgerCompactionBuilder) => LedgerCompactionBuilder): ConfigurableLedgerStore;
  scheduleCompactionDeadline(
    runId: string,
    itemKey: string,
    compactAfterIso: string,
    awaitingMainMergeFromBranch?: string,
  ): Promise<void>;
  processDueCompactions(nowIso?: string): Promise<readonly string[]>;
  close?(): void;
}

export interface TopologyPartitionState {
  readonly partitionId: string;
  readonly epoch: number;
  readonly contractText: string;
  readonly updatedAt: string;
}

export interface TopologyStore {
  readonly kind: 'harness:topology-store';
  getPartitions(runId?: string): Promise<ReadonlyMap<string, TopologyPartitionState>>;
  updateContract(
    runId: string,
    partitionId: string,
    newContractText: string,
    stepExecId?: string,
  ): Promise<{ readonly newEpoch: number }>;
  syncRunOverlays(targetRunId: string, prerequisiteRunIds: readonly string[]): Promise<void>;
  resetRunOverlay(
    runId: string,
    opts?: { readonly scope?: 'step' | 'run'; readonly stepExecId?: string },
  ): Promise<void>;
  sealRunOverlay(runId: string): Promise<void>;
  commitRunOverlay(runId: string): Promise<{
    readonly committedRunIds: readonly string[];
    readonly updatedEpochs: ReadonlyMap<string, number>;
  }>;
  discardRunOverlay(runId: string): Promise<void>;
}

export type LessonOutcome =
  | 'clean_pass'
  | 'gate_rejected_recovered'
  | 'gate_rejected_unrecovered'
  | 'violated';

export interface DistilledLessonCandidate {
  readonly admit: boolean;
  readonly partition?: string;
  readonly directive?: string;
}

export interface LessonRecord {
  readonly id: string;
  readonly partition?: string;
  readonly directive: string;
  readonly epochAtCreation: number;
  readonly createdByRunId?: string;
  readonly recentOutcomes: ReadonlyArray<LessonOutcome>;
  readonly totalCleanPasses: number;
  readonly totalViolated: number;
  readonly relevanceScore?: number;
  readonly signalLastEmittedAt?: Readonly<Record<string, string>>;
}

export interface LessonStore {
  readonly kind: 'harness:lesson-store';
  queryCandidates(req: {
    readonly queryText: string;
    readonly partitions: readonly string[];
  }): Promise<readonly LessonRecord[]>;
  admit(lesson: {
    readonly partition?: string;
    readonly directive: string;
    readonly epochAtCreation: number;
    readonly createdByRunId?: string;
  }): Promise<string>;
  recordOutcomes(
    outcomes: ReadonlyArray<{ readonly lessonId: string; readonly outcome: LessonOutcome }>,
  ): Promise<ReadonlyArray<LessonRecord>>;
  syncCreationEpochsForRuns(
    runIds: readonly string[],
    updatedEpochs: ReadonlyMap<string, number>,
  ): Promise<void>;
  markSignalEmitted(lessonId: string, signalId: string, emittedAt: string): Promise<void>;
  retire(lessonIds: readonly string[]): Promise<void>;
}

export interface TrackerAdapter<TExternal = any, TExternalState extends string = string> {
  readonly kind: 'harness:tracker-adapter';
  poll(): Promise<readonly TExternal[]>;
  setExternalState(itemKey: string, state: TExternalState): Promise<void>;
}

export interface StreamSource<TEvent = any> {
  readonly kind: 'harness:stream-source';
  subscribe(onEvent: (event: TEvent) => Promise<void>): Promise<{ close(): Promise<void> }>;
}

export interface HumanAdapter {
  readonly kind: 'harness:human-adapter';
  notify(message: string): Promise<void>;
  requestDecision<TRequest, TResponse>(req: {
    readonly runId: string;
    readonly requestId: string;
    readonly humanId: string;
    readonly payload: TRequest;
    readonly responseSchema: z.ZodType<TResponse, z.ZodTypeDef, any>;
    readonly keepAliveSeconds?: number;
    readonly signal?: AbortSignal;
  }): Promise<TResponse>;
  cancelDecision?(runId: string, requestId: string): Promise<void>;
}

export interface ControlPlaneAdapter {
  readonly kind: 'harness:control-plane-adapter';
  start(runtime: HarnessRuntimeController): Promise<{ close(): Promise<void> }>;
}

export interface HarnessRuntimeController {
  emitSignal<TPayload>(signalId: string, payload: TPayload): Promise<void>;
  getActiveRuns(): Promise<ReadonlyArray<{ runId: string; laneId: string; itemKey: string; status: string }>>;
}
```

### 3.3 `packages/core/src/schemas.ts`

Exports all core Zod schemas and schema factory functions (`SPEC.md` §3.4.1, §3.7.2, §3.10):

```ts
import { z } from 'zod';
import type { Check, EffectMatcher, MaybeSource, Service, ToolDefinition } from './ports.js';

export const ScopePredicateSchema = z.object({
  partitions: z.array(z.string()).default([]),
  effects: z.custom<EffectMatcher>().optional(),
});
export type ScopePredicate = z.infer<typeof ScopePredicateSchema>;

export const GlobalRuleSchema = z.object({
  id: z.string(),
  directive: z.string().min(1),
});
export type GlobalRule = z.infer<typeof GlobalRuleSchema>;

export const ScopedRuleSchema = z.object({
  id: z.string(),
  when: ScopePredicateSchema,
  directive: z.string().min(1),
  checks: z.array(z.custom<Check>()).default([]),
});
export type ScopedRule = z.infer<typeof ScopedRuleSchema>;

export const SkillDefinitionSchema = z.object({
  id: z.string(),
  description: z.string(),
  when: ScopePredicateSchema.optional(),
  instructions: z.custom<MaybeSource<string>>(),
  tools: z.array(z.custom<ToolDefinition>()).default([]),
  services: z.array(z.custom<Service>()).default([]),
  lease: z.literal('until-completed-or-fork-exit').default('until-completed-or-fork-exit'),
});
export type SkillDefinition = z.infer<typeof SkillDefinitionSchema>;

export const SpeculationCandidateSchema = <
  TIn extends z.ZodTypeAny,
  TOut extends z.ZodTypeAny,
  TReceipt extends z.ZodTypeAny,
  TCross extends z.ZodTypeAny,
  TEscPayload extends z.ZodTypeAny = z.ZodTypeAny,
>(
  inSchema: TIn,
  outSchema: TOut,
  receiptSchema: TReceipt,
  crossSchema: TCross,
  escalationSchema?: TEscPayload,
) =>
  z.discriminatedUnion('status', [
    z.object({
      status: z.literal('COMPLETED'),
      branchIndex: z.number(),
      input: inSchema,
      output: outSchema,
      scopeReceipt: receiptSchema,
      crossVerifyReport: crossSchema.optional(),
    }),
    z.object({
      status: z.literal('PARKED_ON_ESCALATION'),
      branchIndex: z.number(),
      input: inSchema,
      scopeReceipt: receiptSchema,
      interruptId: z.string(),
      escalationPayload: (escalationSchema ?? z.unknown()) as TEscPayload,
    }),
  ]);

export const SpeculationInputSchema = <
  TIn extends z.ZodTypeAny,
  TOut extends z.ZodTypeAny,
  TReceipt extends z.ZodTypeAny,
  TCross extends z.ZodTypeAny,
  TEscPayload extends z.ZodTypeAny = z.ZodTypeAny,
>(
  inSchema: TIn,
  outSchema: TOut,
  receiptSchema: TReceipt,
  crossSchema: TCross,
  escalationSchema?: TEscPayload,
) =>
  z.object({
    candidates: z.array(
      SpeculationCandidateSchema(inSchema, outSchema, receiptSchema, crossSchema, escalationSchema),
    ),
    failedBranches: z
      .array(
        z.object({
          branchIndex: z.number(),
          errorSummary: z.string(),
        }),
      )
      .default([]),
    humanRulingsHistory: z
      .array(
        z.object({
          branchIndex: z.number(),
          interruptId: z.string(),
          rulingSummary: z.string(),
        }),
      )
      .default([]),
  });

export const ResumeForkInputSchema = z.object({
  suspendedForkIds: z.array(z.string()).min(1),
  action: z.enum(['resume', 'abort']).default('resume'),
  resolutionSummary: z.string(),
});
export type ResumeForkInput = z.infer<typeof ResumeForkInputSchema>;

export const BudgetApprovalSchema = z.object({
  approved: z.boolean(),
  increaseLimitToUsd: z.number().optional(),
});
export type BudgetApproval = z.infer<typeof BudgetApprovalSchema>;

export const DistilledLessonCandidateSchema = z.object({
  admit: z.boolean(),
  partition: z.string().optional(),
  directive: z.string().optional(),
});
```

### 3.4 `packages/core/src/json-schema.ts`

Exports `zodToJsonSchema(schema: z.ZodTypeAny): Readonly<Record<string, unknown>>`:
- Converts Zod schemas (`ZodObject`, `ZodString`, `ZodNumber`, `ZodBoolean`, `ZodArray`, `ZodEnum`, `ZodLiteral`, `ZodUnion`, `ZodDiscriminatedUnion`, `ZodOptional`, `ZodDefault`, `ZodNullable`, `ZodRecord`, `ZodUnknown`) into deterministic, pure JSON-serializable JSON Schema objects for `WireToolSchema.inputJsonSchema` and structured output schemas.

### 3.5 `packages/core/src/ast.ts` & `packages/core/src/builders.ts`

Exports all AST descriptor interfaces, readonly compiled AST properties, `registerStepExecutors`, and fluent builder interfaces for all 20 `H.*` primitives:

```ts
import { z } from 'zod';
import type {
  AbortHook,
  Check,
  ControlPlaneAdapter,
  CrossVerifier,
  EffectMatcher,
  EnvRef,
  ExecutionContext,
  HumanAdapter,
  IsolationScope,
  LeaseDelta,
  LedgerStore,
  LessonRecord,
  LessonStore,
  MaybeSource,
  PendingPreFlightCall,
  PolicyGuard,
  PoolCandidateState,
  PoolSelectionContext,
  PoolSelectorFn,
  PoolStrategyPort,
  QuotaTripwire,
  ScopeRewindHook,
  Service,
  Source,
  StepContext,
  StepExecutable,
  StreamSource,
  TelemetryCollector,
  ToolDefinition,
  ToolEffect,
  TopologyStore,
  TrackerAdapter,
  UniversalStepTelemetry,
} from './ports.js';
import {
  BudgetApprovalSchema,
  DistilledLessonCandidateSchema,
  GlobalRule,
  ResumeForkInputSchema,
  ScopedRule,
  SkillDefinition,
  SpeculationCandidateSchema,
  SpeculationInputSchema,
} from './schemas.js';

export interface SignalDef<TPayload = any> {
  readonly kind: 'harness:signal';
  readonly id: string;
  readonly schema: z.ZodType<TPayload, z.ZodTypeDef, any>;
  payload<TSchema extends z.ZodTypeAny>(schema: TSchema): SignalDef<z.infer<TSchema>>;
}

export interface InterruptDef<TPayload = any> {
  readonly kind: 'harness:interrupt';
  readonly id: string;
  readonly schema: z.ZodType<TPayload, z.ZodTypeDef, any>;
  payload<TSchema extends z.ZodTypeAny>(schema: TSchema): InterruptDef<z.infer<TSchema>>;
}

export interface StreamDef<TEvent = any, TPayload = any> {
  readonly kind: 'harness:stream';
  readonly id: string;
  readonly streamSource?: StreamSource<TEvent>;
  readonly predicate?: (ev: TEvent) => boolean;
  readonly targetSignal?: SignalDef<TPayload>;
  readonly payloadMapper?: (ev: TEvent) => TPayload;
  source<TEv>(src: StreamSource<TEv>): StreamDef<TEv, TPayload>;
  filter(pred: (ev: TEvent) => boolean): StreamDef<TEvent, TPayload>;
  emitSignal<TP>(signal: SignalDef<TP>, mapper: (ev: TEvent) => TP): StreamDef<TEvent, TP>;
}

export interface PoolStrategyConfig<TItem = any> {
  readonly mode: 'soonest-reset' | 'round-robin' | 'least-used' | 'escalate-on-retry' | 'custom';
  readonly minSuccessRate?: number;
  readonly minSamples?: number;
  readonly customStrategy?: PoolStrategyPort<TItem> | PoolSelectorFn<TItem>;
}

export interface PoolStrategyBuilder<TItem = any> {
  escalateOnRetry(): PoolStrategyBuilder<TItem>;
  minSuccessRate(rate: number): PoolStrategyBuilder<TItem>;
  minSamples(samples: number): PoolStrategyBuilder<TItem>;
  custom(strategy: PoolStrategyPort<TItem> | PoolSelectorFn<TItem>): PoolStrategyBuilder<TItem>;
}

export interface PoolDef<TItem = any> {
  readonly kind: 'harness:pool';
  readonly id: string;
  readonly items: readonly TItem[];
  readonly strategyConfig: PoolStrategyConfig<TItem>;
  readonly fallbackItem?: TItem;
  with<T>(...items: T[]): PoolDef<T>;
  strategy(
    modeOrBuilder:
      | 'soonest-reset'
      | 'round-robin'
      | 'least-used'
      | (($: PoolStrategyBuilder<TItem>) => PoolStrategyBuilder<TItem>)
      | PoolStrategyPort<TItem>
      | PoolSelectorFn<TItem>,
  ): PoolDef<TItem>;
  fallback(item: TItem): PoolDef<TItem>;
}

export interface ScopedHumanTarget<TResponse = any> {
  readonly kind: 'harness:scoped-human';
  readonly human: HumanDef;
  readonly alias: string;
  readonly responseSchema: z.ZodType<TResponse, z.ZodTypeDef, any>;
}

export interface HumanNameBuilder {
  output<TSchema extends z.ZodTypeAny>(schema: TSchema): ScopedHumanTarget<z.infer<TSchema>>;
}

export interface HumanDef {
  readonly kind: 'harness:human';
  readonly id: string;
  readonly keepAliveSec?: number;
  readonly adapter?: HumanAdapter;
  keepAliveSeconds(seconds: number): HumanDef;
  notify(adapter: HumanAdapter): HumanDef;
  withName(alias: string): HumanNameBuilder;
}

export interface PrefixGroupDef {
  readonly kind: 'harness:prefix-group';
  readonly id: string;
  readonly mode: 'role-scoped' | 'union';
  readonly groundingSources: readonly MaybeSource<string>[];
  readonly instructionSources: readonly MaybeSource<string>[];
  readonly sharedRulesDef?: RulesDef;
  toolsMode(mode: 'role-scoped' | 'union'): PrefixGroupDef;
  sharedGrounding(...sources: MaybeSource<string>[]): PrefixGroupDef;
  sharedInstructions(...sources: MaybeSource<string>[]): PrefixGroupDef;
  sharedRules(rules: RulesDef): PrefixGroupDef;
}

export interface CommitOverlayOptions<TOnSig = any, TDiscardSig = any> {
  readonly onSignal?: {
    readonly signal: SignalDef<TOnSig>;
    readonly correlateBy: (sig: TOnSig) => string;
    readonly baseBranch?: (sig: TOnSig) => string;
  };
  readonly discardOnSignal?: {
    readonly signal: SignalDef<TDiscardSig>;
    readonly correlateBy: (sig: TDiscardSig) => string;
  };
  readonly maxSealedAgeHours?: number;
}

export interface TopologyDef<TPartition extends string = string> {
  readonly kind: 'harness:topology';
  readonly id: string;
  readonly topologyStore?: TopologyStore;
  readonly partitionGraph: Readonly<Record<TPartition, { readonly dependsOn?: readonly TPartition[] }>>;
  readonly overlayOptions?: CommitOverlayOptions<any, any>;
  store(store: TopologyStore): TopologyDef<TPartition>;
  partitions<TMap extends Record<string, { readonly dependsOn?: readonly string[] }>>(
    map: TMap,
  ): TopologyDef<Extract<keyof TMap, string>>;
  commitOverlayWhen<TOnSig = any, TDiscardSig = any>(
    opts?: CommitOverlayOptions<TOnSig, TDiscardSig>,
  ): TopologyDef<TPartition>;
  dependentsOf(partitionId: TPartition): readonly TPartition[];
  affectedBy(partitionId: TPartition): readonly TPartition[];
}

export interface ScopedRuleDef {
  readonly kind: 'harness:scoped-rule';
  readonly idOrSource: string | Source<ScopedRule>;
  readonly predicate?: {
    readonly partitions?: readonly string[];
    readonly effects?: EffectMatcher;
  };
  readonly directiveSource?: MaybeSource<string>;
  readonly beforeStopChecks: readonly Check<any>[];
  when(predicate: {
    readonly partitions?: readonly string[];
    readonly effects?: EffectMatcher;
  }): ScopedRuleDef;
  directive(textOrSource: MaybeSource<string>): ScopedRuleDef;
  enforceBeforeStop(...checks: Check<any>[]): ScopedRuleDef;
}

export interface RulesDef {
  readonly kind: 'harness:rules';
  readonly id: string;
  readonly globalSources: readonly MaybeSource<GlobalRule | readonly GlobalRule[]>[];
  readonly scopedEntries: ReadonlyArray<MaybeSource<ScopedRule | readonly ScopedRule[]> | ScopedRuleDef>;
  global(...sources: MaybeSource<GlobalRule | readonly GlobalRule[]>[]): RulesDef;
  scoped(...entries: Array<MaybeSource<ScopedRule | readonly ScopedRule[]> | ScopedRuleDef>): RulesDef;
}

export interface SkillDef {
  readonly kind: 'harness:skill';
  readonly idOrSource: string | Source<SkillDefinition>;
  readonly predicate?: {
    readonly partitions?: readonly string[];
    readonly effects?: EffectMatcher;
  };
  readonly descriptionText?: string;
  readonly instructionSource?: MaybeSource<string>;
  readonly unlockedTools: readonly ToolDefinition<any>[];
  readonly unlockedServices: readonly Service<any>[];
  readonly leaseMode: 'until-completed-or-fork-exit';
  when(predicate: {
    readonly partitions?: readonly string[];
    readonly effects?: EffectMatcher;
  }): SkillDef;
  description(text: string): SkillDef;
  instructions(textOrSource: MaybeSource<string>): SkillDef;
  unlocksTools(...tools: Array<ToolDefinition<any> | readonly ToolDefinition<any>[]>): SkillDef;
  unlocksServices(...services: Service<any>[]): SkillDef;
  lease(mode: 'until-completed-or-fork-exit'): SkillDef;
}

export interface LessonDistillConfig {
  readonly model: unknown;
  readonly onLoopRecovery: boolean;
  readonly onGateRecovery: boolean;
  readonly minFailedChecks: number;
  readonly guidelinesSource?: MaybeSource<string>;
}

export interface LessonScoringConfig {
  readonly slidingWindowInjections: number;
  readonly partitionMatchBoost: number;
  readonly decayOnPartitionEpochChange: number;
  readonly minScore: number;
  readonly maxItems: number;
}

export interface LessonRetireConfig {
  readonly maxViolations?: number;
  readonly minCleanPassRate?: number;
  readonly afterInjections?: number;
}

export interface LessonSignalTriggerConfig<TPayload = any> {
  readonly signal: SignalDef<TPayload>;
  readonly minCleanPasses: number;
  readonly maxViolations: number;
  readonly cooldownHours: number;
  readonly mapper: (lesson: LessonRecord) => TPayload;
}

export interface LessonDistillBuilder {
  onLoopRecovery(): LessonDistillBuilder;
  onGateRecovery(opts?: { readonly minFailedChecks?: number }): LessonDistillBuilder;
  guidelines(source: MaybeSource<string>): LessonDistillBuilder;
}

export interface LessonScoringBuilder {
  slidingWindowInjections(count: number): LessonScoringBuilder;
  partitionMatchBoost(boost: number): LessonScoringBuilder;
  decayOnPartitionEpochChange(gamma: number): LessonScoringBuilder;
  recall(opts: { readonly minScore: number; readonly maxItems: number }): LessonScoringBuilder;
}

export interface LessonRetireBuilder {
  maxViolations(count: number): LessonRetireBuilder;
  orMinCleanPassRate(minRate: number, opts: { readonly afterInjections: number }): LessonRetireBuilder;
}

export interface LessonEmitSignalBuilder {
  minCleanPasses(count: number): LessonEmitSignalBuilder;
  maxViolations(count: number): LessonEmitSignalBuilder;
  cooldownHours(hours: number): LessonEmitSignalBuilder;
}

export interface LessonsDef<TIn = any> {
  readonly kind: 'harness:lessons';
  readonly id: string;
  readonly lessonStore?: LessonStore;
  readonly querySchema?: z.ZodType<TIn, z.ZodTypeDef, any>;
  readonly queryExtractor?: (input: TIn) => string;
  readonly distillConfig?: LessonDistillConfig;
  readonly scoringConfig: LessonScoringConfig;
  readonly retireConfig?: LessonRetireConfig;
  readonly signalTriggers: readonly LessonSignalTriggerConfig<any>[];
  store(store: LessonStore): LessonsDef<TIn>;
  queryFrom<TSchema extends z.ZodTypeAny>(
    schema: TSchema,
    extractor: (input: z.infer<TSchema>) => string,
  ): LessonsDef<z.infer<TSchema>>;
  distillWith(
    model: unknown,
    configure: ($d: LessonDistillBuilder) => LessonDistillBuilder,
  ): LessonsDef<TIn>;
  scoring(configure: ($s: LessonScoringBuilder) => LessonScoringBuilder): LessonsDef<TIn>;
  retireAfter(configure: ($r: LessonRetireBuilder) => LessonRetireBuilder): LessonsDef<TIn>;
  emitSignalWhen<TPayload>(
    signal: SignalDef<TPayload>,
    configure: ($t: LessonEmitSignalBuilder) => LessonEmitSignalBuilder,
    mapper: (lesson: LessonRecord) => TPayload,
  ): LessonsDef<TIn>;
}

export interface PolicyViolation {
  readonly blockedCalls: readonly PendingPreFlightCall[];
  readonly violatedEffects: readonly ToolEffect[];
  readonly violationSummary: string;
}

export interface PolicyGuardClauseConfig<TPayload = any> {
  readonly id: string;
  readonly guards: readonly PolicyGuard[];
  readonly mode: 'deny-with-error' | 'raise-interrupt';
  readonly messageMapper?: (violation: PolicyViolation) => string;
  readonly interrupt?: InterruptDef<TPayload>;
  readonly interruptMapper?: (violation: PolicyViolation) => TPayload;
}

export interface LimitExceededConfig {
  readonly flushInterrupt?: InterruptDef<any>;
  readonly abortHook?: AbortHook<any, any>;
}

export interface PolicyGuardChainBuilder {
  onViolation(
    mode: 'deny-with-error',
    messageMapper?: (violation: PolicyViolation) => string,
  ): PolicyDef;
  onViolation<TPayload>(
    mode: 'raise-interrupt',
    interrupt: InterruptDef<TPayload>,
    mapper: (violation: PolicyViolation) => TPayload,
  ): PolicyDef;
}

export interface LimitExceededBuilder {
  flushWithInterrupt(interrupt: InterruptDef<any>): LimitExceededBuilder;
  onAbort(hook: AbortHook<any, any>): LimitExceededBuilder;
}

export interface PolicyDef {
  readonly kind: 'harness:policy';
  readonly id: string;
  readonly guardClauses: readonly PolicyGuardClauseConfig<any>[];
  readonly tripwires: readonly QuotaTripwire[];
  readonly maxTurnsLimit?: number;
  readonly maxCostUsdLimit?: number;
  readonly maxDurationSecondsLimit?: number;
  readonly abortHook?: AbortHook<any, any>;
  readonly limitExceededConfig?: LimitExceededConfig;
  guard(...guards: PolicyGuard[]): PolicyGuardChainBuilder;
  tripwire(...tripwires: QuotaTripwire[]): PolicyDef;
  maxTurns(turns: number): PolicyDef;
  maxCostUsd(costUsd: number): PolicyDef;
  maxDurationSeconds(seconds: number): PolicyDef;
  onAbort(hook: AbortHook<any, any>): PolicyDef;
  onLimitExceeded(configure: ($l: LimitExceededBuilder) => LimitExceededBuilder): PolicyDef;
  extend(newId: string): PolicyDef;
}

export interface ForkModelRoutingConfig<TIn = any, TReq = any> {
  readonly inheritEffort?: 'low' | 'medium' | 'high';
  readonly inheritWhen?: (parentInput: TIn, req: TReq) => boolean;
  readonly fallbackPool?: unknown;
}

export interface ForkCapabilityConfig<TIn = any, TChildIn = any, TReq = any> {
  readonly toolName: string;
  readonly childExecutable: StepExecutable<TChildIn, any, any>;
  readonly historyMode: 'shared-prefix-only' | 'clone-transcript';
  readonly requestSchema?: z.ZodType<TReq, z.ZodTypeDef, any>;
  readonly mapInput?: (parentInput: TIn, req: TReq) => TChildIn;
  readonly modelRoutingConfig?: ForkModelRoutingConfig<TIn, TReq>;
}

export interface ForkModelRoutingBuilder<TIn = any, TReq = any> {
  inheritParentWithEffort(
    effort: 'low' | 'medium' | 'high',
    opts: { readonly when: (parentInput: TIn, req: TReq) => boolean },
  ): ForkModelRoutingBuilder<TIn, TReq>;
  otherwisePool(pool: unknown): ForkModelRoutingBuilder<TIn, TReq>;
}

export interface ForkCapabilityBuilder<TIn = any, TChildIn = any, TReq = any> {
  historyMode(mode: 'shared-prefix-only' | 'clone-transcript'): ForkCapabilityBuilder<TIn, TChildIn, TReq>;
  requestSchema<TSchema extends z.ZodTypeAny>(
    schema: TSchema,
  ): ForkCapabilityBuilder<TIn, TChildIn, z.infer<TSchema>>;
  mapInput(
    mapper: (parentInput: TIn, req: TReq) => TChildIn,
  ): ForkCapabilityBuilder<TIn, TChildIn, TReq>;
  modelRouting(
    configure: ($m: ForkModelRoutingBuilder<TIn, TReq>) => ForkModelRoutingBuilder<TIn, TReq>,
  ): ForkCapabilityBuilder<TIn, TChildIn, TReq>;
}

export type ArbiterDecision =
  | {
      readonly decision: 'select-winner';
      readonly winnerBranchIndex: number;
      readonly rationale: string;
      readonly followUpDeficits?: readonly string[];
    }
  | {
      readonly decision: 'unpark-escalation';
      readonly parkedBranchIndex: number;
      readonly rationale: string;
    }
  | {
      readonly decision: 'reject-all';
      readonly rationale: string;
    };

export interface SpeculateCapabilityConfig<
  TIn = any,
  TReq = any,
  TWorkerIn = any,
  TWorkerOut = any,
  THandle = any,
  TVerdict extends ArbiterDecision = ArbiterDecision,
> {
  readonly toolName: string;
  readonly requestSchema?: z.ZodType<TReq, z.ZodTypeDef, any>;
  readonly workerExecutable?: StepExecutable<TWorkerIn, TWorkerOut, THandle>;
  readonly branchCount: number;
  readonly branchesMapper?: (parentInput: TIn, req: TReq) => readonly TWorkerIn[];
  readonly singleWinnerVerifier?: {
    readonly evaluator: StepExecutable<any, any, THandle>;
    readonly mapInput?: (branchInput: TWorkerIn, branchOutput: TWorkerOut, scopeReceipt: any) => any;
    readonly acceptWhen?: (evalOut: any) => boolean;
  };
  readonly crossVerifier?: CrossVerifier<THandle, any, any>;
  readonly arbiterConfig?: {
    readonly arbiterAgent: StepExecutable<any, TVerdict, THandle>;
    readonly resolveDecision: (verdict: TVerdict) => ArbiterDecision;
  };
  readonly refineWinnerConfig?: {
    readonly predicate: (verdict: TVerdict) => boolean;
    readonly refinementExecutable: StepExecutable<TWorkerIn, TWorkerOut, THandle>;
    readonly mapper: (parentInput: TIn, verdict: TVerdict, candidates: ReadonlyArray<any>) => TWorkerIn;
  };
}

export interface SpeculateCapabilityBuilder<
  TIn = any,
  TReq = any,
  TWorkerIn = any,
  TWorkerOut = any,
  THandle = any,
  TVerdict extends ArbiterDecision = ArbiterDecision,
> {
  requestSchema<TSchema extends z.ZodTypeAny>(
    schema: TSchema,
  ): SpeculateCapabilityBuilder<TIn, z.infer<TSchema>, TWorkerIn, TWorkerOut, THandle, TVerdict>;
  worker<TWIn, TWOut, TH>(
    executable: StepExecutable<TWIn, TWOut, TH>,
  ): SpeculateCapabilityBuilder<TIn, TReq, TWIn, TWOut, TH, TVerdict>;
  branches(
    count: number,
    mapper: (parentInput: TIn, req: TReq) => readonly TWorkerIn[],
  ): SpeculateCapabilityBuilder<TIn, TReq, TWorkerIn, TWorkerOut, THandle, TVerdict>;
  verifyWinnerWith<TEvalIn, TEvalOut>(
    evaluator: StepExecutable<TEvalIn, TEvalOut, THandle>,
    opts?: {
      readonly mapInput: (branchInput: TWorkerIn, branchOutput: TWorkerOut, scopeReceipt: any) => TEvalIn;
      readonly acceptWhen: (evalOut: TEvalOut) => boolean;
    },
  ): SpeculateCapabilityBuilder<TIn, TReq, TWorkerIn, TWorkerOut, THandle, TVerdict>;
  crossVerifyWith(
    verifier: CrossVerifier<THandle, any, any>,
  ): SpeculateCapabilityBuilder<TIn, TReq, TWorkerIn, TWorkerOut, THandle, TVerdict>;
  arbiter<TArbIn, TArbOut extends ArbiterDecision>(
    arbiterAgent: StepExecutable<TArbIn, TArbOut, THandle>,
    opts: {
      readonly resolveDecision: (verdict: TArbOut) => ArbiterDecision;
    },
  ): SpeculateCapabilityBuilder<TIn, TReq, TWorkerIn, TWorkerOut, THandle, TArbOut>;
  refineWinnerWhen(
    predicate: (verdict: TVerdict) => boolean,
    refinementExecutable: StepExecutable<TWorkerIn, TWorkerOut, THandle>,
    mapper: (
      parentInput: TIn,
      verdict: TVerdict,
      candidates: ReadonlyArray<
        | {
            readonly status: 'COMPLETED';
            readonly branchIndex: number;
            readonly input: TWorkerIn;
            readonly output: TWorkerOut;
            readonly scopeReceipt: any;
            readonly crossVerifyReport?: any;
          }
        | {
            readonly status: 'PARKED_ON_ESCALATION';
            readonly branchIndex: number;
            readonly input: TWorkerIn;
            readonly scopeReceipt: any;
            readonly interruptId: string;
            readonly escalationPayload: any;
          }
      >,
    ) => TWorkerIn,
  ): SpeculateCapabilityBuilder<TIn, TReq, TWorkerIn, TWorkerOut, THandle, TVerdict>;
}

export interface SpawnTasksCapabilityConfig<TItem = any> {
  readonly itemSchema: z.ZodType<TItem, z.ZodTypeDef, any>;
  readonly maxSpawnedPerRun: number;
  readonly maxPrerequisiteDepth: number;
  readonly enforcePatch?: Partial<TItem>;
  readonly onPrerequisiteSpawned: 'suspend-and-yield-slot';
  readonly priorityStrategy: 'inherit-parent-with-boost' | 'normal';
  readonly resumeWhen:
    | 'prerequisite-exit'
    | {
        readonly signal: SignalDef<any>;
        readonly correlateBy: (sig: any) => string;
      };
}

export interface MutatePlanCapabilityConfig {
  readonly spawnTasksConfig?: SpawnTasksCapabilityConfig<any>;
  readonly allowAddDependencies: boolean;
  readonly writableTopology?: TopologyDef<any>;
}

export interface MutatePlanBuilder {
  canSpawnTasks<TSchema extends z.ZodTypeAny>(
    itemSchema: TSchema,
    opts: {
      readonly maxSpawnedPerRun: number;
      readonly maxPrerequisiteDepth?: number;
      readonly enforcePatch?: Partial<z.infer<TSchema>>;
      readonly onPrerequisiteSpawned: 'suspend-and-yield-slot';
      readonly priorityStrategy?: 'inherit-parent-with-boost' | 'normal';
      readonly resumeWhen?:
        | 'prerequisite-exit'
        | {
            readonly signal: SignalDef<any>;
            readonly correlateBy: (sig: any) => string;
          };
    },
  ): MutatePlanBuilder;
  canAddDependencies(): MutatePlanBuilder;
  canUpdateTopologyContracts(topology: TopologyDef<any>): MutatePlanBuilder;
}

export interface EscalateCapabilityConfig<TPayload = any, TDecision = any> {
  readonly interrupt: InterruptDef<TPayload>;
  readonly human?: HumanDef;
  readonly responseSchema?: z.ZodType<TDecision, z.ZodTypeDef, any>;
  readonly leaseElevations: ReadonlyArray<{
    readonly predicate: (decision: TDecision) => boolean;
    readonly leaseMapper: (decision: TDecision) => LeaseDelta;
  }>;
}

export interface EscalateCapabilityBuilder<TDecision = any> {
  to(human: HumanDef): EscalateCapabilityBuilder<TDecision>;
  response<TSchema extends z.ZodTypeAny>(
    schema: TSchema,
  ): EscalateCapabilityBuilder<z.infer<TSchema>>;
  elevateLeaseWhen(
    predicate: (decision: TDecision) => boolean,
    leaseMapper: (decision: TDecision) => LeaseDelta,
  ): EscalateCapabilityBuilder<TDecision>;
}

export interface AgentCapabilitiesConfig<TIn = any, THandle = any> {
  readonly forks: Readonly<Record<string, ForkCapabilityConfig<TIn, any, any>>>;
  readonly speculations: Readonly<Record<string, SpeculateCapabilityConfig<TIn, any, any, any, THandle, any>>>;
  readonly mutatePlanConfig?: MutatePlanCapabilityConfig;
  readonly escalations: Readonly<Record<string, EscalateCapabilityConfig<any, any>>>;
}

export interface AgentCapabilitiesBuilder<TIn = any, THandle = any> {
  fork<TChildIn, TChildOut>(
    toolName: string,
    childExecutable: StepExecutable<TChildIn, TChildOut, THandle>,
    configure: ($f: ForkCapabilityBuilder<TIn, TChildIn, any>) => ForkCapabilityBuilder<TIn, TChildIn, any>,
  ): AgentCapabilitiesBuilder<TIn, THandle>;
  speculate(
    toolName: string,
    configure: (
      $s: SpeculateCapabilityBuilder<TIn, any, any, any, THandle, any>,
    ) => SpeculateCapabilityBuilder<TIn, any, any, any, THandle, any>,
  ): AgentCapabilitiesBuilder<TIn, THandle>;
  mutatePlan(configure: ($m: MutatePlanBuilder) => MutatePlanBuilder): AgentCapabilitiesBuilder<TIn, THandle>;
  escalate<TPayload>(
    interrupt: InterruptDef<TPayload>,
    configure: ($esc: EscalateCapabilityBuilder<any>) => EscalateCapabilityBuilder<any>,
  ): AgentCapabilitiesBuilder<TIn, THandle>;
}

export interface ChildInterruptHandlerConfig<TPayload = any> {
  readonly interrupt: InterruptDef<TPayload>;
  readonly pausePartitionsMapper?: (payload: TPayload) => readonly string[];
  readonly suspendAndReturn: boolean;
}

export interface ChildInterruptBuilder<TPayload = any> {
  pauseSiblingForksInPartitions(
    mapper: (payload: TPayload) => readonly string[],
  ): ChildInterruptBuilder<TPayload>;
  suspendAndReturnToParent(): ChildInterruptBuilder<TPayload>;
}

export interface NestedHumanInterruptConfig<TDecision = any> {
  readonly human?: HumanDef;
  readonly responseSchema?: z.ZodType<TDecision, z.ZodTypeDef, any>;
  readonly leaseElevations: ReadonlyArray<{
    readonly predicate: (decision: TDecision) => boolean;
    readonly leaseMapper: (decision: TDecision) => LeaseDelta;
  }>;
  readonly feedbackMapper?: (decision: TDecision) => string;
}

export interface NestedHumanInterruptBuilder<TDecision = any> {
  ask<TSchema extends z.ZodTypeAny>(
    human: HumanDef,
    responseSchema: TSchema,
  ): NestedHumanInterruptBuilder<z.infer<TSchema>>;
  elevateLeaseWhen(
    predicate: (decision: TDecision) => boolean,
    leaseMapper: (decision: TDecision) => LeaseDelta,
  ): NestedHumanInterruptBuilder<TDecision>;
  resumeWith(feedbackMapper: (decision: TDecision) => string): NestedHumanInterruptBuilder<TDecision>;
}

export interface InterruptEdgeConfig<
  TInput = any,
  TPayload = any,
  TVerdict = any,
  TCustomMetrics extends Record<string, unknown> = Record<string, unknown>,
  TAbortMeta extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly interrupt: InterruptDef<TPayload>;
  readonly adjudicatorConfig?: {
    readonly adjudicator: StepExecutable<any, TVerdict, any>;
    readonly mapInput: (input: TInput, payload: TPayload) => any;
  };
  readonly directHumanConfig?: NestedHumanInterruptConfig<any>;
  readonly nestedInterruptHandlers: Readonly<Record<string, NestedHumanInterruptConfig<any>>>;
  readonly leaseElevations: ReadonlyArray<{
    readonly predicate: (input: TInput, payload: TPayload, verdict: TVerdict) => boolean;
    readonly leaseMapper: (input: TInput, payload: TPayload, verdict: TVerdict) => LeaseDelta;
  }>;
  readonly resumeFeedbackMapper?: (input: TInput, payload: TPayload, verdict: TVerdict) => string;
  readonly abortHook?: AbortHook<any, TAbortMeta>;
  readonly replacementConfig?: {
    readonly replacement: StepExecutable<any, any, any>;
    readonly mapInput: (
      input: TInput,
      payload: TPayload,
      telemetry: UniversalStepTelemetry<TCustomMetrics, TAbortMeta>,
    ) => any;
  };
}

export interface InterruptEdgeBuilder<
  TInput = any,
  TPayload = any,
  TVerdict = any,
  TCustomMetrics extends Record<string, unknown> = Record<string, unknown>,
  TAbortMeta extends Record<string, unknown> = Record<string, unknown>,
> {
  adjudicateWith<TAdjIn, TAdjOut>(
    adjudicator: StepExecutable<TAdjIn, TAdjOut, any>,
    mapInput: (input: TInput, payload: TPayload) => TAdjIn,
  ): InterruptEdgeBuilder<TInput, TPayload, TAdjOut, TCustomMetrics, TAbortMeta>;
  ask<TSchema extends z.ZodTypeAny>(
    human: HumanDef,
    responseSchema: TSchema,
  ): NestedHumanInterruptBuilder<z.infer<TSchema>>;
  onInterrupt<TNestedPayload>(
    nestedInterrupt: InterruptDef<TNestedPayload>,
    configure: ($esc: NestedHumanInterruptBuilder<any>) => NestedHumanInterruptBuilder<any>,
  ): InterruptEdgeBuilder<TInput, TPayload, TVerdict, TCustomMetrics, TAbortMeta>;
  elevateLeaseWhen(
    predicate: (input: TInput, payload: TPayload, verdict: TVerdict) => boolean,
    leaseMapper: (input: TInput, payload: TPayload, verdict: TVerdict) => LeaseDelta,
  ): InterruptEdgeBuilder<TInput, TPayload, TVerdict, TCustomMetrics, TAbortMeta>;
  resumeWith(
    feedbackMapper: (input: TInput, payload: TPayload, verdict: TVerdict) => string,
  ): InterruptEdgeBuilder<TInput, TPayload, TVerdict, TCustomMetrics, TAbortMeta>;
  onAbort<TNewAbortMeta extends Record<string, unknown>>(
    hook: AbortHook<any, TNewAbortMeta>,
  ): InterruptEdgeBuilder<TInput, TPayload, TVerdict, TCustomMetrics, TNewAbortMeta>;
  replaceWith<TRepIn, TRepOut>(
    replacement: StepExecutable<TRepIn, TRepOut, any>,
    mapInput: (
      input: TInput,
      payload: TPayload,
      telemetry: UniversalStepTelemetry<TCustomMetrics, TAbortMeta>,
    ) => TRepIn,
  ): InterruptEdgeBuilder<TInput, TPayload, TVerdict, TCustomMetrics, TAbortMeta>;
}

export interface AgentDef<TIn = any, TOut = any, THandle = any> extends StepExecutable<TIn, TOut, THandle> {
  readonly roleKey: string;
  readonly prefixGroupDef?: PrefixGroupDef;
  readonly modelOrPool?: unknown;
  readonly topologyDef?: TopologyDef<any>;
  readonly rulesDef?: RulesDef;
  readonly lessonsConfig?: {
    readonly lessons: LessonsDef<any>;
    readonly recordOutcomes: boolean;
  };
  readonly skillEntries: ReadonlyArray<SkillDef | MaybeSource<SkillDefinition | readonly SkillDefinition[]>>;
  readonly policyDef?: PolicyDef;
  readonly mountedTools: readonly ToolDefinition<any>[];
  readonly groundingSources: readonly MaybeSource<string>[];
  readonly instructionSources: readonly MaybeSource<string>[];
  readonly timeoutMins?: number;
  readonly beforeStopChecks: readonly Check<any>[];
  readonly raisableInterrupts: readonly InterruptDef<any>[];
  readonly capabilitiesConfig: AgentCapabilitiesConfig<TIn, THandle>;
  readonly childInterruptHandlers: Readonly<Record<string, ChildInterruptHandlerConfig<any>>>;
  readonly interruptHandlers: Readonly<Record<string, InterruptEdgeConfig<TIn, any, any, any, any>>>;
  prefixGroup(group: PrefixGroupDef): AgentDef<TIn, TOut, THandle>;
  model(modelOrPool: unknown): AgentDef<TIn, TOut, THandle>;
  topology(topology: TopologyDef<any>): AgentDef<TIn, TOut, THandle>;
  rules(rules: RulesDef): AgentDef<TIn, TOut, THandle>;
  lessons(lessons: LessonsDef<any>, opts?: { readonly recordOutcomes?: boolean }): AgentDef<TIn, TOut, THandle>;
  skills(
    ...skills: Array<SkillDef | MaybeSource<SkillDefinition | readonly SkillDefinition[]>>
  ): AgentDef<TIn, TOut, THandle>;
  policy(policy: PolicyDef): AgentDef<TIn, TOut, THandle>;
  tools(...tools: Array<ToolDefinition<any> | readonly ToolDefinition<any>[]>): AgentDef<TIn, TOut, THandle>;
  grounding(...sources: MaybeSource<string>[]): AgentDef<TIn, TOut, THandle>;
  instructions(...sources: MaybeSource<string>[]): AgentDef<TIn, TOut, THandle>;
  timeoutMinutes(minutes: number): AgentDef<TIn, TOut, THandle>;
  beforeStop(...checks: Check<any>[]): AgentDef<TIn, TOut, THandle>;
  input<TSchema extends z.ZodTypeAny>(schema: TSchema): AgentDef<z.infer<TSchema>, TOut, THandle>;
  partitions(extractor: (input: TIn) => readonly string[]): AgentDef<TIn, TOut, THandle>;
  output<TSchema extends z.ZodTypeAny>(schema: TSchema): AgentDef<TIn, z.infer<TSchema>, THandle>;
  canRaise(...interrupts: InterruptDef<any>[]): AgentDef<TIn, TOut, THandle>;
  capabilities(
    configure: ($cap: AgentCapabilitiesBuilder<TIn, THandle>) => AgentCapabilitiesBuilder<TIn, THandle>,
  ): AgentDef<TIn, TOut, THandle>;
  onChildInterrupt<TPayload>(
    interrupt: InterruptDef<TPayload>,
    configure: ($intr: ChildInterruptBuilder<TPayload>) => ChildInterruptBuilder<TPayload>,
  ): AgentDef<TIn, TOut, THandle>;
  onInterrupt<TPayload>(
    interrupt: InterruptDef<TPayload>,
    configure: ($intr: InterruptEdgeBuilder<TIn, TPayload, any>) => unknown,
  ): AgentDef<TIn, TOut, THandle>;
  withPolicy(newPolicy: PolicyDef): AgentDef<TIn, TOut, THandle>;
  withTools(...extraTools: Array<ToolDefinition<any> | readonly ToolDefinition<any>[]>): AgentDef<TIn, TOut, THandle>;
}

export interface LoopEvaluateConfig<TIn = any, TOut = any, TEvalIn = any, TEvalOut = any, THandle = any> {
  readonly stepId: string;
  readonly evaluator: StepExecutable<TEvalIn, TEvalOut, THandle>;
  readonly mapInput: (loopInput: TIn, candidate: TOut, scopeReceipt: any) => TEvalIn;
  readonly acceptWhen: (evalOut: TEvalOut) => boolean;
  readonly feedbackMapper: (evalOut: TEvalOut) => string;
}

export interface LoopDef<TIn = any, TOut = any, THandle = any> extends StepExecutable<TIn, TOut, THandle> {
  readonly roleKey: string;
  readonly maxIterationsLimit: number;
  readonly preserveSession: boolean;
  readonly lessonsDef?: LessonsDef<any>;
  readonly actStep?: {
    readonly stepId: string;
    readonly actor: StepExecutable<TIn, any, THandle>;
  };
  readonly evaluateStep?: LoopEvaluateConfig<TIn, TOut, any, any, THandle>;
  readonly returnOutputStepId?: string;
  readonly policyOverride?: PolicyDef;
  readonly extraTools: readonly ToolDefinition<any>[];
  input<TSchema extends z.ZodTypeAny>(schema: TSchema): LoopDef<z.infer<TSchema>, TOut, THandle>;
  output<TSchema extends z.ZodTypeAny>(schema: TSchema): LoopDef<TIn, z.infer<TSchema>, THandle>;
  partitions(extractor: (input: TIn) => readonly string[]): LoopDef<TIn, TOut, THandle>;
  maxIterations(count: number): LoopDef<TIn, TOut, THandle>;
  preserveActorSession(preserve: boolean): LoopDef<TIn, TOut, THandle>;
  distillLessonsInto(lessons: LessonsDef<any>): LoopDef<TIn, TOut, THandle>;
  act<TActOut>(
    stepId: string,
    actor: StepExecutable<TIn, TActOut, THandle>,
    configure?: ($act: unknown) => unknown,
  ): LoopDef<TIn, TOut, THandle>;
  evaluate<TEvalIn, TEvalOut>(
    stepId: string,
    evaluator: StepExecutable<TEvalIn, TEvalOut, THandle>,
    opts: {
      readonly mapInput: (loopInput: TIn, candidate: TOut, scopeReceipt: any) => TEvalIn;
      readonly acceptWhen: (evalOut: TEvalOut) => boolean;
      readonly feedbackMapper: (evalOut: TEvalOut) => string;
    },
  ): LoopDef<TIn, TOut, THandle>;
  returnOutputFrom(actStepId: string): LoopDef<TIn, TOut, THandle>;
  withPolicy(newPolicy: PolicyDef): LoopDef<TIn, TOut, THandle>;
  withTools(...extraTools: Array<ToolDefinition<any> | readonly ToolDefinition<any>[]>): LoopDef<TIn, TOut, THandle>;
}

export interface FlowStepNodeConfig<
  TFlowIn = any,
  TStepIn = any,
  TSteps extends Record<string, any> = Record<never, never>,
  TReceipt = any,
  TCustomMetrics extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly kind: 'step';
  readonly stepId: string;
  readonly executable: StepExecutable<TStepIn, any, any>;
  readonly inputMapper?: (flowInput: TFlowIn, priorSteps: TSteps, scopeReceipt: TReceipt) => TStepIn;
  readonly interruptHandlers: Readonly<Record<string, InterruptEdgeConfig<TFlowIn, any, any, TCustomMetrics, any>>>;
}

export interface FlowBranchNodeConfig<
  TFlowIn = any,
  TBranchOut = any,
  TSteps extends Record<string, any> = Record<never, never>,
  TReceipt = any,
  TCustomMetrics extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly kind: 'branch';
  readonly branchStepId: string;
  readonly outputSchema?: z.ZodType<TBranchOut, z.ZodTypeDef, any>;
  readonly arms: ReadonlyArray<{
    readonly predicate?: (input: TFlowIn) => boolean;
    readonly step: FlowStepNodeConfig<TFlowIn, any, TSteps, TReceipt, TCustomMetrics>;
  }>;
}

export type FlowNodeConfig<
  TFlowIn = any,
  TSteps extends Record<string, any> = Record<never, never>,
  TReceipt = any,
  TCustomMetrics extends Record<string, unknown> = Record<string, unknown>,
> =
  | FlowStepNodeConfig<TFlowIn, any, TSteps, TReceipt, TCustomMetrics>
  | FlowBranchNodeConfig<TFlowIn, any, TSteps, TReceipt, TCustomMetrics>;

export interface FlowStepBuilder<
  TFlowIn = any,
  TStepIn = any,
  TSteps extends Record<string, any> = Record<never, never>,
  TReceipt = any,
  TCustomMetrics extends Record<string, unknown> = Record<string, unknown>,
> {
  inputFrom(
    mapper: (flowInput: TFlowIn, priorSteps: TSteps, scopeReceipt: TReceipt) => TStepIn,
  ): FlowStepBuilder<TFlowIn, TStepIn, TSteps, TReceipt, TCustomMetrics>;
  onInterrupt<TPayload>(
    interrupt: InterruptDef<TPayload>,
    configure: (
      $intr: InterruptEdgeBuilder<TFlowIn, TPayload, any, TCustomMetrics, Record<string, unknown>>,
    ) => unknown,
  ): FlowStepBuilder<TFlowIn, TStepIn, TSteps, TReceipt, TCustomMetrics>;
}

export interface FlowSubBranchBuilder<
  TFlowIn = any,
  TBranchOut = any,
  TSteps extends Record<string, any> = Record<never, never>,
  TReceipt = any,
  TCustomMetrics extends Record<string, unknown> = Record<string, unknown>,
> {
  step<TStepIn>(
    stepId: string,
    executable: StepExecutable<TStepIn, TBranchOut, any>,
    configure?: (
      $step: FlowStepBuilder<TFlowIn, TStepIn, TSteps, TReceipt, TCustomMetrics>,
    ) => FlowStepBuilder<TFlowIn, TStepIn, TSteps, TReceipt, TCustomMetrics>,
  ): FlowSubBranchBuilder<TFlowIn, TBranchOut, TSteps, TReceipt, TCustomMetrics>;
}

export interface FlowBranchBuilder<
  TFlowIn = any,
  TBranchOut = any,
  TSteps extends Record<string, any> = Record<never, never>,
  TReceipt = any,
  TCustomMetrics extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly outputSchema?: z.ZodType<TBranchOut, z.ZodTypeDef, any>;
  output<TSchema extends z.ZodTypeAny>(
    schema: TSchema,
  ): FlowBranchBuilder<TFlowIn, z.infer<TSchema>, TSteps, TReceipt, TCustomMetrics>;
  when(
    predicate: (input: TFlowIn) => boolean,
    configure: (
      $sub: FlowSubBranchBuilder<TFlowIn, TBranchOut, TSteps, TReceipt, TCustomMetrics>,
    ) => FlowSubBranchBuilder<TFlowIn, TBranchOut, TSteps, TReceipt, TCustomMetrics>,
  ): FlowBranchBuilder<TFlowIn, TBranchOut, TSteps, TReceipt, TCustomMetrics>;
  otherwise(
    configure: (
      $sub: FlowSubBranchBuilder<TFlowIn, TBranchOut, TSteps, TReceipt, TCustomMetrics>,
    ) => FlowSubBranchBuilder<TFlowIn, TBranchOut, TSteps, TReceipt, TCustomMetrics>,
  ): FlowBranchBuilder<TFlowIn, TBranchOut, TSteps, TReceipt, TCustomMetrics>;
}

export interface FlowDef<
  TIn = any,
  THandle = any,
  TReceipt extends Record<string, unknown> = Record<string, unknown>,
  TSteps extends Record<string, any> = Record<never, never>,
  TCustomMetrics extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly kind: 'harness:flow';
  readonly id: string;
  readonly inputSchema: z.ZodType<TIn, z.ZodTypeDef, any>;
  readonly isolationScope?: IsolationScope<THandle, TReceipt>;
  readonly telemetryCollector?: TelemetryCollector<TCustomMetrics>;
  readonly nodes: readonly FlowNodeConfig<TIn, any, TReceipt, TCustomMetrics>[];
  readonly terminalState?: string;
  input<TSchema extends z.ZodTypeAny>(
    schema: TSchema,
  ): FlowDef<z.infer<TSchema>, THandle, TReceipt, TSteps, TCustomMetrics>;
  scope<TH, TR extends Record<string, unknown>>(
    scope: IsolationScope<TH, TR>,
  ): FlowDef<TIn, TH, TR, TSteps, TCustomMetrics>;
  telemetry<TCustom extends Record<string, unknown>>(
    collector: TelemetryCollector<TCustom>,
  ): FlowDef<TIn, THandle, TReceipt, TSteps, TCustom>;
  step<TStepId extends string, TStepIn, TStepOut>(
    stepId: TStepId,
    executable: StepExecutable<TStepIn, TStepOut, THandle>,
    configure?: (
      $s: FlowStepBuilder<TIn, TStepIn, TSteps, TReceipt, TCustomMetrics>,
    ) => FlowStepBuilder<TIn, TStepIn, TSteps, TReceipt, TCustomMetrics>,
  ): FlowDef<TIn, THandle, TReceipt, TSteps & Record<TStepId, TStepOut>, TCustomMetrics>;
  branch<TBranchId extends string, TBranchOut>(
    branchStepId: TBranchId,
    configure: (
      $b: FlowBranchBuilder<TIn, any, TSteps, TReceipt, TCustomMetrics>,
    ) => FlowBranchBuilder<TIn, TBranchOut, TSteps, TReceipt, TCustomMetrics>,
  ): FlowDef<TIn, THandle, TReceipt, TSteps & Record<TBranchId, TBranchOut>, TCustomMetrics>;
  exit(terminalState: string): FlowDef<TIn, THandle, TReceipt, TSteps, TCustomMetrics>;
}

export interface LaneTrackerConfig<TExternal = any, TIn = any, TExternalState extends string = string> {
  readonly adapter: TrackerAdapter<TExternal, TExternalState>;
  readonly pollIntervalSeconds: number;
  readonly mapper?: (externalItem: TExternal) => TIn | undefined;
  readonly stateMapping: {
    readonly onQueued?: TExternalState;
    readonly onRunning?: TExternalState;
    readonly onWaiting?: TExternalState;
    readonly onErrored?: TExternalState;
    readonly onCancelled?: TExternalState;
    readonly onExit: Readonly<Record<string, TExternalState>>;
  };
}

export interface LaneRetryConfig {
  readonly tries: number;
  readonly exponentialBaseDelayMs: number;
  readonly failTerminalState: string;
}

export interface LaneSignalHandlerConfig<TIn = any, TPayload = any> {
  readonly signal: SignalDef<TPayload>;
  readonly updateMapper?: (current: TIn, signalPayload: TPayload) => TIn;
  readonly rewindToStepId?: string;
  readonly onRewindHook?: ScopeRewindHook<any>;
}

export interface LaneTrackerBuilder<TExternal = any, TIn = any, TExternalState extends string = string> {
  everySeconds(seconds: number): LaneTrackerBuilder<TExternal, TIn, TExternalState>;
  from(mapper: (externalItem: TExternal) => TIn | undefined): LaneTrackerBuilder<TExternal, TIn, TExternalState>;
  onQueued(state: TExternalState): LaneTrackerBuilder<TExternal, TIn, TExternalState>;
  onRunning(state: TExternalState): LaneTrackerBuilder<TExternal, TIn, TExternalState>;
  onWaiting(state: TExternalState): LaneTrackerBuilder<TExternal, TIn, TExternalState>;
  onErrored(state: TExternalState): LaneTrackerBuilder<TExternal, TIn, TExternalState>;
  onCancelled(state: TExternalState): LaneTrackerBuilder<TExternal, TIn, TExternalState>;
  onExit(terminalState: string, externalState: TExternalState): LaneTrackerBuilder<TExternal, TIn, TExternalState>;
}

export interface LaneRetryBuilder {
  tries(count: number): LaneRetryBuilder;
  exponential(baseDelayMs: number): LaneRetryBuilder;
  orFail(terminalState: string): LaneRetryBuilder;
}

export interface LaneSignalBuilder<TIn = any, TPayload = any> {
  update(mapper: (current: TIn, signalPayload: TPayload) => TIn): LaneSignalBuilder<TIn, TPayload>;
  rewindTo(stepId: string, opts?: { readonly onRewind?: ScopeRewindHook<any> }): LaneSignalBuilder<TIn, TPayload>;
}

export interface LaneDef<TIn = any> {
  readonly kind: 'harness:lane';
  readonly id: string;
  readonly inputSchema: z.ZodType<TIn, z.ZodTypeDef, any>;
  readonly keyMapper?: (item: TIn) => string;
  readonly trackerConfig?: LaneTrackerConfig<any, TIn, any>;
  readonly flowDef?: FlowDef<TIn, any, any, any, any>;
  readonly concurrencyLimit: number;
  readonly priorityLevel: 'low' | 'normal' | 'high' | 'critical';
  readonly agingMins?: number;
  readonly waitForConfig?: {
    readonly depsMapper: (item: TIn) => readonly string[];
    readonly onAbandonedState: string;
  };
  readonly maxCostConfig?: {
    readonly limitUsd: number;
    readonly approver: ScopedHumanTarget<z.infer<typeof BudgetApprovalSchema>>;
  };
  readonly retryConfig?: LaneRetryConfig;
  readonly signalHandlers: Readonly<Record<string, LaneSignalHandlerConfig<TIn, any>>>;
  input<TSchema extends z.ZodTypeAny>(schema: TSchema): LaneDef<z.infer<TSchema>>;
  key(mapper: (item: TIn) => string): LaneDef<TIn>;
  tracker<TExternal, TExternalState extends string>(
    adapter: TrackerAdapter<TExternal, TExternalState>,
    configure: (
      $: LaneTrackerBuilder<TExternal, TIn, TExternalState>,
    ) => LaneTrackerBuilder<TExternal, TIn, TExternalState>,
  ): LaneDef<TIn>;
  flow(flow: FlowDef<TIn, any, any, any, any>): LaneDef<TIn>;
  concurrency(limit: number): LaneDef<TIn>;
  priority(level: 'low' | 'normal' | 'high' | 'critical'): LaneDef<TIn>;
  agingMinutes(minutes: number): LaneDef<TIn>;
  waitFor(depsMapper: (item: TIn) => readonly string[], onAbandonedState: string): LaneDef<TIn>;
  maxCostUsd(
    limitUsd: number,
    approver: ScopedHumanTarget<z.infer<typeof BudgetApprovalSchema>>,
  ): LaneDef<TIn>;
  retry(configure: ($: LaneRetryBuilder) => LaneRetryBuilder): LaneDef<TIn>;
  onSignal<TPayload>(
    signal: SignalDef<TPayload>,
    configure: ($s: LaneSignalBuilder<TIn, TPayload>) => LaneSignalBuilder<TIn, TPayload>,
  ): LaneDef<TIn>;
}

export interface HarnessSignalHandlerConfig<TPayload = any> {
  readonly signal: SignalDef<TPayload>;
  readonly notifications: ReadonlyArray<{
    readonly human: HumanDef;
    readonly mapper: (sig: TPayload) => string;
  }>;
}

export interface HarnessSignalBuilder<TPayload = any> {
  notify(human: HumanDef, mapper: (sig: TPayload) => string): HarnessSignalBuilder<TPayload>;
}

export interface HarnessDef {
  readonly kind: 'harness:root';
  readonly id: string;
  readonly ledgerStore?: LedgerStore;
  readonly registeredPools: readonly unknown[];
  readonly registeredStreams: readonly StreamDef<any, any>[];
  readonly registeredLanes: readonly LaneDef<any>[];
  readonly signalHandlers: Readonly<Record<string, HarnessSignalHandlerConfig<any>>>;
  readonly controlPlaneAdapters: readonly ControlPlaneAdapter[];
  ledger(store: LedgerStore): HarnessDef;
  pools(...pools: unknown[]): HarnessDef;
  streams(...streams: StreamDef<any, any>[]): HarnessDef;
  lanes(...lanes: LaneDef<any>[]): HarnessDef;
  onSignal<TPayload>(
    signal: SignalDef<TPayload>,
    configure: ($sig: HarnessSignalBuilder<TPayload>) => HarnessSignalBuilder<TPayload>,
  ): HarnessDef;
  expose(...adapters: ControlPlaneAdapter[]): HarnessDef;
}

export interface StepExecutors {
  executeAgent: <TIn, TOut, TScope>(
    def: AgentDef<TIn, TOut, TScope>,
    input: TIn,
    ctx: StepContext<TScope>,
  ) => Promise<TOut>;
  executeLoop: <TIn, TOut, TScope>(
    def: LoopDef<TIn, TOut, TScope>,
    input: TIn,
    ctx: StepContext<TScope>,
  ) => Promise<TOut>;
}

export function registerStepExecutors(executors: StepExecutors): void;

export const H: {
  env(key: string): EnvRef;
  signal(id: string): SignalDef<unknown>;
  interrupt(id: string): InterruptDef<unknown>;
  stream(id: string): StreamDef<unknown, unknown>;
  pool(id: string): PoolDef<unknown>;
  human(id: string): HumanDef;
  prefixGroup(id: string): PrefixGroupDef;
  topology(id: string): TopologyDef<string>;
  rules(id: string): RulesDef;
  scopedRule(idOrSource: string | Source<ScopedRule>): ScopedRuleDef;
  skill(idOrSource: string | Source<SkillDefinition>): SkillDef;
  lessons(id: string): LessonsDef<unknown>;
  policy(id: string): PolicyDef;
  agent(id: string): AgentDef<unknown, unknown, any>;
  loop(id: string): LoopDef<unknown, unknown, any>;
  flow(id: string): FlowDef<unknown, any, Record<string, unknown>, Record<never, never>, Record<string, unknown>>;
  lane(id: string): LaneDef<unknown>;
  harness(id: string): HarnessDef;
  command<TIn = unknown, TOut = unknown, THandle = any>(
    id: string,
    opts?: {
      readonly inputSchema?: z.ZodType<TIn, z.ZodTypeDef, any>;
      readonly outputSchema?: z.ZodType<TOut, z.ZodTypeDef, any>;
      readonly execute?: (input: TIn, ctx: ExecutionContext<THandle>) => Promise<TOut>;
    },
  ): StepExecutable<TIn, TOut, THandle>;
  check<THandle = any>(
    id: string,
    run: Check<THandle>['run'],
  ): Check<THandle>;
  readonly SpeculationCandidateSchema: typeof SpeculationCandidateSchema;
  readonly SpeculationInputSchema: typeof SpeculationInputSchema;
  readonly ResumeForkInputSchema: typeof ResumeForkInputSchema;
  readonly BudgetApprovalSchema: typeof BudgetApprovalSchema;
  readonly DistilledLessonCandidateSchema: typeof DistilledLessonCandidateSchema;
};
```

### 3.5b `packages/core/src/runtime/index.ts`

In `M1`, `packages/core/src/runtime/index.ts` is authored as a typed compile-time stub exporting `CreateHarnessRuntimeOptions`, `HarnessRuntime`, and a placeholder `createHarnessRuntime` function so `packages/core/src/index.ts` compiles cleanly in `M1` and stays untouched when `M2` replaces `packages/core/src/runtime/index.ts` with the full runtime orchestration engine exports:

```ts
import type { HarnessRuntimeController } from '../ports.js';
import type { FlowDef, HarnessDef } from '../ast.js';

export interface CreateHarnessRuntimeOptions {
  readonly hostRootDir?: string;
}

export interface HarnessRuntime extends HarnessRuntimeController {
  start(): Promise<void>;
  stop(): Promise<void>;
  enqueueToLane<TIn>(
    laneId: string,
    item: TIn,
    opts?: { readonly priorityBoost?: number; readonly parentRunId?: string },
  ): Promise<string>;
  runFlowOnce<TIn, TOut = unknown>(
    flow: FlowDef<TIn, any, any, any, any>,
    input: TIn,
    opts?: { readonly runId?: string; readonly itemKey?: string },
  ): Promise<{
    readonly runId: string;
    readonly status: string;
    readonly output?: TOut;
  }>;
  recoverInterruptedRunsOnBoot(): Promise<void>;
}

export function createHarnessRuntime(
  _harness: HarnessDef,
  _opts?: CreateHarnessRuntimeOptions,
): HarnessRuntime {
  throw new Error('HarnessRuntime is implemented in M2 (@harness-dsl/core/runtime).');
}
```

### 3.6 `packages/core/src/index.ts`

Re-exports `z` from `'zod'`, `H`, `registerStepExecutors`, and all types/interfaces/schemas from `./ports.js`, `./schemas.js`, `./ast.js`, `./json-schema.js`, `./builders.js`, and `./runtime/index.js`.

---

## 4. Critical Implementation Invariants

1. **Zero Domain Leakage (`SPEC.md` §1):** `packages/core` must have zero imports or references to `node:child_process`, POSIX globs, git commands, SQLite, or HTTP vendor endpoints.
2. **Static AST & Callback Purity Validation (`SPEC.md` §1.2):** Inline projection mappers in `.branch()`, `.onInterrupt()`, `.onChildInterrupt()`, `.onSignal()`, and `.mapInput()` are typed as synchronous pure functions; if a user passes an `AsyncFunction` (`fn.constructor.name === 'AsyncFunction'`) to a control-flow projection mapper or predicate, the builder throws a synchronous compilation error at AST construction time.
3. **Opaque `EnvRef` Serialization (`SPEC.md` §1.2 Invariant 3):** `H.env(key)` returns `{ kind: 'harness:env-ref', key }` and never reads `process.env[key]`.
4. **Topological Graph Calculation (`SPEC.md` §3.3):** For `{ db: {}, api: { dependsOn: ['db'] }, web: { dependsOn: ['api'] } }`, `repoTopology.dependentsOf('db')` returns `['api', 'web']` and `repoTopology.affectedBy('db')` returns `['db', 'api', 'web']`; `repoTopology.affectedBy('api')` returns `['api', 'web']`; `repoTopology.affectedBy('web')` returns `['web']`.
5. **Policy Inheritance (`SPEC.md` §3.5):** `basePolicy.extend(newId)` preserves all base `.guard().onViolation()` clauses in declaration order and inherits `.onAbort()` unless overridden, while separating `'deny-with-error'` and `'raise-interrupt'` clause metadata for runtime evaluation.
6. **Agent & Loop Clone Fidelity (`SPEC.md` §3.7.1, §3.8):** `agent.withPolicy(p)` and `agent.withTools(...t)` (and `loop.withPolicy(p)` / `loop.withTools(...t)`) preserve all actor-level `.onInterrupt()` handlers, `.partitions()` extractors, `.prefixGroup()`, `.topology()`, `.rules()`, `.lessons()`, `.skills()`, and `.beforeStop()` gates, and compute deterministic `roleKey` strings.
7. **Capability-Tiered Scope Verification (`SPEC.md` §2.4, §3.5, §3.9):** `H.flow` validates scope capabilities at AST construction time so Tier-1 `IsolationScope` flows (like `SPEC.md` §5 `reconciliationFlow`) compile cleanly when all guarded tools define `describeEffects` and all `.replaceWith()` edges have an `AbortHook`, while rejecting flows that omit `describeEffects` or use `.fork()`/`.speculate()` without `CheckpointableScope`/`BranchableScope`.
8. **`registerStepExecutors` Delegation Hook & `H.pool().strategy(...)` Custom Strategy Disambiguation:**
   - `AgentDef.execute` and `LoopDef.execute` delegate to the executors registered via `registerStepExecutors({ executeAgent, executeLoop })` in `packages/core/src/builders.ts` (throwing an informative error if called before `M2`'s runtime registers its executors).
   - In `PoolDefImpl.strategy(modeOrBuilder)`, if `typeof modeOrBuilder === 'string'`, sets `strategyConfig = { mode: modeOrBuilder }`; if `typeof modeOrBuilder === 'object' && modeOrBuilder !== null && modeOrBuilder.kind === 'harness:pool-strategy'`, sets `strategyConfig = { mode: 'custom', customStrategy: modeOrBuilder }`; if `typeof modeOrBuilder === 'function'`, invokes `(modeOrBuilder as any)(builderInstance, { poolId: this.id, runId: '', retryAttempt: 0, nowMs: 0 })` inside a `try/catch` (or checks whether the returned value is the `PoolStrategyBuilder` instance): if the returned value is the `PoolStrategyBuilder` instance, extracts its built `PoolStrategyConfig<TItem>`, otherwise treats `modeOrBuilder` as a `PoolSelectorFn<TItem>` with `strategyConfig = { mode: 'custom', customStrategy: modeOrBuilder as PoolSelectorFn<TItem> }`.
9. **Cross-Boundary Runtime Contracts Frozen in `ports.ts`:**
   - **Speculative `forkId` Convention:** `.speculate()` passes `forkId = "speculate-${callId}-branch-${branchIndex}"` to `BranchableScope.forkChild`, allowing `@harness-dsl/git` to parse `/branch-(\d+)$/` to set `handle.branchIndex` and register live candidate handles by `${runId}:${branchIndex}`.
   - **Account/Model Descriptors, Custom `PoolStrategy` Contracts & HTTP `429` Rate-Limit Error Contract:** `AccountSeatDescriptor`, `ModelDescriptor`, `PoolCandidateState<TItem>`, `PoolSelectionContext`, `PoolSelectorFn<TItem>`, and `PoolStrategyPort<TItem>` define the structural contracts shared between `@harness-dsl/core` (`PoolScheduler`) and `@harness-dsl/claude` / `@harness-dsl/openai` / custom pool strategies; on HTTP `429`, `ModelDriver.invokeTurn` throws an error carrying `{ status: 429, resetAtMs?: number }`.
   - **`ReconcileResult` Conflict Paths, `ConfigurableLedgerStore`, and `PartitionMap`:** `ReconcileResult` includes `readonly conflictedPaths?: readonly string[]` on its `'conflict'` variant; `CompactionRuleConfig`, `LedgerCompactionBuilder`, and `ConfigurableLedgerStore` define the ledger compaction contract shared with `@harness-dsl/sqlite` and `@harness-dsl/postgres`; `PartitionGlobEntry` and `PartitionMap<TPartition>` define the partition-to-glob contract shared with `@harness-dsl/fs` and `@harness-dsl/git`.

---

## 5. Required Test Suite (`packages/core/test/builders.test.ts`)

1. **`H.topology` DAG, `H.pool` Custom Strategies & Transitive Dependents:** Verifies `dependentsOf` and `affectedBy` on `db -> api -> web` and diamond graphs, verifies cycle detection throws at build time, verifies generic signal inference on `.commitOverlayWhen({ onSignal, discardOnSignal })`, and verifies `H.pool().strategy(...)` with presets (`'soonest-reset'`, `'round-robin'`, `'least-used'`), `($) => $.escalateOnRetry().minSuccessRate(0.8).minSamples(5)`, `($) => $.custom(fn)`, a `PoolStrategyPort<TItem>` object, and a direct `PoolSelectorFn<TItem>` callback.
2. **`H.policy` Chaining & `.extend()` Inheritance:** Verifies multiple `.guard().onViolation()` clauses (`guardClauses`), `'deny-with-error'` vs `'raise-interrupt'` typing, `.tripwire()`, `.maxTurns()`, `.maxCostUsd()`, `.onAbort()`, and `.onLimitExceeded()` inheritance across `workerBasePolicy.extend('fast-path-limits')`.
3. **`H.agent` & `H.loop` Clones (`.withPolicy` / `.withTools`) & `registerStepExecutors`:** Verifies deterministic `roleKey` generation, readonly compiled AST properties, `registerStepExecutors` delegation, and preservation of actor-level `.onInterrupt(leaseRequest)` handlers, `.partitions()`, `.prefixGroup()`, and `.beforeStop()` across `guardedWorker` and `verifiedWorkerLoop.withPolicy(fastPathPolicy)` and `verifiedWorkerLoop.withTools(...)`.
4. **Core Schemas & `SpeculationInputSchema`:** Verifies `SpeculationCandidateSchema`, `SpeculationInputSchema`, `BudgetApprovalSchema`, `ResumeForkInputSchema`, `GlobalRuleSchema`, and `ScopedRuleSchema` validation and `.default(...)` schema assignability (`z.ZodType<T, z.ZodTypeDef, any>`).
5. **Capability-Tiered Scope Static Validation & `H.flow` Step/Telemetry Typing:** Verifies that a Tier-1 `IsolationScope` flow (`SPEC.md` §5 pattern) succeeds when tools define `describeEffects` and `.onAbort()` is provided, throws when a guarded tool omits `describeEffects` on a non-`CheckpointableScope`, throws when `.fork()` or `.speculate()` is used on a non-`BranchableScope`, and preserves `steps[branchStepId]`, `telemetry.custom`, and `telemetry.abortMeta` types across `.telemetry()`, `.branch()`, `.onAbort()`, and `.replaceWith()`.
6. **Forbidden Async Closure Detection:** Verifies that passing an `async` function as a control-flow predicate or mapper in `.branch()`, `.onInterrupt()`, or `.onSignal()` throws a build-time error.
7. **`zodToJsonSchema` Conversion:** Verifies deterministic JSON Schema generation for nested objects, enums, arrays, defaults, and discriminated unions.

---

## 6. Verification Gate Commands

```bash
pnpm install --prefer-offline
pnpm check:comments
pnpm --filter @harness-dsl/core typecheck
pnpm --filter @harness-dsl/core test
```
