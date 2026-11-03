import { z } from 'zod';
import { H, type PendingView } from 'harness-dsl';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as linear from 'harness-dsl/linear';
import * as folder from 'harness-dsl/folder';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as git from 'harness-dsl/git';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

export const sonnet = anthropic.model('claude-sonnet-4-5');
export const opus = anthropic.model('claude-opus-4-1');

export const sharedQuota = sqlite.quota('~/.harness/shared/account-quota.db');

export const max1 = claudeCode.subscription('max-1', { token: H.env('CLAUDE_MAX_1_TOKEN'), serves: [sonnet, opus], quota: sharedQuota });
export const max2 = claudeCode.subscription('max-2', { token: H.env('CLAUDE_MAX_2_TOKEN'), serves: [sonnet, opus], quota: sharedQuota });
export const max3 = claudeCode.subscription('max-3', { token: H.env('CLAUDE_MAX_3_TOKEN'), serves: [sonnet, opus], quota: sharedQuota });

export const ownerTasteMemory = H.memory('owner-taste', 'taste');
export const ownerTaste = H.journal('owner-taste-journal', ownerTasteMemory, jsonl.memory('~/.harness/shared/taste.jsonl'));

export const soonestExpiring = H.policy.account('soonest-expiring-first', choice => {
  const usable = choice.accounts.filter(a => a.eligible && a.usedShare < a.share);
  const ordered = [...usable].sort((a, b) => {
    const planOrder = (a.account.plan === 'subscription' ? 0 : 1) - (b.account.plan === 'subscription' ? 0 : 1);
    if (planOrder !== 0) return planOrder;
    return (a.windowEndsAt?.getTime() ?? Number.MAX_SAFE_INTEGER) - (b.windowEndsAt?.getTime() ?? Number.MAX_SAFE_INTEGER);
  });
  return ordered.length > 0 ? ordered[0].account : null;
});

const apiAccount = anthropic.account('product-api', { apiKey: H.env('ANTHROPIC_API_KEY'), serves: [sonnet, opus], quota: sharedQuota });

const open = H.state('open', 'pending');
const done = H.state('done', 'terminal', 'success');
const wontFix = H.state('wont-fix', 'terminal', 'neutral');
const stuck = H.state('stuck', 'terminal', 'failure');
const decomposed = H.state('decomposed', 'waiting');
const abandoned = H.state('abandoned', 'terminal', 'failure');
const due = H.state('due', 'pending');
const healthy = H.state('healthy', 'terminal', 'success');
const unhealthy = H.state('unhealthy', 'terminal', 'failure');

const bug = H.kind('bug').data(z.object({ title: z.string(), description: z.string() })).states(open, done, wontFix, stuck);
const feature = H.kind('feature')
  .data(z.object({ title: z.string(), description: z.string(), parentEpic: z.string().optional() }))
  .states(open, done, wontFix, stuck);
const epic = H.kind('epic').data(z.object({ title: z.string(), description: z.string() })).states(open, decomposed, done, abandoned);
const heartbeat = H.kind('service-heartbeat').data(z.object({ service: z.string(), url: z.string() })).states(due, healthy, unhealthy);

const codingExperienceMemory = H.memory('coding-experience', 'experience');
const codingExperience = H.journal('coding-experience-journal', codingExperienceMemory, jsonl.memory('.harness/experience.jsonl'));

const worktree = git.worktree('product-worktree', { repo: '.', slots: 3 });
const local = shell.local('product-local', { slots: 4 });

const projectChecks = H.command('project-checks').argv(() => ['npm', 'run', 'check']).on(worktree);
const productionProbe = H.command('production-health-probe').argv(() => ['curl', '-fsS', 'https://example.com/health']).on(local);
const heartbeatProbe = H.command('heartbeat-probe').input(z.object({ url: z.string() })).argv(i => ['curl', '-fsS', i.url]).on(local);

const buildRole = H.role('build')
  .input(z.object({ title: z.string(), description: z.string(), round: z.number(), deficits: z.array(z.string()) }))
  .output(z.object({ summary: z.string(), question: z.string().optional() }))
  .prompt(i => `Round ${i.round}: ${i.title}\n${i.description}\nOpen deficits:\n${i.deficits.join('\n')}`)
  .intents(['read', 'edit', 'execute']);

const auditRole = H.role('audit')
  .input(z.object({ title: z.string(), summary: z.string() }))
  .output(z.object({ deficits: z.array(z.string()) }))
  .prompt(i => `Audit the change for "${i.title}": ${i.summary}. List deficits.`)
  .intents(['read', 'execute']);

