import { H, type PendingView } from 'harness-dsl';
import * as claude from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as linear from 'harness-dsl/linear';
import * as folder from 'harness-dsl/folder';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as git from 'harness-dsl/git';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';
import { z } from 'zod';

const sharedQuota = sqlite.quota('~/.harness/accounts.db');
const maxOne = claude.subscription('max-1', { token: H.env('CLAUDE_MAX_1_TOKEN'), quota: sharedQuota });
const maxTwo = claude.subscription('max-2', { token: H.env('CLAUDE_MAX_2_TOKEN'), quota: sharedQuota });
const maxThree = claude.subscription('max-3', { token: H.env('CLAUDE_MAX_3_TOKEN'), quota: sharedQuota });

const tasteMemory = H.memory('taste', 'taste');
const experienceMemory = H.memory('experience', 'experience');
const ownerTaste = H.journal('owner-taste', tasteMemory, jsonl.memory('~/.harness/taste.jsonl'));

const sonnet = claude.model('claude-sonnet');
const opus = claude.model('claude-opus');

const soonestExpiring = H.policy.account('soonest-expiring', choice => {
  const usable = choice.accounts.filter(view => view.eligible && view.usedShare < view.share);
  const ranked = [...usable].sort((a, b) =>
    (a.account.plan === b.account.plan ? 0 : a.account.plan === 'subscription' ? -1 : 1) ||
    (a.windowEndsAt?.getTime() ?? Number.MAX_SAFE_INTEGER) - (b.windowEndsAt?.getTime() ?? Number.MAX_SAFE_INTEGER));
  return ranked.length > 0 ? ranked[0].account : null;
});

const apiAccount = anthropic.account('api-fallback', { apiKey: H.env('ANTHROPIC_API_KEY') });

const productPool = H.pool('product-pool', [
  { account: maxOne, share: 0.6 },
  { account: maxTwo, share: 0.6 },
  { account: maxThree, share: 0.6 },
  { account: apiAccount, share: 1 },
], soonestExpiring);

const productExperience = H.journal('product-experience', experienceMemory, jsonl.memory('./product/memory/experience.jsonl'));

const queued = H.state('queued', 'pending');
const done = H.state('done', 'terminal', 'success');
const wontDo = H.state('wont-do', 'terminal', 'neutral');
const stuck = H.state('stuck', 'terminal', 'failure');
const open = H.state('open', 'pending');
const decomposed = H.state('decomposed', 'waiting');
const due = H.state('due', 'pending');
const up = H.state('up', 'terminal', 'success');
const down = H.state('down', 'terminal', 'failure');

const ticket = z.object({ title: z.string(), description: z.string() });
const bug = H.kind('bug').data(ticket).states(queued, done, wontDo, stuck);
const feature = H.kind('feature').data(ticket).states(queued, done, wontDo, stuck);
const epic = H.kind('epic').data(ticket).states(open, decomposed, done);
const heartbeat = H.kind('service-heartbeat').data(z.object({ service: z.string() })).states(due, up, down);

const worktree = git.worktree('worktree', { repo: '.', slots: 3 });
const productShell = shell.local('product-shell', { slots: 4 });

const projectChecks = H.command('project-checks').argv(() => ['npm', 'run', 'check']).on(worktree);
const productionProbe = H.command('production-health').argv(() => ['./scripts/prod-health.sh']).on(productShell);
const serviceProbe = H.command('service-probe')
  .input(z.object({ service: z.string() }))
  .argv(input => ['./scripts/probe.sh', input.service])
  .on(productShell);

const builderRole = H.role('builder')
  .input(z.object({ title: z.string(), description: z.string(), deficits: z.array(z.string()) }))
  .output(z.object({ summary: z.string(), question: z.string().optional() }))
  .prompt(input => `Build: ${input.title}\n${input.description}\nOpen deficits:\n${input.deficits.join('\n')}`)
  .intents(['read', 'edit', 'execute']);
const auditorRole = H.role('auditor')
  .input(z.object({ title: z.string(), description: z.string(), summary: z.string() }))
  .output(z.object({ deficits: z.array(z.string()) }))
  .prompt(input => `Audit the change for ${input.title}:\n${input.summary}`)
  .intents(['read', 'execute']);
