import { z } from 'zod';
import { H } from 'harness-dsl';
import type { AccountView, Account } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { claudeCode } from 'harness-dsl/claude-code';
import { linear } from 'harness-dsl/linear';
import { folder } from 'harness-dsl/folder';
import { git } from 'harness-dsl/git';
import { shell } from 'harness-dsl/shell';
import { markdown } from 'harness-dsl/markdown';

const sharedMeter = sqlite.meter('~/.harness/shared/accounts.db');
const subscriptionA = claudeCode.subscription('max-a', { configDir: H.env('CLAUDE_CONFIG_A'), meter: sharedMeter });
const subscriptionB = claudeCode.subscription('max-b', { configDir: H.env('CLAUDE_CONFIG_B'), meter: sharedMeter });
const subscriptionC = claudeCode.subscription('max-c', { configDir: H.env('CLAUDE_CONFIG_C'), meter: sharedMeter });
const sharedAccounts = [subscriptionA, subscriptionB, subscriptionC];

const Taste = H.memory('taste', { authority: 'owner' });
const Experience = H.memory('experience', { authority: 'observed' });
const sharedTaste = H.journal('owner-taste', Taste)
  .store(jsonl.store('~/.harness/shared/taste.jsonl'))
  .recall(H.recall.bySpecificity({ limit: 20 }));

const resetTime = (account: AccountView) =>
  account.resetsAt === null ? Number.MAX_SAFE_INTEGER : account.resetsAt.getTime();

const cappedPool = (name: string, accounts: readonly Account[], share: number) =>
  H.pool(name)
    .accounts(accounts.map((account) => ({ account, share })))
    .order((views) => [...views].filter((view) => view.eligible).sort((a, b) => resetTime(a) - resetTime(b)));

const sonnet = claudeCode.model('sonnet');
const opus = claudeCode.model('opus');
const local = shell.local({ slots: 4 });

const Todo = H.state('todo', 'runnable');
const Done = H.state('done', 'succeeded');
const Abandoned = H.state('abandoned', 'failed');
const Cancelled = H.state('cancelled', 'cancelled');
const Stale = H.state('stale', 'runnable');
const Published = H.state('published', 'succeeded');
const BrokenLinks = H.state('broken-links', 'failed');

const ticketData = z.object({ id: z.string(), title: z.string(), description: z.string() });

const Bug = H.kind('Bug', { data: ticketData, key: (bug) => bug.id })
  .states([Todo, Done, Abandoned, Cancelled], { initial: Todo })
  .on('cancel', { from: [Todo], to: Cancelled, attempt: 'cancel' });
const Feature = H.kind('Feature', { data: ticketData, key: (feature) => feature.id })
  .states([Todo, Done, Abandoned, Cancelled], { initial: Todo })
  .on('cancel', { from: [Todo], to: Cancelled, attempt: 'cancel' });

const codingExperience = H.journal('coding-experience', Experience)
  .store(jsonl.store('.harness/memory/experience.jsonl'))
  .recall(H.recall.bySpecificity({ limit: 12 }));

const codingPool = cappedPool('coding-subscriptions', sharedAccounts, 0.6);

const builderModel = H.choose('builder-model', [sonnet, opus], (query, context) => {
  const cheap = context.metrics.successRate({ kind: { name: query.kind }, days: 14, model: sonnet, agent: query.agent });
  return cheap.samples >= 20 && cheap.value !== null && cheap.value < 0.85 ? opus : sonnet;
});

const projectChecks = H.command('project-checks', {
  input: z.object({ workspacePath: z.string() }),
  argv: (input) => ['npm', '--prefix', input.workspacePath, 'run', 'check'],
  runner: local,
});

const Files = H.resource('file');
const worktree = git.worktree({ repo: '.', baseBranch: 'main' });

const builder = H.agent(
  'builder',
  H.role('builder', {
    prompt: 'Implement the work item in the worktree, addressing every listed deficit.',
    intents: ['read', 'edit', 'execute', 'ask'],
    input: z.object({ title: z.string(), description: z.string(), round: z.number(), deficits: z.array(z.string()) }),
    output: z.object({ summary: z.string() }),
  }),
)
  .model(builderModel)
  .pool(codingPool)
  .recall(codingExperience, sharedTaste)
  .workspace(worktree)
  .guard(H.guard.lease(Files), H.guard.beforeStop(projectChecks));

const auditor = H.agent(
  'auditor',
  H.role('auditor', {
    prompt: 'Audit the change against the work item and list each deficit.',
    intents: ['read', 'execute'],
    input: z.object({ title: z.string(), description: z.string(), summary: z.string() }),
    output: z.object({ deficits: z.array(z.string()) }),
  }),
)
  .model(opus)
  .pool(codingPool)
  .recall(codingExperience)
  .record(codingExperience)
  .workspace(worktree);

const buildAndAudit = H.flow(
  'build-and-audit',
  { input: ticketData, params: z.object({ rounds: z.number() }), exits: ['done', 'abandoned'] },
  async (ctx) => {
    let deficits: string[] = [];
    for (let round = 1; round <= ctx.params.rounds; round += 1) {
      const build = await ctx.run(`build-${round}`, builder, {
        title: ctx.input.title,
        description: ctx.input.description,
        round,
        deficits,
      });
      const audit = await ctx.run(`audit-${round}`, auditor, {
        title: ctx.input.title,
        description: ctx.input.description,
        summary: build.summary,
      });
      if (audit.deficits.length === 0) {
        return ctx.exit('done');
      }
      deficits = audit.deficits;
    }
    return ctx.exit('abandoned');
  },
);