const planRole = H.role('plan')
  .input(z.object({ title: z.string(), description: z.string() }))
  .output(z.object({ features: z.array(z.object({ title: z.string(), description: z.string() })) }))
  .prompt(i => `Decompose the epic "${i.title}" into features.\n${i.description}`)
  .intents(['read']);

const builderModel = H.policy.model('builder-model', [sonnet, opus], choice => {
  const cheap = choice.metrics.successRate({ kind: choice.kind, model: sonnet, days: 14 });
  return cheap.samples >= 20 && cheap.value !== null && cheap.value < 0.85 ? opus : sonnet;
});

const builder = H.seat('builder', buildRole)
  .model(builderModel)
  .on(worktree)
  .recalls(codingExperience, ownerTaste)
  .guards(claudeCode.fileLeases(), claudeCode.stopCheck(projectChecks));

const auditor = H.seat('auditor', auditRole).model(sonnet).on(worktree).recalls(codingExperience).records(codingExperience);
const planner = H.seat('planner', planRole).model(opus).recalls(ownerTaste);

const ownerDecision = H.halt('owner-decision', z.object({ answer: z.string() }));

const buildAndAudit = H.flow('build-and-audit')
  .for(bug, feature)
  .params(z.object({ rounds: z.number() }))
  .does(async ctx => {
    let deficits: string[] = [];
    for (let round = 1; round <= ctx.params.rounds; round++) {
      const built = await ctx.run(builder, { title: ctx.unit.data.title, description: ctx.unit.data.description, round, deficits });
      if (!built.ok) return ctx.fail(built.error);
      if (built.value.question !== undefined) {
        const answer = await ctx.halt(ownerDecision, built.value.question);
        deficits = [...deficits, `Owner decided: ${answer.answer}`];
        continue;
      }
      const audit = await ctx.run(auditor, { title: ctx.unit.data.title, summary: built.value.summary });
      if (!audit.ok) return ctx.fail(audit.error);
      if (audit.value.deficits.length === 0) return 'done';
      deficits = audit.value.deficits;
    }
    return ctx.fail('build-and-audit rounds ran out with deficits remaining');
  });

const statuses = { open: 'Todo', done: 'Done', 'wont-fix': 'Canceled', stuck: 'Blocked' };

const bugTracker = linear.tracker(bug, {
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'PRODUCT',
  label: 'bug',
  read: issue => ({ title: issue.title, description: issue.description }),
  statuses,
});
const featureTracker = linear.tracker(feature, {
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'PRODUCT',
  label: 'feature',
  read: issue => ({ title: issue.title, description: issue.description, parentEpic: issue.parentId }),
  statuses,
});
const epicTracker = linear.tracker(epic, {
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'PRODUCT',
  label: 'epic',
  read: issue => ({ title: issue.title, description: issue.description }),
  statuses: { open: 'Todo', decomposed: 'In Progress', done: 'Done', abandoned: 'Canceled' },
});
const bugFolder = folder.files(bug, {
  dir: 'bugs',
  read: file => ({ title: String(file.frontmatter['title'] ?? file.path), description: file.body }),
});

const bugs = H.lane('bugs', bug)
  .handler(buildAndAudit, { rounds: 3 })
  .retries(2, { backoff: { first: { minutes: 5 }, factor: 2 }, exhausted: 'stuck' })
  .suppliers(bugTracker, bugFolder, H.operator)
  .store(bugTracker)
  .wip(2);

const features = H.lane('features', feature)
  .handler(buildAndAudit, { rounds: 5 })
  .retries(2, { backoff: { first: { minutes: 5 }, factor: 2 }, exhausted: 'stuck' })
  .suppliers(featureTracker, H.operator)
  .store(featureTracker);

const epicFlow = H.flow('decompose-epic')
  .for(epic)
  .does(async ctx => {
    const plan = await ctx.run(planner, { title: ctx.unit.data.title, description: ctx.unit.data.description });
    if (!plan.ok) return ctx.fail(plan.error);
    const children = await ctx.spawn(features, plan.value.features.map(f => ({ ...f, parentEpic: ctx.unit.key })));
    const finished = await ctx.suspend('decomposed', { children });
    return finished.every(f => f.state === 'done') ? 'done' : ctx.fail('a feature of the epic did not complete');
  });

const epics = H.lane('epics', epic)
  .handler(epicFlow)
  .retries(1, { exhausted: 'abandoned' })
  .suppliers(epicTracker)
  .store(epicTracker)
  .wip(1);

const heartbeatFlow = H.flow('heartbeat-check')
  .for(heartbeat)
  .does(async ctx => {
    const probe = await ctx.run(heartbeatProbe, { url: ctx.unit.data.url });
    return probe.ok ? 'healthy' : 'unhealthy';
  });