const plannerRole = H.role('planner')
  .input(ticket)
  .output(z.object({ features: z.array(ticket) }))
  .prompt(input => `Decompose the epic ${input.title} into features:\n${input.description}`);

const builderModel = H.policy.model('builder-model', choice => {
  const cheap = choice.metrics.successRate({ kind: choice.kind, seat: choice.seat, model: sonnet, days: 14 });
  return cheap.samples >= 20 && cheap.value !== null && cheap.value < 0.85 ? opus : sonnet;
});

const builder = H.seat('builder', builderRole)
  .model(builderModel)
  .on(worktree)
  .recalls(productExperience, ownerTaste)
  .guards(claude.fileLeases(), claude.stopCheck(projectChecks));
const auditor = H.seat('auditor', auditorRole)
  .model(opus)
  .on(worktree)
  .recalls(productExperience)
  .records(productExperience);
const planner = H.seat('planner', plannerRole).model(opus).recalls(ownerTaste);

const ownerDecision = H.halt('owner-decision', z.object({ answer: z.string() }));

const buildAndAudit = H.flow('build-and-audit')
  .for(bug, feature)
  .params(z.object({ rounds: z.number() }))
  .does(async ctx => {
    let deficits: string[] = [];
    for (let round = 0; round < ctx.params.rounds; round++) {
      const built = await ctx.run(builder, { title: ctx.unit.data.title, description: ctx.unit.data.description, deficits });
      if (!built.ok) return ctx.fail(built.error);
      if (built.value.question !== undefined) {
        const decision = await ctx.halt(ownerDecision, built.value.question);
        deficits = [...deficits, `Owner decided: ${decision.answer}`];
        continue;
      }
      const audit = await ctx.run(auditor, { title: ctx.unit.data.title, description: ctx.unit.data.description, summary: built.value.summary });
      if (!audit.ok) return ctx.fail(audit.error);
      if (audit.value.deficits.length === 0) return 'done';
      deficits = audit.value.deficits;
    }
    return ctx.fail(`rounds exhausted with ${deficits.length} deficits open`);
  });

const heartbeatFlow = H.flow('heartbeat').for(heartbeat).does(async ctx => {
  const probe = await ctx.run(serviceProbe, ctx.unit.data);
  return probe.ok ? 'up' : 'down';
});

const trackerKey = H.env('LINEAR_API_KEY');
const readIssue = (issue: linear.Issue) => ({ title: issue.title, description: issue.description });
const ticketStatuses = { queued: 'Todo', done: 'Done', 'wont-do': 'Canceled', stuck: 'Blocked' };

const bugTracker = linear.tracker(bug, { apiKey: trackerKey, team: 'PRD', label: 'bug', read: readIssue, statuses: ticketStatuses });
const featureTracker = linear.tracker(feature, { apiKey: trackerKey, team: 'PRD', label: 'feature', read: readIssue, statuses: ticketStatuses });
const epicTracker = linear.tracker(epic, {
  apiKey: trackerKey,
  team: 'PRD',
  label: 'epic',
  read: readIssue,
  statuses: { open: 'Todo', decomposed: 'In Progress', done: 'Done' },
});
const bugFolder = folder.files(bug, {
  dir: './bugs',
  read: file => ({ title: String(file.frontmatter['title'] ?? file.path), description: file.body }),
  key: file => file.path,
});

const threeTimes = H.policy.retry('three-times', view => view.failures < 3 ? { retryInMs: 60_000 * 2 ** view.failures } : 'stop');

const bugs = H.lane('bugs', bug)
  .handler(buildAndAudit, { rounds: 3 })
  .suppliers(bugTracker, bugFolder, H.operator)
  .store(bugTracker)
  .wip(2)
  .retry(threeTimes, 'stuck');
const features = H.lane('features', feature)
  .handler(buildAndAudit, { rounds: 5 })
  .suppliers(featureTracker, H.operator)
  .store(featureTracker)
  .retry(threeTimes, 'stuck');

const decompose = H.flow('decompose').for(epic).does(async ctx => {
  const plan = await ctx.run(planner, ctx.unit.data);
  if (!plan.ok) return ctx.fail(plan.error);
  const children = await ctx.spawn(features, plan.value.features);
  await ctx.wait('decomposed', { children });
  return 'done';
});

