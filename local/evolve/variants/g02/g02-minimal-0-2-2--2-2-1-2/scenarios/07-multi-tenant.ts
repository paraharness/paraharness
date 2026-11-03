import { H } from 'harness-dsl';
import type { PendingView } from 'harness-dsl';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as linear from 'harness-dsl/linear';
import * as folder from 'harness-dsl/folder';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as git from 'harness-dsl/git';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';
import { z } from 'zod';

const sharedQuota = sqlite.quota('~/.harness/shared/quota.sqlite');

const maxOne = claudeCode.subscription('max-1', { token: H.env('CLAUDE_MAX_1_TOKEN'), quota: sharedQuota });
const maxTwo = claudeCode.subscription('max-2', { token: H.env('CLAUDE_MAX_2_TOKEN'), quota: sharedQuota });
const maxThree = claudeCode.subscription('max-3', { token: H.env('CLAUDE_MAX_3_TOKEN'), quota: sharedQuota });
const apiAccount = anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota: sharedQuota });

const soonestExpiring = H.policy.account('soonest-expiring', choice => {
  const open = choice.accounts.filter(view => view.eligible && view.usedShare < view.share);
  const subscriptions = open
    .filter(view => view.account.plan === 'subscription')
    .sort((a, b) => (a.windowEndsAt?.getTime() ?? Number.MAX_SAFE_INTEGER) - (b.windowEndsAt?.getTime() ?? Number.MAX_SAFE_INTEGER));
  const metered = open.filter(view => view.account.plan === 'metered');
  return subscriptions[0]?.account ?? metered[0]?.account ?? null;
});

const sonnet = claudeCode.model('claude-sonnet');
const haiku = claudeCode.model('claude-haiku');

const taste = H.memory('taste', 'taste');
const experience = H.memory('experience', 'experience');
const ownerTaste = H.library('owner-taste', taste, jsonl.memory('~/.harness/shared/taste.jsonl'));

const productPool = H.pool('product-claude', [
  { account: maxOne, share: 0.6 },
  { account: maxTwo, share: 0.6 },
  { account: maxThree, share: 0.6 },
  { account: apiAccount, share: 1 },
], soonestExpiring);

const productExperience = H.library('product-experience', experience, jsonl.memory('product/.harness/experience.jsonl'));

const todo = H.state('todo', 'pending');
const done = H.state('done', 'terminal', 'success');
const abandoned = H.state('abandoned', 'terminal', 'failure');

const workItem = z.object({ title: z.string(), description: z.string() });
const bug = H.kind('Bug').data(workItem).states(todo, done, abandoned);
const feature = H.kind('Feature').data(workItem).states(todo, done, abandoned);

const epicOpen = H.state('open', 'pending');
const decomposed = H.state('decomposed', 'waiting');
const complete = H.state('complete', 'terminal', 'success');
const dropped = H.state('dropped', 'terminal', 'failure');
const epic = H.kind('Epic').data(workItem).states(epicOpen, decomposed, complete, dropped);

const due = H.state('due', 'pending');
const healthy = H.state('healthy', 'terminal', 'success');
const unhealthy = H.state('unhealthy', 'terminal', 'failure');
const heartbeat = H.kind('ServiceHeartbeat').data(z.object({ service: z.string() })).states(due, healthy, unhealthy);

const worktrees = git.worktree('product-worktrees', { repo: 'product', slots: 3 });
const local = shell.local('product-local', { slots: 4 });

const projectChecks = H.command('project-checks').argv(() => ['npm', 'run', 'check']).on(worktrees);

const buildRole = H.role('build')
  .input(z.object({ title: z.string(), description: z.string(), deficits: z.array(z.string()) }))
  .output(z.object({ summary: z.string(), question: z.string().optional() }))
  .prompt(input => `Build: ${input.title}\n${input.description}\nOpen deficits:\n${input.deficits.join('\n')}`)
  .intents(['read', 'edit', 'execute']);

const auditRole = H.role('audit')
  .input(z.object({ title: z.string(), description: z.string(), summary: z.string() }))
  .output(z.object({ deficits: z.array(z.string()) }))
  .prompt(input => `Audit the change for "${input.title}".\n${input.description}\nBuilder summary: ${input.summary}`)
  .intents(['read', 'execute']);

const planRole = H.role('plan')
  .input(z.object({ title: z.string(), description: z.string() }))
  .output(z.object({ features: z.array(workItem) }))
  .prompt(input => `Decompose the epic "${input.title}" into features.\n${input.description}`)
  .intents(['read']);

const builderModel = H.policy.model('builder-model', [haiku, sonnet], choice => {
  const cheap = choice.metrics.successRate({ kind: choice.kind, model: haiku, days: 14 });
  return cheap.samples >= 20 && cheap.value !== null && cheap.value < 0.85 ? sonnet : haiku;
});