const heartbeats = H.lane('heartbeats', heartbeat)
  .handler(heartbeatFlow)
  .retries(0, { exhausted: 'unhealthy' })
  .suppliers(H.schedule('heartbeat-clock', heartbeat, { every: { minutes: 5 } }, () => [
    { create: { service: 'api', url: 'https://example.com/health' } },
  ]));

const unhealthyOpensBug = H.trigger('unhealthy-heartbeat-opens-bug', H.on.enters(heartbeat, 'unhealthy'), (event, act) =>
  act.create(bugs, {
    title: `Heartbeat failed for ${event.unit.data.service}`,
    description: `The service heartbeat for ${event.unit.data.service} at ${event.unit.data.url} failed at ${event.at.toISOString()}.`,
  })
);

const rank = (unit: PendingView): number => {
  if (unit.is(heartbeat)) return 0;
  if (unit.is(feature) && unit.waitedMs > 2 * 60 * 60 * 1000) return 1;
  if (unit.is(bug)) return 2;
  if (unit.is(feature)) return 3;
  return 4;
};

const productPriorities = H.policy.scheduler('product-priorities', view => ({
  start: [...view.pending].sort((a, b) => rank(a) - rank(b) || b.waitedMs - a.waitedMs),
}));

const productPool = H.pool('product-subscriptions', [
  { account: max1, share: 0.6 },
  { account: max2, share: 0.6 },
  { account: max3, share: 0.6 },
  { account: apiAccount, share: 1 },
], soonestExpiring);

export const product = H.harness('product')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(heartbeats, bugs, features, epics)
  .pools(productPool)
  .triggers(unhealthyOpensBug)
  .scheduler(productPriorities)
  .clients(claudeCode.supervisor({
    grants: [
      H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.writeMemory,
      H.ops.readTelemetry, H.ops.readAccounts, H.ops.setShares,
      H.operation('production-health', productionProbe),
    ],
  }))
  .observers(markdown.board('.harness/board.md'), markdown.telemetry('.harness/telemetry.md'));

const draft = H.state('draft', 'pending');
const published = H.state('published', 'terminal', 'success');
const brokenLinks = H.state('broken-links', 'terminal', 'failure');

const docPage = H.kind('doc-page').data(z.object({ path: z.string(), title: z.string() })).states(draft, published, brokenLinks);

const docsExperienceMemory = H.memory('docs-experience', 'experience');
const docsExperience = H.journal('docs-experience-journal', docsExperienceMemory, jsonl.memory('../docs/.harness/experience.jsonl'));

const docsWorktree = git.worktree('docs-worktree', { repo: '../docs', slots: 2 });

const writeRole = H.role('write')
  .input(z.object({ path: z.string(), title: z.string() }))
  .output(z.object({ summary: z.string() }))
  .prompt(i => `Write or improve the page "${i.title}" at ${i.path}.`)
  .intents(['read', 'edit']);

const writer = H.seat('writer', writeRole).model(sonnet).on(docsWorktree).recalls(docsExperience, ownerTaste).records(docsExperience);

const linkCheck = H.command('link-check').input(z.object({ path: z.string() })).argv(i => ['npx', 'linkinator', i.path]).on(docsWorktree);

const docPages = folder.files(docPage, {
  dir: '../docs/pages',
  read: file => ({ path: file.path, title: String(file.frontmatter['title'] ?? file.path) }),
  key: file => file.path,
});

const writeDocs = H.flow('write-docs')
  .for(docPage)
  .does(async ctx => {
    const written = await ctx.run(writer, { path: ctx.unit.data.path, title: ctx.unit.data.title });
    if (!written.ok) return ctx.fail(written.error);
    const links = await ctx.run(linkCheck, { path: ctx.unit.data.path });
    return links.ok ? 'published' : ctx.fail(links.error);
  });

const docs = H.lane('doc-pages', docPage)
  .handler(writeDocs)
  .retries(2, { exhausted: 'broken-links' })
  .suppliers(docPages)
  .store(docPages)
  .wip(2);

const docsPool = H.pool('docs-subscriptions', [
  { account: max1, share: 0.3 },
  { account: max2, share: 0.3 },
  { account: max3, share: 0.3 },
], soonestExpiring);

export const documentation = H.harness('documentation')
  .ledger(sqlite.ledger('../docs/.harness/ledger.db'))
  .lanes(docs)
  .pools(docsPool)
  .clients(claudeCode.supervisor({
    grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.writeMemory, H.ops.readTelemetry, H.ops.readAccounts, H.ops.setShares],
  }))
  .observers(markdown.board('../docs/.harness/board.md'));
