# Paraharness

**Declarative multi-agent orchestration and durable execution for TypeScript.** [→ Documentation & API Reference](https://paraharness.github.io/paraharness/)

Paraharness is a TypeScript framework for building autonomous LLM agent systems that run over isolated workspaces. Instead of writing ad-hoc prompt loops and unguarded shell tools, you declare agents, capability policies, verification loops, and multi-step flows with the `P.*` DSL, compile them into a pure passive AST, and execute them on a crash-recoverable runtime (`@paraharness/core/runtime`).

## Installation

With npm:

```bash
npm install @paraharness/core zod
```

With yarn:

```bash
yarn add @paraharness/core zod
```

With pnpm:

```bash
pnpm add @paraharness/core zod
```

## Quick Start

```ts
import { P, z } from '@paraharness/core';
import { createRuntime, runFlow, runStep } from '@paraharness/core/runtime';
import { claude, claudeExecutors } from '@paraharness/claude';
import { fs, fsExecutors } from '@paraharness/fs';
import { git, gitExecutors } from '@paraharness/git';
import { local, nodeExecutors } from '@paraharness/node';
import { sqlite, sqliteExecutors } from '@paraharness/sqlite';

const TaskInput = z.object({
  taskId: z.string(),
  prompt: z.string(),
});

const runner = local.runner({ slots: 4, maxDaemons: 2 });
const sonnet = claude.model('claude-sonnet-4-6');

const verifySuite = local
  .streamCheck('verify-suite')
  .runner(runner)
  .argv(['pnpm', 'test', '--run'])
  .circuitBreakWhenStdout(/FAIL/);

const worker = P.agent('worker')
  .model(sonnet)
  .tools(fs.codingTools(), verifySuite.asTool())
  .instructions('Implement the requested change and keep all checks passing.')
  .beforeStop(verifySuite)
  .input(TaskInput)
  .output(z.object({ summary: z.string() }));

const stepOut = await runStep(
  worker,
  { taskId: 'task-1', prompt: 'Add input validation' },
  {
    registry: [claudeExecutors, fsExecutors, nodeExecutors],
    env: process.env,
  },
);

const deliveryFlow = P.flow('delivery-flow')
  .input(TaskInput)
  .scope(git.cowWorktree())
  .step('implement', worker)
  .exit('done');

const flowResult = await runFlow(
  deliveryFlow,
  { taskId: 'task-1', prompt: 'Add input validation' },
  {
    registry: [claudeExecutors, fsExecutors, gitExecutors, nodeExecutors, sqliteExecutors],
    ledger: sqlite.ledger('.harness/state.sqlite'),
    env: process.env,
  },
);

const harness = P.harness('engineering-harness')
  .ledger(sqlite.ledger('.harness/state.sqlite'))
  .pools(runner)
  .lanes(
    P.lane('main-lane')
      .input(TaskInput)
      .key((item) => item.taskId)
      .runs(deliveryFlow)
      .concurrency(2)
      .priority('normal'),
  );

const runtime = createRuntime(harness, {
  registry: [claudeExecutors, fsExecutors, gitExecutors, nodeExecutors, sqliteExecutors],
  env: process.env,
});
await runtime.start();
```

## Usage

### Policy Guardrails & Post-Flight Rollbacks

Attach `P.policy` masks to restrict what files an agent can mutate, intercept edits to existing tests via typed `P.interrupt` escalations, and enforce turn and budget ceilings with automatic workspace rollback if a subprocess mutates protected paths:

```ts
import { P, z } from '@paraharness/core';
import { fs } from '@paraharness/fs';
import { git } from '@paraharness/git';

const leaseRequest = P.interrupt(
  'lease-request',
  z.object({
    requestedPaths: z.array(z.string()),
    justification: z.string(),
  }),
);

const workerPolicy = P.policy('worker-policy')
  .guard(fs.protect(['packages/*/src/index.ts', 'PRODUCT_SPEC.md', '.harness/**']))
  .onViolation('deny-with-error')
  .guard(
    fs.writeGuard({
      denyGlobs: ['**/*.test.ts', '**/*.test.tsx'],
      onlyExistingAtBaseRef: true,
    }),
  )
  .onViolation('raise-interrupt', leaseRequest, (violation) => ({
    requestedPaths: fs.violatedPaths(violation),
    justification: violation.violationSummary,
  }))
  .tripwire(fs.maxFilesMutated(6))
  .maxTurns(12)
  .maxCostUsd(2.0)
  .onAbort(git.snapshotAndReset());
```

### Act-Evaluate Verification Loops

Pair a write-capable implementation agent with a read-only adversarial evaluator inside `P.loop`. Rejected iterations append structured deficits directly onto the actor's preserved session until all checks and review criteria pass:

```ts
import { P, z } from '@paraharness/core';
import { fs } from '@paraharness/fs';
import { git } from '@paraharness/git';

const readOnlyPolicy = P.policy('read-only')
  .guard(fs.readOnly())
  .onViolation('deny-with-error');

const evaluator = P.agent('evaluator')
  .model(sonnet)
  .policy(readOnlyPolicy)
  .tools(fs.readOnlyTools(runner))
  .instructions('Audit the candidate diff and reject if any edge cases or tests are missing.')
  .input(
    z.object({
      task: TaskInput,
      candidate: z.object({ summary: z.string() }),
      scopeReceipt: git.ScopeReceiptSchema,
    }),
  )
  .output(
    z.object({
      accepted: z.boolean(),
      deficits: z.array(z.string()),
    }),
  );

const verifiedWorkerLoop = P.loop('verified-worker-loop')
  .input(TaskInput)
  .output(z.object({ summary: z.string() }))
  .maxIterations(3)
  .preserveActorSession(true)
  .act('execute', worker.withPolicy(workerPolicy))
  .evaluate('audit', evaluator, {
    mapInput: (task, candidate, scopeReceipt) => ({ task, candidate, scopeReceipt }),
    acceptWhen: (ev) => ev.accepted && ev.deficits.length === 0,
    feedbackMapper: (ev) => `Resolve these deficits:\n- ${ev.deficits.join('\n- ')}`,
  })
  .returnOutputFrom('execute');
```

### Parallel Subagent Forks & Speculative Tournaments

Equip coordinator agents with `.fork()` for isolated child worktree delegation and `.speculate()` to race competing implementation strategies across parallel Copy-on-Write worktrees judged by an arbiter:

```ts
import { P, z } from '@paraharness/core';
import { git } from '@paraharness/git';

const coordinator = P.agent('coordinator')
  .model(sonnet)
  .tools(fs.codingTools(runner), git.refReaderTools(runner))
  .instructions('Decompose tasks across partitions or run speculative tournaments for high-risk changes.')
  .input(TaskInput)
  .output(z.object({ summary: z.string() }))
  .capabilities(($cap) =>
    $cap
      .fork('delegate-subtask', verifiedWorkerLoop, ($f) =>
        $f
          .historyMode('shared-prefix-only')
          .requestSchema(z.object({ subtaskPrompt: z.string() }))
          .mapInput((parent, req) => ({
            taskId: parent.taskId,
            prompt: req.subtaskPrompt,
          })),
      )
      .speculate('explore-candidates', ($s) =>
        $s
          .requestSchema(
            z.object({
              strategyA: z.string(),
              strategyB: z.string(),
            }),
          )
          .worker(verifiedWorkerLoop)
          .branches(2, (parent, req) => [
            { taskId: parent.taskId, prompt: req.strategyA },
            { taskId: parent.taskId, prompt: req.strategyB },
          ])
          .arbiter(candidateArbiter, {
            resolveDecision: (verdict) => verdict,
          }),
      ),
  );
```

### Warm-Fork Prefix Caching, Topology & Empirical Lessons

Pin byte-identical system prompts across agent roles with `P.prefixGroup`, declare partition dependency graphs with `P.topology`, and distill empirical lessons from loop and gate recoveries with `P.lessons`:

```ts
import { P } from '@paraharness/core';
import { fs } from '@paraharness/fs';
import { md } from '@paraharness/markdown';
import { sqlite } from '@paraharness/sqlite';

const repoTopology = P.topology('repo-topology')
  .store(sqlite.topologyStore('.harness/state.sqlite'))
  .partitions({
    db: {},
    api: { dependsOn: ['db'] },
    web: { dependsOn: ['api'] },
  });

const repoRules = P.rules('repo-rules')
  .global(md.globalRules('.harness/rules/global/*.md'))
  .scoped(md.scopedRules('.harness/rules/scoped/*.md'));

const sharedPrefix = P.prefixGroup('engineering-prefix')
  .toolsMode('role-scoped')
  .sharedGrounding(fs.text('PRODUCT_SPEC.md'), fs.text('TECH_DESIGN.md'))
  .sharedInstructions(fs.text('.harness/prompts/base-posture.md'))
  .sharedRules(repoRules);

const repoLessons = P.lessons('repo-lessons')
  .store(sqlite.lessonStore('.harness/state.sqlite'))
  .queryFrom(TaskInput, (item) => item.prompt)
  .distillWith(sonnet, ($d) => $d.onLoopRecovery().onGateRecovery({ minFailedChecks: 1 }));
```

## Packages

| Package | Description |
| :--- | :--- |
| [`@paraharness/core`](https://paraharness.github.io/paraharness/modules/_paraharness_core.html) | Core declarative `P.*` DSL builders, AST contracts, port interfaces, and durable execution runtime (`@paraharness/core/runtime`) |
| [`@paraharness/node`](https://paraharness.github.io/paraharness/modules/_paraharness_node.html) | Local OS subprocess runner pools, one-shot commands, circuit-breaking stream checks, PTY daemons, and MCP control planes (`local.*`, `mcp.*`) |
| [`@paraharness/git`](https://paraharness.github.io/paraharness/modules/_paraharness_git.html) | Copy-on-Write Git worktree isolation scope, git-index checkpoints, 3-way `merge-tree` reconciliation, and candidate comparison tools (`git.*`) |
| [`@paraharness/fs`](https://paraharness.github.io/paraharness/modules/_paraharness_fs.html) | Workspace-jailed file tools, glob matchers, pre/post-flight write guards, quota tripwires, and atomic JSONL lesson store (`fs.*`) |
| [`@paraharness/markdown`](https://paraharness.github.io/paraharness/modules/_paraharness_markdown.html) | Frontmatter and section-aware Markdown loaders for global rules, scoped rules, and on-demand skills (`md.*`) |
| [`@paraharness/sqlite`](https://paraharness.github.io/paraharness/modules/_paraharness_sqlite.html) | WAL-mode SQLite drivers for `LedgerStore`, Copy-on-Write `TopologyStore`, `LessonStore`, and global rules (`sqlite.*`) |
| [`@paraharness/postgres`](https://paraharness.github.io/paraharness/modules/_paraharness_postgres.html) | Distributed PostgreSQL drivers for `LedgerStore`, Copy-on-Write `TopologyStore`, `LessonStore`, and global rules (`postgres.*`) |
| [`@paraharness/lockfile`](https://paraharness.github.io/paraharness/modules/_paraharness_lockfile.html) | Cross-process advisory lockfile utility with `p-queue` in-process serialization, heartbeat, and stale lock reclamation (`withFileLock`) |
| [`@paraharness/claude`](https://paraharness.github.io/paraharness/modules/_paraharness_claude.html) | Anthropic Claude `/v1/messages` `ModelDriver` and AST builders (`claude.cliAccount`, `claude.model`) |
| [`@paraharness/openai`](https://paraharness.github.io/paraharness/modules/_paraharness_openai.html) | OpenAI Responses API & Codex CLI `ModelDriver` and AST builders (`openai.account`, `openai.cliAccount`, `openai.model`) |
| [`@paraharness/gemini`](https://paraharness.github.io/paraharness/modules/_paraharness_gemini.html) | Google Gemini `generateContent` `ModelDriver` and AST builders (`gemini.account`, `gemini.cliAccount`, `gemini.model`) |
| [`@paraharness/github`](https://paraharness.github.io/paraharness/modules/_paraharness_github.html) | GitHub Issues tracker adapter, HMAC-SHA256 webhook event stream source, and idempotent pull-request step executor (`github.*`) |
| [`@paraharness/slack`](https://paraharness.github.io/paraharness/modules/_paraharness_slack.html) | Slack Socket Mode interactive human approval / control-plane adapter and incoming webhook notifier (`slack.*`) |

## Documentation

- [`@paraharness/core` API Reference](https://paraharness.github.io/paraharness/modules/_paraharness_core.html)
- [`@paraharness/core/runtime` API Reference](https://paraharness.github.io/paraharness/modules/_paraharness_core.runtime.html)

## License

[MIT](./LICENSE) © Tornike Tsomaia