const epics = H.lane('epics', epic).handler(decompose).suppliers(epicTracker).store(epicTracker).wip(1);

const services = ['api', 'web', 'worker'];
const heartbeats = H.lane('heartbeats', heartbeat)
  .handler(heartbeatFlow)
  .suppliers(H.clock('every-five-minutes', heartbeat, { every: { minutes: 5 } }, tick =>
    services.map(service => ({ create: { service }, key: `${service}-${tick.now.toISOString()}` }))));

const heartbeatFilesBug = H.trigger('heartbeat-down-files-bug', H.on.enters(heartbeat, 'down'), (event, act) =>
  act.create(bugs, {
    title: `Service ${event.unit.data.service} failed its heartbeat`,
    description: `The heartbeat at ${event.at.toISOString()} failed.`,
  }));

const rank = (unit: PendingView) =>
  unit.is(heartbeat) ? 0
    : unit.is(feature) && unit.waitedMs > 7_200_000 ? 1
    : unit.is(bug) ? 2
    : unit.is(feature) ? 3
    : 4;
const priority = H.policy.scheduler('heartbeats-bugs-features-epics', view => ({
  start: [...view.pending].sort((a, b) => rank(a) - rank(b)),
}));

export const product = H.harness('product')
  .ledger(sqlite.ledger('./product/.harness/ledger.db'))
  .lanes(heartbeats, bugs, features, epics)
  .pools(productPool)
  .triggers(heartbeatFilesBug)
  .scheduler(priority)
  .clients(claude.supervisor({
    grants: [
      H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.writeMemory,
      H.ops.readTelemetry, H.ops.readAccounts, H.ops.setShares,
      H.operation('production-health', productionProbe),
    ],
  }))
  .observers(markdown.board('./product/BOARD.md'), markdown.telemetry('./product/TELEMETRY.md'));

const docsPool = H.pool('docs-pool', [
  { account: maxOne, share: 0.3 },
  { account: maxTwo, share: 0.3 },
  { account: maxThree, share: 0.3 },
], soonestExpiring);

const docsExperience = H.journal('docs-experience', experienceMemory, jsonl.memory('./docs-site/memory/experience.jsonl'));
const docsShell = shell.local('docs-shell', { slots: 2 });

const draft = H.state('draft', 'pending');
const published = H.state('published', 'terminal', 'success');
const brokenLinks = H.state('broken-links', 'terminal', 'failure');
const docPage = H.kind('doc-page')
  .data(z.object({ path: z.string(), title: z.string(), body: z.string() }))
  .states(draft, published, brokenLinks);

const pages = folder.files(docPage, {
  dir: './docs-site/pages',
  read: file => ({ path: file.path, title: String(file.frontmatter['title'] ?? file.path), body: file.body }),
  key: file => file.path,
});

const writerRole = H.role('writer')
  .input(z.object({ title: z.string(), body: z.string() }))
  .output(z.object({ body: z.string() }))
  .prompt(input => `Revise the page "${input.title}":\n${input.body}`)
  .intents(['read', 'edit']);
const writer = H.seat('writer', writerRole).model(sonnet).recalls(ownerTaste, docsExperience).records(docsExperience);

const linkCheck = H.command('link-check')
  .input(z.object({ path: z.string() }))
  .argv(input => ['lychee', input.path])
  .on(docsShell);

const writePage = H.flow('write-page').for(docPage).does(async ctx => {
  const written = await ctx.run(writer, { title: ctx.unit.data.title, body: ctx.unit.data.body });
  if (!written.ok) return ctx.fail(written.error);
  await ctx.update({ body: written.value.body });
  const links = await ctx.run(linkCheck, { path: ctx.unit.data.path });
  return links.ok ? 'published' : 'broken-links';
});

const docPages = H.lane('doc-pages', docPage).handler(writePage).suppliers(pages).store(pages).wip(2);

export const docs = H.harness('docs')
  .ledger(sqlite.ledger('./docs-site/.harness/ledger.db'))
  .lanes(docPages)
  .pools(docsPool)
  .clients(claude.supervisor({
    grants: [H.ops.readWork, H.ops.writeWork, H.ops.writeMemory, H.ops.readTelemetry, H.ops.readAccounts, H.ops.setShares],
  }))
  .observers(markdown.board('./docs-site/BOARD.md'));
