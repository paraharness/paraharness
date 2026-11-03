import { z } from 'zod';
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

const sharedQuota = '/var/lib/harness/accounts.db';

export const subscriptions = [
  claudeCode.subscription('claude-max-1', { token: H.env('CLAUDE_TOKEN_1') }),
  claudeCode.subscription('claude-max-2', { token: H.env('CLAUDE_TOKEN_2') }),
  claudeCode.subscription('claude-max-3', { token: H.env('CLAUDE_TOKEN_3') }),
];

function windowShare(share: number) {
  return subscriptions.map(account => ({ account, share }));
}

export const ownerTaste = H.library(
  'shared-taste',
  H.memory('owner-taste', 'taste'),
  jsonl.memory('/home/owner/.harness/taste.jsonl'),
);
const experience = H.memory('experience', 'experience');

const cheap = claudeCode.model('claude-sonnet-4-5');
const strong = claudeCode.model('claude-opus-4-1');

const todo = H.state('todo', 'pending');
const building = H.state('building', 'active');
const done = H.state('done', 'terminal', 'success');
const exhausted = H.state('exhausted', 'terminal', 'failure');
const dropped = H.state('dropped', 'terminal', 'neutral');

const Bug = H.kind('Bug')
  .data(z.object({ title: z.string(), description: z.string() }))
  .states(todo, building, done, exhausted, dropped);
const Feature = H.kind('Feature')
  .data(z.object({ title: z.string(), description: z.string(), epic: z.string().optional() }))
  .states(todo, building, done, exhausted, dropped);

const open = H.state('open', 'pending');
const planning = H.state('planning', 'active');
const decomposed = H.state('decomposed', 'waiting');
const Epic = H.kind('Epic')
  .data(z.object({ title: z.string(), description: z.string() }))
  .states(open, planning, decomposed, done, dropped);

const due = H.state('due', 'pending');
const probing = H.state('probing', 'active');
const healthy = H.state('healthy', 'terminal', 'success');
const unhealthy = H.state('unhealthy', 'terminal', 'failure');
const Heartbeat = H.kind('ServiceHeartbeat')
  .data(z.object({ service: z.string(), url: z.string() }))
  .states(due, probing, healthy, unhealthy);

const linearKey = H.env('LINEAR_API_KEY');
const ticketStatuses = { todo: 'Todo', building: 'In Progress', done: 'Done', exhausted: 'Needs Owner', dropped: 'Canceled' };

const linearBugs = linear.tracker(Bug, {
  apiKey: linearKey,
  team: 'ENG',
  label: 'bug',
  read: issue => ({ title: issue.title, description: issue.description }),
  statuses: ticketStatuses,
});
const linearFeatures = linear.tracker(Feature, {
  apiKey: linearKey,
  team: 'ENG',
  label: 'feature',
  read: issue => ({ title: issue.title, description: issue.description, epic: issue.parentId }),
  statuses: ticketStatuses,
});
const linearEpics = linear.tracker(Epic, {
  apiKey: linearKey,
  team: 'ENG',
  label: 'epic',
  read: issue => ({ title: issue.title, description: issue.description }),
  statuses: { open: 'Todo', planning: 'In Progress', decomposed: 'In Progress', done: 'Done', dropped: 'Canceled' },
});
const bugFolder = folder.files(Bug, {
  dir: 'bugs',
  read: file => ({ title: String(file.frontmatter.title ?? file.path), description: file.body }),
});

const codingExperience = H.library('coding-experience', experience, jsonl.memory('coding/experience.jsonl'));

const build = H.role('build')
  .input(z.object({ title: z.string(), brief: z.string(), deficits: z.array(z.string()) }))
  .output(z.object({ summary: z.string(), question: z.string().optional() }))
  .prompt(t => `Implement "${t.title}".\n\n${t.brief}\n\nOpen deficits:\n${t.deficits.join('\n')}`)
  .intents(['read', 'edit', 'execute']);
const audit = H.role('audit')
  .input(z.object({ title: z.string(), summary: z.string() }))
  .output(z.object({ deficits: z.array(z.string()) }))
  .prompt(t => `Audit the change for "${t.title}". Builder summary:\n${t.summary}`)
  .intents(['read', 'execute']);
const plan = H.role('plan')
  .input(z.object({ title: z.string(), description: z.string() }))
  .output(z.object({ features: z.array(z.object({ title: z.string(), description: z.string() })) }))
  .prompt(e => `Decompose the epic "${e.title}" into features.\n\n${e.description}`)
  .intents(['read']);

const builderModel = H.policy.model('cheap-until-unreliable', choice => {
  const record = choice.metrics.successRate({ kind: choice.kind, model: cheap.name, days: 14 });
  if (record.value === null || record.samples < 20) return cheap;
  return record.value < 0.85 ? strong : cheap;
});

