import { H } from 'harness-dsl';
import type { PendingView } from 'harness-dsl';
import { z } from 'zod';
import { subscription, model as claudeModel, fileLeases, stopCheck } from 'harness-dsl/claude-code';
import { account as apiAccount } from 'harness-dsl/anthropic';
import { tracker } from 'harness-dsl/linear';
import { files } from 'harness-dsl/folder';
import { ledger, quota } from 'harness-dsl/sqlite';
import { memory } from 'harness-dsl/jsonl';
import { worktree } from 'harness-dsl/git';
import { local } from 'harness-dsl/shell';
import { control } from 'harness-dsl/http';
import { board, telemetry } from 'harness-dsl/markdown';

const text = (value: unknown, fallback: string): string => (typeof value === 'string' ? value : fallback);

export const sharedQuota = quota('/home/owner/.harness/accounts-quota.sqlite');
export const claudeOne = subscription('claude-max-1', { token: H.env('CLAUDE_MAX_1_TOKEN'), quota: sharedQuota });
export const claudeTwo = subscription('claude-max-2', { token: H.env('CLAUDE_MAX_2_TOKEN'), quota: sharedQuota });
export const claudeThree = subscription('claude-max-3', { token: H.env('CLAUDE_MAX_3_TOKEN'), quota: sharedQuota });
export const anthropicApi = apiAccount('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota: sharedQuota });
export const sonnet = claudeModel('claude-sonnet-4-5');
export const opus = claudeModel('claude-opus-4-1');

export const soonestExpiring = H.policy.account('soonest-expiring-first', ({ accounts }) => {
  const open = accounts.filter(view => view.eligible && view.usedShare < view.share);
  const subscriptionsFirst = open
    .filter(view => view.account.plan === 'subscription')
    .sort((a, b) => (a.windowEndsAt?.getTime() ?? Number.POSITIVE_INFINITY) - (b.windowEndsAt?.getTime() ?? Number.POSITIVE_INFINITY));
  return subscriptionsFirst[0]?.account ?? open.find(view => view.account.plan === 'metered')?.account ?? null;
});

export const sharedSubscriptions = (name: string, share: number) =>
  H.pool(
    name,
    [
      { account: claudeOne, share },
      { account: claudeTwo, share },
      { account: claudeThree, share },
      { account: anthropicApi, share: 1 },
    ],
    soonestExpiring
  );

export const ownerTaste = H.memory('owner-taste', 'taste');
export const ownerTasteJournal = H.journal('owner-taste-journal', ownerTaste, memory('/home/owner/.harness/taste.jsonl'));
export const engineeringExperience = H.memory('engineering-experience', 'experience');

export const ownerGrants = [
  H.ops.readWork,
  H.ops.writeWork,
  H.ops.resolveHalts,
  H.ops.readMemory,
  H.ops.writeMemory,
  H.ops.readTelemetry,
  H.ops.readAccounts,
  H.ops.setShares,
];

const alphaWorktrees = worktree('alpha-worktrees', { repo: '/repos/alpha', slots: 3 });
const alphaShell = local('alpha-shell', { slots: 2 });
const alphaExperience = H.journal('alpha-experience-journal', engineeringExperience, memory('/repos/alpha/.harness/experience.jsonl'));

const open = H.state('open', 'pending');
const decomposed = H.state('decomposed', 'waiting');
const done = H.state('done', 'terminal', 'success');
const wontDo = H.state('wont-do', 'terminal', 'neutral');
const stuck = H.state('stuck', 'terminal', 'failure');
const due = H.state('due', 'pending');
const healthy = H.state('healthy', 'terminal', 'success');
const down = H.state('down', 'terminal', 'failure');

const ticket = z.object({ title: z.string(), description: z.string() });
const bug = H.kind('bug').data(ticket).states(open, done, wontDo, stuck);
const feature = H.kind('feature').data(ticket).states(open, done, wontDo, stuck);
const epic = H.kind('epic').data(ticket).states(open, decomposed, done, stuck);
const heartbeat = H.kind('heartbeat').data(z.object({ service: z.string() })).states(due, healthy, down);

const buildRole = H.role('build')
  .input(z.object({ title: z.string(), description: z.string(), deficits: z.array(z.string()) }))
  .output(z.object({ summary: z.string(), question: z.string().optional() }))
  .prompt(input => `Implement: ${input.title}\n${input.description}\nOpen deficits:\n${input.deficits.join('\n')}`)
  .intents(['read', 'edit', 'execute']);
const auditRole = H.role('audit')
  .input(z.object({ title: z.string(), summary: z.string() }))
  .output(z.object({ deficits: z.array(z.string()) }))
  .prompt(input => `Audit the change for "${input.title}". Builder summary:\n${input.summary}`)
  .intents(['read', 'execute']);
const planRole = H.role('plan')
  .input(ticket)
  .output(z.object({ features: z.array(ticket) }))
  .prompt(input => `Decompose this epic into features: ${input.title}\n${input.description}`)
  .intents(['read']);

const projectChecks = H.command('project-checks').argv(() => ['npm', 'run', 'check']).on(alphaWorktrees);

const builderModel = H.policy.model('builder-model', [sonnet, opus], choice => {
  const cheap = choice.metrics.successRate({ kind: choice.kind, seat: choice.seat, model: sonnet, days: 14 });
  return cheap.samples >= 20 && cheap.value !== null && cheap.value < 0.85 ? opus : sonnet;
});

const builder = H.seat('builder', buildRole)
  .model(builderModel)
  .on(alphaWorktrees)
  .recalls(alphaExperience, ownerTasteJournal)
  .guards(fileLeases(), stopCheck(projectChecks));
const auditor = H.seat('auditor', auditRole).model(opus).on(alphaWorktrees).recalls(alphaExperience).records(alphaExperience);
const planner = H.seat('planner', planRole).model(opus).recalls(ownerTasteJournal);

const ownerCall = H.halt('owner-call', z.object({ answer: z.string() })).about(z.object({ question: z.string() }));

const buildAndAudit = H.flow('build-and-audit')
  .for(bug, feature)
  .params(z.object({ rounds: z.number() }))
  .does(async ctx => {
    const { title, description } = ctx.unit.data;
    let deficits: string[] = [];
    for (let round = 1; round <= ctx.params.rounds; round += 1) {
      const built = await ctx.run(builder, { title, description, deficits });
      if (!built.ok) return ctx.fail(built.error);
      const question = built.value.question;
      if (question !== undefined) {
        const ruling = await ctx.halt(ownerCall, question, { question });
        deficits = [...deficits, `Owner decided: ${ruling.answer}`];
        continue;
      }
      const audit = await ctx.run(auditor, { title, summary: built.value.summary });
      if (!audit.ok) return ctx.fail(audit.error);
      if (audit.value.deficits.length === 0) return 'done';
      deficits = audit.value.deficits;
    }
    return ctx.fail(`deficits remain after ${ctx.params.rounds} rounds`);
  });

const probeService = H.command('probe-service')
  .input(z.object({ service: z.string() }))
  .argv(input => ['curl', '-fsS', `https://${input.service}.internal/health`])
  .on(alphaShell)
  .recovery('rerun');

const beat = H.flow('beat')
  .for(heartbeat)
  .does(async ctx => {
    const probed = await ctx.run(probeService, ctx.unit.data);
    return probed.ok ? 'healthy' : 'down';
  });

const trackerKey = H.env('LINEAR_API_KEY');
const bugTracker = tracker(bug, {
  apiKey: trackerKey,
  team: 'ENG',
  label: 'bug',
  read: issue => ({ title: issue.title, description: issue.description }),
  statuses: { open: 'Todo', done: 'Done', 'wont-do': 'Canceled', stuck: 'Blocked' },
});
const featureTracker = tracker(feature, {
  apiKey: trackerKey,
  team: 'ENG',
  label: 'feature',
  read: issue => ({ title: issue.title, description: issue.description }),
  statuses: { open: 'Todo', done: 'Done', 'wont-do': 'Canceled', stuck: 'Blocked' },
});
const epicTracker = tracker(epic, {
  apiKey: trackerKey,
  team: 'ENG',
  label: 'epic',
  read: issue => ({ title: issue.title, description: issue.description }),
  statuses: { open: 'Todo', decomposed: 'In Progress', done: 'Done', stuck: 'Blocked' },
});
const bugFolder = files(bug, {
  dir: '/repos/alpha/bugs',
  read: file => ({ title: text(file.frontmatter['title'], file.path), description: file.body }),
  key: file => file.path,
});

const heartbeatLane = H.lane('heartbeats', heartbeat)
  .handler(beat)
  .retries(0, { exhausted: 'down' })
  .suppliers(H.schedule('every-five-minutes', heartbeat, { every: { minutes: 5 } }, () => [{ create: { service: 'api' } }]));
const bugLane = H.lane('bugs', bug)
  .handler(buildAndAudit, { rounds: 3 })
  .retries(2, { backoff: { first: { minutes: 5 }, factor: 2 }, exhausted: 'stuck' })
  .suppliers(bugTracker, bugFolder, H.operator)
  .store(bugTracker)
  .wip(2);
const featureLane = H.lane('features', feature)
  .handler(buildAndAudit, { rounds: 5 })
  .retries(2, { backoff: { first: { minutes: 10 }, factor: 2 }, exhausted: 'stuck' })
  .suppliers(featureTracker, H.operator)
  .store(featureTracker);

const decompose = H.flow('decompose')
  .for(epic)
  .does(async ctx => {
    const plan = await ctx.run(planner, ctx.unit.data);
    if (!plan.ok) return ctx.fail(plan.error);
    const children = await ctx.spawn(featureLane, plan.value.features);
    const finished = await ctx.suspend('decomposed', { children });
    return finished.every(child => child.state === 'done') ? 'done' : 'stuck';
  });

const epicLane = H.lane('epics', epic)
  .handler(decompose)
  .retries(1, { exhausted: 'stuck' })
  .suppliers(epicTracker)
  .store(epicTracker)
  .wip(1);

const heartbeatFilesBug = H.trigger('heartbeat-down-files-bug', H.on.enters(heartbeat, 'down'), (event, act) =>
  act.create(
    bugLane,
    { title: `${event.unit.data.service} heartbeat failed`, description: `Heartbeat failed at ${event.at.toISOString()}` },
    `heartbeat-${event.unit.data.service}`
  )
);

const priority = [heartbeatLane, bugLane, featureLane, epicLane].map(lane => lane.name);
const alphaScheduler = H.policy.scheduler('alpha-priority', view => {
  const rank = (unit: PendingView) =>
    unit.lane === featureLane.name && unit.waitedMs > 2 * 3_600_000 ? 0.5 : priority.indexOf(unit.lane);
  return { start: [...view.pending].sort((a, b) => rank(a) - rank(b) || b.waitedMs - a.waitedMs) };
});

export const alpha = H.harness('alpha')
  .ledger(ledger('/repos/alpha/.harness/ledger.sqlite'))
  .lanes(heartbeatLane, bugLane, featureLane, epicLane)
  .pools(sharedSubscriptions('alpha-subscriptions', 0.6))
  .triggers(heartbeatFilesBug)
  .scheduler(alphaScheduler)
  .clients(
    control({
      port: 7401,
      token: H.env('ALPHA_CONTROL_TOKEN'),
      grants: [...ownerGrants, H.operation('production-health', probeService)],
    })
  )
  .observers(board('/repos/alpha/BOARD.md'), telemetry('/repos/alpha/TELEMETRY.md'));

const docsWorktrees = worktree('docs-worktrees', { repo: '/repos/docs', slots: 2 });
const docsExperience = H.journal('docs-experience-journal', engineeringExperience, memory('/repos/docs/.harness/experience.jsonl'));

const pageDraft = H.state('draft', 'pending');
const published = H.state('published', 'terminal', 'success');
const brokenLinks = H.state('broken-links', 'terminal', 'failure');
const docPage = H.kind('doc-page')
  .data(z.object({ path: z.string(), title: z.string(), body: z.string() }))
  .states(pageDraft, published, brokenLinks);

const docsFolder = files(docPage, {
  dir: '/repos/docs/pages',
  read: file => ({ path: file.path, title: text(file.frontmatter['title'], file.path), body: file.body }),
  key: file => file.path,
});

const writeRole = H.role('write')
  .input(z.object({ path: z.string(), title: z.string(), body: z.string() }))
  .output(z.object({ body: z.string() }))
  .prompt(input => `Revise the documentation page "${input.title}" at ${input.path}:\n${input.body}`)
  .intents(['read', 'edit']);
const writer = H.seat('writer', writeRole).model(sonnet).on(docsWorktrees).recalls(ownerTasteJournal, docsExperience).records(docsExperience);
const linkCheck = H.command('link-check')
  .input(z.object({ path: z.string() }))
  .argv(input => ['lychee', input.path])
  .on(docsWorktrees)
  .recovery('rerun');

const writePage = H.flow('write-page')
  .for(docPage)
  .does(async ctx => {
    const written = await ctx.run(writer, ctx.unit.data);
    if (!written.ok) return ctx.fail(written.error);
    await ctx.update({ body: written.value.body });
    const checked = await ctx.run(linkCheck, { path: ctx.unit.data.path });
    return checked.ok ? 'published' : 'broken-links';
  });

const docLane = H.lane('doc-pages', docPage)
  .handler(writePage)
  .retries(2, { backoff: { first: { minutes: 5 } }, exhausted: 'broken-links' })
  .suppliers(docsFolder)
  .store(docsFolder)
  .wip(2);

export const docs = H.harness('docs')
  .ledger(ledger('/repos/docs/.harness/ledger.sqlite'))
  .lanes(docLane)
  .pools(sharedSubscriptions('docs-subscriptions', 0.3))
  .clients(control({ port: 7402, token: H.env('DOCS_CONTROL_TOKEN'), grants: ownerGrants }))
  .observers(board('/repos/docs/BOARD.md'));
