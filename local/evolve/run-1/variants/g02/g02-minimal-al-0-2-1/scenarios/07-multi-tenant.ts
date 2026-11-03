import { z } from 'zod';
import { H } from 'harness-dsl';
import type { AccountView, PendingView, PoolMember } from 'harness-dsl';
import * as claude from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as linear from 'harness-dsl/linear';
import * as folder from 'harness-dsl/folder';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as git from 'harness-dsl/git';
import * as shell from 'harness-dsl/shell';
import * as http from 'harness-dsl/http';
import * as markdown from 'harness-dsl/markdown';

export const subscriptions = [
  claude.subscription('claude-max-1', { token: H.env('CLAUDE_TOKEN_1') }),
  claude.subscription('claude-max-2', { token: H.env('CLAUDE_TOKEN_2') }),
  claude.subscription('claude-max-3', { token: H.env('CLAUDE_TOKEN_3') }),
];
export const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
export const sharedQuota = '/var/lib/owner/claude-quota.db';
export const ownerTaste = H.library('owner-taste', H.memory('taste', 'taste'), jsonl.memory('/var/lib/owner/taste.jsonl'));
export const sonnet = claude.model('claude-sonnet-4-5');
export const opus = claude.model('claude-opus-4-1');

const planRank = (view: AccountView): number => (view.account.plan === 'subscription' ? 0 : 1);
const expiry = (view: AccountView): number => view.windowEndsAt?.getTime() ?? Number.MAX_SAFE_INTEGER;

export const drainSoonestExpiring = H.policy.account('drain-soonest-expiring', choice => {
  const open = choice.accounts.filter(view => view.eligible && view.usedShare < view.share);
  const ordered = [...open].sort((a, b) => planRank(a) - planRank(b) || expiry(a) - expiry(b));
  return ordered[0]?.account ?? null;
});

const sharesOf = (share: number): readonly PoolMember[] => [
  ...subscriptions.map(account => ({ account, share })),
  { account: apiAccount, share: 1 },
];

const Open = H.state('open', 'pending');
const Done = H.state('done', 'terminal', 'success');
const Abandoned = H.state('abandoned', 'terminal', 'failure');
const Planned = H.state('planned', 'pending');
const AwaitingFeatures = H.state('awaiting-features', 'waiting');
const Settling = H.state('settling', 'pending');
const Due = H.state('due', 'pending');
const Healthy = H.state('healthy', 'terminal', 'success');
const Unhealthy = H.state('unhealthy', 'terminal', 'failure');

const Bug = H.kind('bug')
  .data(z.object({ title: z.string(), description: z.string() }))
  .states(Open, Done, Abandoned)
  .onFailure('abandoned', { afterAttempts: 2 });

const Feature = H.kind('feature')
  .data(z.object({ title: z.string(), description: z.string(), epicId: z.string().optional() }))
  .states(Open, Done, Abandoned)
  .onFailure('abandoned', { afterAttempts: 2 });

const Epic = H.kind('epic')
  .data(z.object({ title: z.string(), description: z.string() }))
  .states(Planned, AwaitingFeatures, Settling, Done, Abandoned);

const Heartbeat = H.kind('service-heartbeat')
  .data(z.object({ service: z.string() }))
  .states(Due, Healthy, Unhealthy);

const codingExperience = H.library('coding-experience', H.memory('coding-lessons', 'experience'), jsonl.memory('.harness/experience.jsonl'));

const worktrees = git.worktree('product-worktrees', { repo: '.', slots: 3 });
const codingLocal = shell.local('coding-local', { slots: 2 });

const projectChecks = H.command('project-checks').argv(() => ['npm', 'run', 'check']).on(worktrees).recover('rerun');

const builderModel = H.policy.model('cheap-until-unreliable', choice => {
  const cheap = choice.metrics.successRate({ kind: choice.kind, model: sonnet, days: 14 });
  return cheap.samples >= 20 && cheap.value !== null && cheap.value < 0.85 ? opus : sonnet;
});

const builderRole = H.role('builder')
  .input(z.object({ title: z.string(), description: z.string(), notes: z.array(z.string()) }))
  .output(z.object({ summary: z.string(), question: z.string().optional() }))
  .prompt(input => `Implement: ${input.title}\n\n${input.description}\n\n${input.notes.join('\n')}`)
  .intents(['read', 'edit', 'execute']);

const auditorRole = H.role('auditor')
  .input(z.object({ title: z.string(), description: z.string(), summary: z.string() }))
  .output(z.object({ deficits: z.array(z.string()) }))
  .prompt(input => `Audit the change for "${input.title}".\n\n${input.summary}`)
  .intents(['read', 'execute']);