const builder = H.seat('builder', buildRole)
  .model(builderModel)
  .on(worktrees)
  .recalls(productExperience, ownerTaste)
  .guards(claudeCode.fileLeases(), claudeCode.stopCheck(projectChecks));

const auditor = H.seat('auditor', auditRole)
  .model(sonnet)
  .on(worktrees)
  .recalls(productExperience)
  .records(productExperience);

const planner = H.seat('planner', planRole).model(sonnet).recalls(ownerTaste);

const ownerDecision = H.halt('owner-decision', z.object({ proceed: z.boolean(), guidance: z.string() }));

const buildAndAudit = H.flow('build-and-audit')
  .for(bug, feature)
  .params(z.object({ rounds: z.number() }))
  .does(async ctx => {
    const { title, description } = ctx.unit.data;
    let deficits: string[] = [];
    for (let round = 1; round <= ctx.params.rounds; round++) {
      const built = await ctx.run(builder, { title, description, deficits });
      if (!built.ok) return ctx.fail(built.error);
      if (built.value.question !== undefined) {
        const decision = await ctx.halt(ownerDecision, built.value.question);
        if (!decision.proceed) return 'abandoned';
        deficits = [...deficits, decision.guidance];
      }
      const audit = await ctx.run(auditor, { title, description, summary: built.value.summary });
      if (!audit.ok) return ctx.fail(audit.error);
      if (audit.value.deficits.length === 0) return 'done';
      deficits = [...audit.value.deficits];
    }
    return ctx.fail(`deficits remain after ${ctx.params.rounds} rounds`);
  });

const bugTracker = linear.tracker(bug, {
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'PRODUCT',
  label: 'bug',
  read: issue => ({ title: issue.title, description: issue.description }),
  statuses: { todo: 'Todo', done: 'Done', abandoned: 'Canceled' },
});
const featureTracker = linear.tracker(feature, {
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'PRODUCT',
  label: 'feature',
  read: issue => ({ title: issue.title, description: issue.description }),
  statuses: { todo: 'Todo', done: 'Done', abandoned: 'Canceled' },
});
const epicTracker = linear.tracker(epic, {
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'PRODUCT',
  label: 'epic',
  read: issue => ({ title: issue.title, description: issue.description }),
  statuses: { open: 'Todo', decomposed: 'In Progress', complete: 'Done', dropped: 'Canceled' },
});
const bugFiles = folder.files(bug, {
  dir: 'product/bugs',
  read: file => ({ title: String(file.frontmatter['title'] ?? file.path), description: file.body }),
});

const bugLane = H.lane('bugs', bug)
  .handler(buildAndAudit, { retries: 2, backoff: { first: { minutes: 5 }, factor: 2 }, exhausted: 'abandoned', params: { rounds: 3 } })
  .suppliers(bugTracker, bugFiles, H.operator)
  .store(bugTracker)
  .wip(2);

const featureLane = H.lane('features', feature)
  .handler(buildAndAudit, { retries: 2, backoff: { first: { minutes: 5 }, factor: 2 }, exhausted: 'abandoned', params: { rounds: 5 } })
  .suppliers(featureTracker, H.operator)
  .store(featureTracker);

const decomposeEpic = H.flow('decompose-epic').for(epic).does(async ctx => {
  const plan = await ctx.run(planner, { title: ctx.unit.data.title, description: ctx.unit.data.description });
  if (!plan.ok) return ctx.fail(plan.error);
  const children = await ctx.spawn(featureLane, plan.value.features);
  const finished = await ctx.suspend('decomposed', { children });
  return finished.every(child => child.state === 'done') ? 'complete' : 'dropped';
});

const epicLane = H.lane('epics', epic)
  .handler(decomposeEpic, { retries: 1, exhausted: 'dropped' })
  .suppliers(epicTracker)
  .store(epicTracker)
  .wip(1);

const serviceHealth = H.command('service-health')
  .input(z.object({ service: z.string() }))
  .argv(input => ['curl', '-fsS', `https://${input.service}.internal/health`])
  .on(local)
  .recovery('rerun');

const checkHeartbeat = H.flow('check-heartbeat').for(heartbeat).does(async ctx => {
  const probe = await ctx.run(serviceHealth, { service: ctx.unit.data.service });
  return probe.ok ? 'healthy' : 'unhealthy';
});

const heartbeatSchedule = H.clock('heartbeat-schedule', heartbeat, { every: { minutes: 5 } }, () => [
  { create: { service: 'api' } },
  { create: { service: 'web' } },
]);

const heartbeatLane = H.lane('heartbeats', heartbeat)
  .handler(checkHeartbeat, { retries: 0, exhausted: 'unhealthy' })
  .suppliers(heartbeatSchedule);