const worktrees = git.worktree('worktrees', { repo: '.', slots: 3 });
const local = shell.local('local', { slots: 4 });

const projectChecks = H.command('project-checks').argv(() => ['npm', 'run', 'check']).on(worktrees).recovery('rerun');

const builder = H.agent('builder', build)
  .model(builderModel)
  .on(worktrees)
  .recalls(codingExperience, ownerTaste)
  .guards(claudeCode.fileLeases(), claudeCode.stopCheck(projectChecks));
const auditor = H.agent('auditor', audit).model(strong).on(worktrees).recalls(codingExperience).records(codingExperience);
const planner = H.agent('planner', plan).model(strong).recalls(ownerTaste);

const ticketFlow = H.flow('ticket')
  .for(Bug, Feature)
  .params(z.object({ rounds: z.number() }))
  .does(async ctx => {
    const ticket = ctx.unit.data;
    let deficits: string[] = [];
    for (let round = 1; round <= ctx.params.rounds; round++) {
      const built = await ctx.run(builder, { title: ticket.title, brief: ticket.description, deficits });
      if (!built.ok) return ctx.fail(built.error);
      if (built.value.question) {
        const owner = await ctx.halt({
          name: 'owner-decision',
          show: built.value.question,
          decision: z.object({ answer: z.string() }),
        });
        deficits = [`Owner decided: ${owner.answer}`];
        continue;
      }
      const audited = await ctx.run(auditor, { title: ticket.title, summary: built.value.summary });
      if (!audited.ok) return ctx.fail(audited.error);
      if (audited.value.deficits.length === 0) return 'done';
      deficits = audited.value.deficits;
    }
    return 'exhausted';
  });

const bugs = H.lane('bugs', Bug)
  .handler(ticketFlow, { rounds: 3 })
  .suppliers(linearBugs, bugFolder, H.operator)
  .store(linearBugs)
  .wip(2);
const features = H.lane('features', Feature)
  .handler(ticketFlow, { rounds: 5 })
  .suppliers(linearFeatures, H.operator)
  .store(linearFeatures);

const epicFlow = H.flow('epic').for(Epic).does(async ctx => {
  const children = await ctx.children();
  if (children.length > 0) {
    return children.every(c => c.position === 'terminal')
      ? 'done'
      : ctx.until('decomposed', { children: true, then: 'open' });
  }
  const planned = await ctx.run(planner, { title: ctx.unit.data.title, description: ctx.unit.data.description });
  if (!planned.ok) return ctx.fail(planned.error);
  await ctx.spawn(features, planned.value.features.map(f => ({ title: f.title, description: f.description, epic: ctx.unit.key })));
  return ctx.until('decomposed', { children: true, then: 'open' });
});
const epics = H.lane('epics', Epic).handler(epicFlow).suppliers(linearEpics).store(linearEpics).wip(1);

const probe = H.command('probe')
  .input(z.object({ url: z.string() }))
  .argv(s => ['curl', '--fail', '--silent', s.url])
  .on(local)
  .recovery('rerun');
const heartbeatFlow = H.flow('heartbeat').for(Heartbeat).does(async ctx => {
  const probed = await ctx.run(probe, { url: ctx.unit.data.url });
  return probed.ok ? 'healthy' : 'unhealthy';
});
const everyFiveMinutes = H.clock('every-five-minutes', Heartbeat, { every: { minutes: 5 } }, () => [
  { create: { service: 'api', url: 'https://api.example.com/health' } },
]);
const heartbeats = H.lane('heartbeats', Heartbeat).handler(heartbeatFlow).suppliers(everyFiveMinutes);

const failedHeartbeatFilesBug = H.trigger('failed-heartbeat-files-bug', H.on.enters(Heartbeat, 'unhealthy'), (event, act) =>
  act.create(
    bugs,
    {
      title: `${event.unit.data.service} heartbeat failed`,
      description: `Probe of ${event.unit.data.url} failed at ${event.at.toISOString()}.`,
    },
    `heartbeat-${event.unit.data.service}`,
  ));

const kindOrder = [Heartbeat.name, Bug.name, Feature.name, Epic.name];
const starvedAfterMs = 2 * 60 * 60 * 1000;
function rank(unit: PendingView): number {
  if (unit.kind === Feature.name && unit.waitedMs > starvedAfterMs) return 0.5;
  return kindOrder.indexOf(unit.kind);
}
const codingOrder = H.policy.scheduler('heartbeats-bugs-features-epics', view => ({
  start: [...view.pending].sort((x, y) => rank(x) - rank(y) || y.waitedMs - x.waitedMs),
}));