const linearKey = H.env('LINEAR_API_KEY');
const trackerStore = linear.store({ team: 'ENG', apiKey: linearKey });

const bugLane = H.lane('bugs', Bug)
  .supply(
    linear.issues({ team: 'ENG', apiKey: linearKey, labels: ['bug'] }).to(Bug, (issue, unit) =>
      unit.create({ id: issue.identifier, title: issue.title, description: issue.description }),
    ),
    H.supply.operator(Bug),
  )
  .store(trackerStore)
  .handle(Todo, buildAndAudit, { params: { rounds: 3 }, exits: { done: Done, abandoned: Abandoned } })
  .limit({ wip: 2 });

const featureLane = H.lane('features', Feature)
  .supply(
    linear.issues({ team: 'ENG', apiKey: linearKey, labels: ['feature'] }).to(Feature, (issue, unit) =>
      unit.create({ id: issue.identifier, title: issue.title, description: issue.description }),
    ),
    H.supply.operator(Feature),
  )
  .store(trackerStore)
  .handle(Todo, buildAndAudit, { params: { rounds: 5 }, exits: { done: Done, abandoned: Abandoned } });

export const codingHarness = H.harness('coding-team')
  .ledger(sqlite.ledger('coding/.harness/ledger.db'))
  .lanes([bugLane, featureLane])
  .journals([codingExperience, sharedTaste])
  .scheduler(
    H.scheduler('bugs-then-features', (query) => ({
      order: [...query.pending].sort((a, b) => Number(b.is(Bug)) - Number(a.is(Bug)) || b.waitingSeconds - a.waitingSeconds),
    })),
  )
  .clients([
    H.client('coding-supervisor', claudeCode.session({ port: H.slot.port(0) })).grant([
      H.ops.readWork,
      H.ops.writeWork,
      H.ops.resolveBlockers,
      H.ops.writeMemory,
      H.ops.readTelemetry,
      H.ops.readAccounts,
      H.ops.writeShares,
    ]),
  ])
  .observers([markdown.board('coding/BOARD.md'), markdown.telemetry('coding/TELEMETRY.md')]);

const DocPage = H.kind('DocPage', {
  data: z.object({ path: z.string(), title: z.string(), body: z.string() }),
  key: (page) => page.path,
})
  .states([Stale, Published, BrokenLinks, Cancelled], { initial: Stale })
  .on('cancel', { from: [Stale], to: Cancelled, attempt: 'cancel' });

const docsExperience = H.journal('docs-experience', Experience)
  .store(jsonl.store('docs/.harness/memory/experience.jsonl'))
  .recall(H.recall.bySpecificity({ limit: 10 }));

const docsPool = cappedPool('docs-subscriptions', sharedAccounts, 0.3);

const writer = H.agent(
  'writer',
  H.role('writer', {
    prompt: 'Rewrite the documentation page so it is accurate, complete and in the house voice.',
    intents: ['read'],
    input: z.object({ title: z.string(), body: z.string() }),
    output: z.object({ body: z.string() }),
  }),
)
  .model(sonnet)
  .pool(docsPool)
  .recall(docsExperience, sharedTaste)
  .record(docsExperience);

const linkCheck = H.command('link-check', {
  input: z.object({ body: z.string() }),
  argv: (input) => ['markdown-link-check', '--text', input.body],
  runner: local,
});

const writePage = H.flow(
  'write-page',
  {
    input: z.object({ title: z.string(), body: z.string() }),
    writes: z.object({ body: z.string() }),
    exits: ['published', 'brokenLinks'],
  },
  async (ctx) => {
    const draft = await ctx.run('write', writer, { title: ctx.input.title, body: ctx.input.body });
    const links = await ctx.try('link-check', linkCheck, { body: draft.body });
    return links.ok ? ctx.exit('published', { body: draft.body }) : ctx.exit('brokenLinks');
  },
);

const docPageLane = H.lane('doc-pages', DocPage)
  .supply(
    folder
      .files({ dir: 'docs/pages', frontmatter: z.object({ title: z.string() }) })
      .to(DocPage, (file, unit) => unit.create({ path: file.path, title: file.frontmatter.title, body: file.body })),
  )
  .store(folder.store({ dir: 'docs/pages' }))
  .handle(Stale, writePage, { exits: { published: Published, brokenLinks: BrokenLinks } })
  .limit({ wip: 2 });

export const docsHarness = H.harness('documentation')
  .ledger(sqlite.ledger('docs/.harness/ledger.db'))
  .lanes([docPageLane])
  .journals([docsExperience, sharedTaste])
  .scheduler(
    H.scheduler('oldest-first', (query) => ({
      order: [...query.pending].sort((a, b) => b.waitingSeconds - a.waitingSeconds),
    })),
  )
  .clients([
    H.client('docs-supervisor', claudeCode.session({ port: H.slot.port(1) })).grant([
      H.ops.readWork,
      H.ops.writeWork,
      H.ops.resolveBlockers,
      H.ops.writeMemory,
      H.ops.readTelemetry,
      H.ops.readAccounts,
      H.ops.writeShares,
    ]),
  ])
  .observers([markdown.board('docs/BOARD.md'), markdown.telemetry('docs/TELEMETRY.md')]);