const heartbeatFilesBug = H.trigger('heartbeat-files-bug', H.on.enters(heartbeat, 'unhealthy'), (event, act) =>
  act.create(
    bugLane,
    { title: `Heartbeat failed: ${event.unit.data.service}`, description: `Health probe failed at ${event.at.toISOString()}` },
    `heartbeat-${event.unit.data.service}`
  )
);

const laneOrder = [heartbeatLane.name, bugLane.name, featureLane.name, epicLane.name];
const productRank = (unit: PendingView): number =>
  unit.lane === featureLane.name && unit.waitedMs > 6 * 3600000 ? 0.5 : laneOrder.indexOf(unit.lane);

const productOrder = H.policy.scheduler('product-order', view => ({
  start: [...view.pending].sort((a, b) => productRank(a) - productRank(b)),
}));

const productionHealth = H.operation(
  'production-health',
  H.command('production-health-probe').argv(() => ['bin/probe-production']).on(local)
);

const productSupervisor = claudeCode.supervisor({
  grants: [
    H.ops.readWork,
    H.ops.writeWork,
    H.ops.resolve(ownerDecision, H.halts.interrupted, H.halts.definitionChanged, H.halts.costCeiling),
    H.ops.writeMemory,
    H.ops.readTelemetry,
    H.ops.readAccounts,
    H.ops.setShares,
    productionHealth,
  ],
});

export const product = H.harness('product')
  .ledger(sqlite.ledger('product/.harness/ledger.sqlite'))
  .lanes(heartbeatLane, bugLane, featureLane, epicLane)
  .pools(productPool)
  .triggers(heartbeatFilesBug)
  .scheduler(productOrder)
  .clients(productSupervisor)
  .observers(markdown.board('product/BOARD.md'), markdown.telemetry('product/TELEMETRY.md'));

const docsPool = H.pool('docs-claude', [
  { account: maxOne, share: 0.3 },
  { account: maxTwo, share: 0.3 },
  { account: maxThree, share: 0.3 },
], soonestExpiring);

const docsExperience = H.library('docs-experience', experience, jsonl.memory('docs/.harness/experience.jsonl'));

const unwritten = H.state('unwritten', 'pending');
const published = H.state('published', 'terminal', 'success');
const linkBroken = H.state('link-broken', 'terminal', 'failure');
const docPage = H.kind('DocPage')
  .data(z.object({ path: z.string(), title: z.string(), body: z.string() }))
  .states(unwritten, published, linkBroken);

const docsWorktrees = git.worktree('docs-worktrees', { repo: 'docs', slots: 2 });

const writeRole = H.role('write')
  .input(z.object({ title: z.string(), body: z.string() }))
  .output(z.object({ body: z.string() }))
  .prompt(input => `Write the documentation page "${input.title}".\nCurrent text:\n${input.body}`)
  .intents(['read', 'edit']);

const writer = H.seat('writer', writeRole).model(sonnet).on(docsWorktrees).recalls(docsExperience, ownerTaste).records(docsExperience);

const linkCheck = H.command('link-check')
  .input(z.object({ path: z.string() }))
  .argv(input => ['npx', 'linkinator', input.path])
  .on(docsWorktrees)
  .recovery('rerun');

const writePage = H.flow('write-page').for(docPage).does(async ctx => {
  const written = await ctx.run(writer, { title: ctx.unit.data.title, body: ctx.unit.data.body });
  if (!written.ok) return ctx.fail(written.error);
  await ctx.update({ body: written.value.body });
  const links = await ctx.run(linkCheck, { path: ctx.unit.data.path });
  return links.ok ? 'published' : ctx.fail(links.error);
});

const pageFiles = folder.files(docPage, {
  dir: 'docs/pages',
  read: file => ({ path: file.path, title: String(file.frontmatter['title'] ?? file.path), body: file.body }),
});

const pageLane = H.lane('pages', docPage)
  .handler(writePage, { retries: 2, exhausted: 'link-broken' })
  .suppliers(pageFiles)
  .store(pageFiles)
  .wip(2);

const docsSupervisor = claudeCode.supervisor({
  grants: [
    H.ops.readWork,
    H.ops.writeWork,
    H.ops.resolve(H.halts.interrupted, H.halts.definitionChanged),
    H.ops.writeMemory,
    H.ops.readTelemetry,
    H.ops.readAccounts,
    H.ops.setShares,
  ],
});

export const docs = H.harness('docs')
  .ledger(sqlite.ledger('docs/.harness/ledger.sqlite'))
  .lanes(pageLane)
  .pools(docsPool)
  .clients(docsSupervisor)
  .observers(markdown.board('docs/BOARD.md'), markdown.telemetry('docs/TELEMETRY.md'));