const soonestExpiringFirst = H.policy.account('soonest-expiring-first', choice => {
  const usable = choice.accounts.filter(a => a.eligible && a.usedShare < a.share);
  const draining = usable
    .filter(a => a.account.plan === 'subscription')
    .sort((x, y) => (x.windowEndsAt?.getTime() ?? Infinity) - (y.windowEndsAt?.getTime() ?? Infinity));
  return draining[0]?.account ?? usable.find(a => a.account.plan === 'metered')?.account ?? null;
});

const codingPool = H.pool(
  'coding',
  [...windowShare(0.6), { account: anthropic.account('coding-api', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 }],
  soonestExpiringFirst,
);

const productionHealth = H.command('production-health').argv(() => ['curl', '--fail', 'https://example.com/health']).on(local).recovery('rerun');

const codingSupervisor = claudeCode.supervisor({
  grants: [
    H.ops.readWork,
    H.ops.writeWork,
    H.ops.resolveHalts,
    H.ops.writeMemory,
    H.ops.readTelemetry,
    H.ops.readAccounts,
    H.ops.setShares,
    H.operation('probe-production', productionHealth),
  ],
});

export const codingTeam = H.harness('coding-team')
  .ledger(sqlite.ledger('coding/ledger.db', { sharedQuota }))
  .lanes(heartbeats, bugs, features, epics)
  .pools(codingPool)
  .triggers(failedHeartbeatFilesBug)
  .scheduler(codingOrder)
  .clients(codingSupervisor)
  .observers(markdown.board('coding/BOARD.md'), markdown.telemetry('coding/TELEMETRY.md'));

const stale = H.state('stale', 'pending');
const writing = H.state('writing', 'active');
const published = H.state('published', 'terminal', 'success');
const brokenLinks = H.state('broken-links', 'terminal', 'failure');

const DocPage = H.kind('DocPage')
  .data(z.object({ path: z.string(), title: z.string(), brief: z.string() }))
  .states(stale, writing, published, brokenLinks);

const docFolder = folder.files(DocPage, {
  dir: 'docs',
  read: file => ({ path: file.path, title: String(file.frontmatter.title ?? file.path), brief: file.body }),
  write: (_page, state) => ({ status: state }),
});

const docsExperience = H.library('docs-experience', experience, jsonl.memory('docs/experience.jsonl'));
const docsWorkspace = shell.local('docs-workspace', { slots: 2 });

const writePage = H.role('write-page')
  .input(z.object({ path: z.string(), title: z.string(), brief: z.string(), brokenLinks: z.array(z.string()) }))
  .output(z.object({ summary: z.string() }))
  .prompt(p => `Write the page ${p.path} titled "${p.title}".\n\n${p.brief}\n\nFix these broken links:\n${p.brokenLinks.join('\n')}`)
  .intents(['read', 'edit']);

const writer = H.agent('writer', writePage).model(cheap).on(docsWorkspace).recalls(ownerTaste, docsExperience).records(docsExperience);

const linkCheck = H.command('link-check')
  .input(z.object({ path: z.string() }))
  .output(z.object({ broken: z.array(z.string()) }))
  .argv(p => ['link-check', '--json', p.path])
  .on(docsWorkspace)
  .recovery('rerun');

const docFlow = H.flow('doc-page').for(DocPage).does(async ctx => {
  const page = ctx.unit.data;
  let broken: string[] = [];
  for (let round = 1; round <= 2; round++) {
    const written = await ctx.run(writer, { path: page.path, title: page.title, brief: page.brief, brokenLinks: broken });
    if (!written.ok) return ctx.fail(written.error);
    const checked = await ctx.run(linkCheck, { path: page.path });
    if (!checked.ok) return ctx.fail(checked.error);
    if (checked.value.broken.length === 0) return 'published';
    broken = checked.value.broken;
  }
  return 'broken-links';
});

const docPages = H.lane('doc-pages', DocPage).handler(docFlow).suppliers(docFolder).store(docFolder).wip(2);

const docsOrder = H.policy.scheduler('docs-longest-waiting', view => ({
  start: [...view.pending].sort((x, y) => y.waitedMs - x.waitedMs),
}));

const docsSupervisor = claudeCode.supervisor({
  grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.writeMemory, H.ops.readTelemetry, H.ops.readAccounts],
});

export const documentation = H.harness('documentation')
  .ledger(sqlite.ledger('docs/ledger.db', { sharedQuota }))
  .lanes(docPages)
  .pools(H.pool('docs', windowShare(0.3)))
  .scheduler(docsOrder)
  .clients(docsSupervisor)
  .observers(markdown.board('docs/BOARD.md'));
