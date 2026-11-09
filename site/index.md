---
layout: home

hero:
  name: Paraharness
  text: Declarative Multi-Agent Orchestration for TypeScript
  tagline: Compile agents, tools, policies, and flows into a pure passive AST. Execute them durably across isolated scopes, model pools, and human escalations.
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: Packages
      link: /packages/core
    - theme: alt
      text: API Reference
      link: /api/@paraharness/core/
    - theme: alt
      text: GitHub
      link: https://github.com/paraharness/paraharness

features:
  - title: Pure Passive AST & Late Binding
    details: Declare agents, policies, loops, and flows with the P.* DSL. Builders emit serializable AST nodes with zero I/O at construction time and bind to concrete executors at runtime.
  - title: Pre-Flight & Post-Flight Sandboxing
    details: Enforce capability policies before tool invocation and verify filesystem and git effects after execution, automatically rolling back unauthorized mutations or raising typed interrupts.
  - title: Copy-on-Write Worktree Forking & Speculation
    details: Delegate parallel subtasks across isolated Git CoW worktrees with .fork() or race competing implementation strategies in speculative tournaments judged by an arbiter with .speculate().
  - title: Durable Crash Recovery & Warm KV Prefixes
    details: Persist every turn, continuation frame, and checkpoint to SQLite or PostgreSQL ledgers while pinning byte-identical system prefixes across roles with P.prefixGroup.
  - title: Evidence-Based Lesson Distillation
    details: Capture contrastive recovery trajectories from act-evaluate loops and beforeStop gates, distilling reusable empirical lessons scored by recency, confidence, and partition affinity.
  - title: 13 Composable Packages
    details: Mix and match first-party model drivers (Claude, OpenAI, Gemini), execution sandboxes (Git, FS, Node, Markdown), and storage/control adapters (SQLite, Postgres, GitHub, Slack).
---

## Quick Start

Install the core DSL and runtime along with your chosen model, scope, and ledger drivers:

```bash
npm install @paraharness/core @paraharness/claude @paraharness/fs @paraharness/git @paraharness/node @paraharness/sqlite zod
```

Declare an agent, mount it inside an isolated Copy-on-Write Git worktree flow, and start the durable runtime:

```ts
import { P, z } from '@paraharness/core';
import { createExecutorRegistry, createRuntime } from '@paraharness/core/runtime';
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
const sonnet = claude.model('sonnet', { id: 'claude-sonnet-4-6' });

const verifySuite = local
  .streamCheck('verify-suite')
  .runner(runner)
  .argv(['pnpm', 'test', '--run'])
  .circuitBreakWhenStdout(/FAIL/, { graceLinesAfterMatch: 25 });

const worker = P.agent('worker')
  .model(sonnet)
  .tools(fs.codingTools(runner), verifySuite.asTool())
  .instructions('Implement the requested change and keep all checks passing.')
  .beforeStop(verifySuite)
  .input(TaskInput)
  .output(z.object({ summary: z.string() }));

const deliveryFlow = P.flow('delivery-flow')
  .input(TaskInput)
  .scope(git.cowWorktree({ repo: '.', dir: '.harness/worktrees' }))
  .step('implement', worker)
  .exit('done');

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

const registry = createExecutorRegistry(
  claudeExecutors,
  fsExecutors,
  gitExecutors,
  nodeExecutors,
  sqliteExecutors,
);

const runtime = createRuntime(harness, { registry, env: process.env });
await runtime.start();
```