const plannerRole = H.role('planner')
  .input(z.object({ title: z.string(), description: z.string() }))
  .output(z.object({ features: z.array(z.object({ title: z.string(), description: z.string() })) }))
  .prompt(input => `Decompose this epic into features: ${input.title}\n\n${input.description}`)
  .intents(['read']);

const builder = H.agent('builder', builderRole)
  .model(builderModel)
  .on(worktrees)
  .recalls(ownerTaste, codingExperience)
  .guards(claude.fileLeases(), claude.stopCheck(projectChecks));
const auditor = H.agent('auditor', auditorRole).model(opus).on(worktrees).recalls(codingExperience).records(codingExperience);
const planner = H.agent('planner', plannerRole).model(opus).recalls(ownerTaste);

const ownerDecision = H.decision('owner-decision')
  .input(z.object({ question: z.string() }))
  .output(z.object({ answer: z.string() }))
  .show(input => input.question);

const buildAndAudit = H.flow('build-and-audit')
  .for(Bug, Feature)
  .params(z.object({ rounds: z.number() }))
  .does(async ctx => {
    const { title, description } = ctx.unit.data;
    let notes: string[] = [];
    for (let round = 1; round <= ctx.params.rounds; round += 1) {
      const build = await ctx.run(builder, { title, description, notes });
      if (build.ok === false) return ctx.fail(build.error);
      if (build.value.question !== undefined) {
        const ruling = await ctx.decide(ownerDecision, { question: build.value.question });
        notes = [...notes, `The owner decided: ${ruling.answer}`];
        continue;
      }
      const audit = await ctx.run(auditor, { title, description, summary: build.value.summary });
      if (audit.ok === false) return ctx.fail(audit.error);
      if (audit.value.deficits.length === 0) return 'done';
      notes = audit.value.deficits;
    }
    return ctx.fail(`deficits remain after ${ctx.params.rounds} rounds`);
  });

const linearKey = H.env('LINEAR_API_KEY');
const bugTracker = linear.tracker(Bug, {
  apiKey: linearKey,
  team: 'product',
  label: 'bug',
  read: issue => ({ title: issue.title, description: issue.description }),
  statuses: { open: 'Todo', done: 'Done', abandoned: 'Canceled' },
});
const featureTracker = linear.tracker(Feature, {
  apiKey: linearKey,
  team: 'product',
  label: 'feature',
  read: issue => ({ title: issue.title, description: issue.description, epicId: issue.parentId }),
  statuses: { open: 'Todo', done: 'Done', abandoned: 'Canceled' },
});
const epicTracker = linear.tracker(Epic, {
  apiKey: linearKey,
  team: 'product',
  label: 'epic',
  read: issue => ({ title: issue.title, description: issue.description }),
  statuses: { planned: 'Todo', 'awaiting-features': 'In Progress', settling: 'In Review', done: 'Done', abandoned: 'Canceled' },
});
const bugFolder = folder.files(Bug, {
  dir: 'bugs',
  read: file => ({ title: String(file.frontmatter.title ?? file.path), description: file.body }),
});

const bugs = H.lane('bugs', Bug).handler(buildAndAudit, { rounds: 3 }).suppliers(bugTracker, bugFolder, H.operator).store(bugTracker).wip(2);
const features = H.lane('features', Feature).handler(buildAndAudit, { rounds: 5 }).suppliers(featureTracker, H.operator).store(featureTracker);

const decomposeEpic = H.flow('decompose-epic').for(Epic).does(async ctx => {
  const plan = await ctx.run(planner, { title: ctx.unit.data.title, description: ctx.unit.data.description });
  if (plan.ok === false) return ctx.fail(plan.error);
  await ctx.spawn(features, plan.value.features.map(feature => ({ ...feature, epicId: ctx.unit.key })));
  return ctx.until('awaiting-features', { children: true, then: 'settling' });
});

const settleEpic = H.flow('settle-epic').for(Epic).does(async ctx => {
  const children = await ctx.children();
  return children.every(child => child.state === Done.name) ? 'done' : 'abandoned';
});

const epics = H.lane('epics', Epic).handler({ planned: decomposeEpic, settling: settleEpic }).suppliers(epicTracker).store(epicTracker).wip(1);

const probe = H.command('probe-service')
  .input(z.object({ service: z.string() }))
  .argv(input => ['curl', '-fsS', `https://${input.service}.internal/health`])
  .on(codingLocal)
  .recover('rerun');

const checkHeartbeat = H.flow('check-heartbeat').for(Heartbeat).does(async ctx => {
  const result = await ctx.run(probe, { service: ctx.unit.data.service });
  return result.ok ? 'healthy' : 'unhealthy';
});

const services = ['api', 'web', 'worker'];
const heartbeats = H.lane('heartbeats', Heartbeat)
  .handler(checkHeartbeat)
  .suppliers(H.clock('every-five-minutes', Heartbeat, { every: { minutes: 5 } }, tick =>
    services.map(service => ({ create: { service }, key: `${service}-${tick.now.toISOString()}` }))));

const failedHeartbeatFilesBug = H.trigger('failed-heartbeat-files-bug', H.on.enters(Heartbeat, 'unhealthy'), (event, act) =>
  act.create(bugs, {
    title: `Service ${event.unit.data.service} failed its heartbeat`,
    description: `The heartbeat at ${event.at.toISOString()} did not pass.`,
  }, `heartbeat-${event.unit.data.service}`));

const laneOrder = [heartbeats.name, bugs.name, features.name, epics.name];
const starvedAfterMs = 4 * 60 * 60 * 1000;
const rank = (unit: PendingView): number =>
  unit.lane === features.name && unit.waitedMs > starvedAfterMs ? 0.5 : laneOrder.indexOf(unit.lane);

const codingScheduler = H.policy.scheduler('heartbeats-bugs-features-epics', view => ({
  start: [...view.pending].sort((a, b) => rank(a) - rank(b)),
}));

export const codingHarness = H.harness('coding-team')
  .ledger(sqlite.ledger('.harness/coding.db', { sharedQuota }))
  .pools(H.pool('coding-accounts', sharesOf(0.6), drainSoonestExpiring))
  .lanes(heartbeats, bugs, features, epics)
  .triggers(failedHeartbeatFilesBug)
  .scheduler(codingScheduler)
  .clients(http.control({
    port: 7401,
    token: H.env('CODING_CONTROL_TOKEN'),
    grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveDecisions, H.ops.writeMemory, H.ops.readTelemetry, H.ops.readAccounts, H.ops.setShares],
  }))
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));

const NeedsWork = H.state('needs-work', 'pending');
const Published = H.state('published', 'terminal', 'success');
const Retired = H.state('retired', 'terminal', 'neutral');

const DocPage = H.kind('doc-page')
  .data(z.object({ path: z.string(), title: z.string(), body: z.string() }))
  .states(NeedsWork, Published, Retired);

const docsFolder = folder.files(DocPage, {
  dir: 'docs',
  read: file => ({ path: file.path, title: String(file.frontmatter.title ?? file.path), body: file.body }),
  write: (_data, state) => ({ status: state }),
});

const docsExperience = H.library('docs-experience', H.memory('docs-lessons', 'experience'), jsonl.memory('.harness/docs-experience.jsonl'));
const docsWorktrees = git.worktree('docs-worktrees', { repo: '.', slots: 2 });

const writerRole = H.role('writer')
  .input(z.object({ path: z.string(), title: z.string(), body: z.string() }))
  .output(z.object({ summary: z.string() }))
  .prompt(input => `Revise the page ${input.path} ("${input.title}").\n\n${input.body}`)
  .intents(['read', 'edit']);

const writer = H.agent('writer', writerRole).model(sonnet).on(docsWorktrees).recalls(ownerTaste, docsExperience).records(docsExperience);

const linkCheck = H.command('link-check')
  .input(z.object({ path: z.string() }))
  .argv(input => ['link-check', input.path])
  .on(docsWorktrees)
  .recover('rerun');

const writeDoc = H.flow('write-doc').for(DocPage).does(async ctx => {
  const written = await ctx.run(writer, ctx.unit.data);
  if (written.ok === false) return ctx.fail(written.error);
  const links = await ctx.run(linkCheck, { path: ctx.unit.data.path });
  if (links.ok === false) return ctx.fail(links.error);
  return 'published';
});

const docPages = H.lane('doc-pages', DocPage).handler(writeDoc).suppliers(docsFolder).store(docsFolder);

export const docsHarness = H.harness('documentation')
  .ledger(sqlite.ledger('.harness/docs.db', { sharedQuota }))
  .pools(H.pool('docs-accounts', sharesOf(0.3), drainSoonestExpiring))
  .lanes(docPages)
  .clients(http.control({
    port: 7402,
    token: H.env('DOCS_CONTROL_TOKEN'),
    grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveDecisions, H.ops.writeMemory, H.ops.readTelemetry, H.ops.readAccounts, H.ops.setShares],
  }))
  .observers(markdown.board('BOARD.md'));

export function startCoding() {
  return codingHarness.start();
}

export function startDocs() {
  return docsHarness.start();
}
