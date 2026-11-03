import { z } from 'zod';
import { H } from 'harness-dsl';
import type { PendingView } from 'harness-dsl';
import * as claude from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as linear from 'harness-dsl/linear';
import * as folder from 'harness-dsl/folder';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as git from 'harness-dsl/git';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const sharedQuota = sqlite.quota('~/.harness/shared/quota.sqlite');

export const claudeOne = claude.subscription('claude-one', { token: H.env('CLAUDE_ONE_TOKEN'), quota: sharedQuota });
export const claudeTwo = claude.subscription('claude-two', { token: H.env('CLAUDE_TWO_TOKEN'), quota: sharedQuota });
export const claudeThree = claude.subscription('claude-three', { token: H.env('CLAUDE_THREE_TOKEN'), quota: sharedQuota });
export const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota: sharedQuota });

export const sonnet = claude.model('claude-sonnet-4');
export const opus = claude.model('claude-opus-4');

export const taste = H.memory('taste', 'taste');
export const experience = H.memory('experience', 'experience');
export const ownerTaste = H.library('owner-taste', taste, jsonl.memory('~/.harness/shared/taste.jsonl'));

export const soonestExpiringFirst = H.policy.account('soonest-expiring-first', choice => {
  const open = choice.accounts.filter(view => view.eligible && view.usedShare < view.share);
  const subscriptions = open
    .filter(view => view.account.plan === 'subscription')
    .sort(
      (a, b) =>
        (a.windowEndsAt?.getTime() ?? Number.MAX_SAFE_INTEGER) - (b.windowEndsAt?.getTime() ?? Number.MAX_SAFE_INTEGER)
    );
  const chosen = subscriptions.length > 0 ? subscriptions[0] : open.find(view => view.account.plan === 'metered');
  return chosen === undefined ? null : chosen.account;
});

const productPool = H.pool(
  'product-accounts',
  [
    { account: claudeOne, share: 0.6 },
    { account: claudeTwo, share: 0.6 },
    { account: claudeThree, share: 0.6 },
    { account: apiAccount, share: 1 },
  ],
  soonestExpiringFirst
);

const productExperience = H.library('product-experience', experience, jsonl.memory('product/.harness/experience.jsonl'));
const worktree = git.worktree('product-worktree', { repo: 'product', slots: 3 });
const localRunner = shell.local('product-local', { slots: 4 });

const backlog = H.state('backlog', 'pending');
const done = H.state('done', 'terminal', 'success');
const wontfix = H.state('wontfix', 'terminal', 'neutral');
const stuck = H.state('stuck', 'terminal', 'failure');

const bug = H.kind('bug')
  .data(z.object({ title: z.string(), description: z.string() }))
  .states(backlog, done, wontfix, stuck);
const feature = H.kind('feature')
  .data(z.object({ title: z.string(), description: z.string(), epic: z.string().optional() }))
  .states(backlog, done, wontfix, stuck);
const epic = H.kind('epic')
  .data(z.object({ title: z.string(), description: z.string() }))
  .states(backlog, done, wontfix, stuck);

const due = H.state('due', 'pending');
const healthy = H.state('healthy', 'terminal', 'success');
const down = H.state('down', 'terminal', 'failure');
const heartbeat = H.kind('service-heartbeat').data(z.object({ service: z.string() })).states(due, healthy, down);

const statuses = { backlog: 'Todo', done: 'Done', wontfix: 'Canceled', stuck: 'Blocked' };
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
  read: issue => ({ title: issue.title, description: issue.description, epic: issue.parentId }),
  statuses,
});
const epicTracker = linear.tracker(epic, {
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'PRODUCT',
  label: 'epic',
  read: issue => ({ title: issue.title, description: issue.description }),
  statuses,
});
const bugFolder = folder.files(bug, {
  dir: 'product/bugs',
  read: file => ({
    title: typeof file.frontmatter.title === 'string' ? file.frontmatter.title : file.path,
    description: file.body,
  }),
  key: file => file.path,
});

const projectChecks = H.command('project-checks').argv(() => ['npm', 'run', 'check']).on(worktree);

const builderRole = H.role('builder')
  .input(z.object({ title: z.string(), description: z.string(), round: z.number(), deficits: z.array(z.string()) }))
  .output(z.object({ summary: z.string(), question: z.string().optional() }))
  .prompt(input => `Round ${input.round}: build "${input.title}".\n${input.description}\nOpen deficits:\n${input.deficits.join('\n')}`)
  .intents(['read', 'edit', 'execute']);
const auditorRole = H.role('auditor')
  .input(z.object({ title: z.string(), description: z.string() }))
  .output(z.object({ deficits: z.array(z.string()) }))
  .prompt(input => `Audit the work on "${input.title}" against:\n${input.description}`)
  .intents(['read', 'execute']);
const plannerRole = H.role('planner')
  .input(z.object({ title: z.string(), description: z.string() }))
  .output(z.object({ features: z.array(z.object({ title: z.string(), description: z.string() })) }))
  .prompt(input => `Decompose the epic "${input.title}" into features.\n${input.description}`)
  .intents(['read']);

const cheapUntilUnreliable = H.policy.model('cheap-until-unreliable', [sonnet, opus], choice => {
  const cheap = choice.metrics.successRate({ kind: choice.kind, seat: choice.seat, model: sonnet, days: 14 });
  if (cheap.value === null || cheap.samples < 20) return sonnet;
  return cheap.value < 0.85 ? opus : sonnet;
});

const builder = H.seat('builder', builderRole)
  .model(cheapUntilUnreliable)
  .on(worktree)
  .recalls(productExperience, ownerTaste)
  .guards(claude.fileLeases(), claude.stopCheck(projectChecks));
const auditor = H.seat('auditor', auditorRole).model(opus).on(worktree).recalls(productExperience).records(productExperience);
const planner = H.seat('planner', plannerRole).model(opus).recalls(ownerTaste);

const ownerDecision = H.halt('owner-decision', z.object({ proceed: z.boolean(), note: z.string().optional() }));

const buildAndAudit = H.flow('build-and-audit')
  .for(bug, feature)
  .params(z.object({ rounds: z.number().int() }))
  .does(async ctx => {
    let deficits: string[] = [];
    for (let round = 1; round <= ctx.params.rounds; round++) {
      const built = await ctx.run(builder, {
        title: ctx.unit.data.title,
        description: ctx.unit.data.description,
        round,
        deficits,
      });
      if (!built.ok) return ctx.fail(built.error);
      if (built.value.question !== undefined) {
        const answer = await ctx.halt(ownerDecision, built.value.question);
        if (!answer.proceed) return 'wontfix';
      }
      const audit = await ctx.run(auditor, { title: ctx.unit.data.title, description: ctx.unit.data.description });
      if (!audit.ok) return ctx.fail(audit.error);
      if (audit.value.deficits.length === 0) return 'done';
      deficits = audit.value.deficits;
    }
    return ctx.fail(`deficits remain after ${ctx.params.rounds} rounds`);
  });

const bugs = H.lane('bugs', bug)
  .handler(buildAndAudit, { rounds: 3 })
  .retries(2, { backoff: { first: { minutes: 10 }, factor: 2 }, exhausted: 'stuck' })
  .suppliers(bugTracker, bugFolder, H.operator)
  .store(bugTracker)
  .wip(2);

const features = H.lane('features', feature)
  .handler(buildAndAudit, { rounds: 5 })
  .retries(2, { backoff: { first: { minutes: 10 }, factor: 2 }, exhausted: 'stuck' })
  .suppliers(featureTracker, H.operator)
  .store(featureTracker);

const planEpic = H.flow('plan-epic')
  .for(epic)
  .does(async ctx => {
    const plan = await ctx.run(planner, { title: ctx.unit.data.title, description: ctx.unit.data.description });
    if (!plan.ok) return ctx.fail(plan.error);
    const children = await ctx.spawn(
      features,
      plan.value.features.map(item => ({ title: item.title, description: item.description, epic: ctx.unit.key }))
    );
    const finished = await ctx.sleep({ children });
    return finished.some(child => child.state === 'stuck') ? 'stuck' : 'done';
  });

const epics = H.lane('epics', epic)
  .handler(planEpic)
  .retries(1, { exhausted: 'stuck' })
  .suppliers(epicTracker)
  .store(epicTracker)
  .wip(1);

const services: readonly string[] = ['api', 'web', 'worker'];
const probeService = H.command('probe-service')
  .input(z.object({ service: z.string() }))
  .argv(input => ['./scripts/probe.sh', input.service])
  .on(localRunner);

const checkHeartbeat = H.flow('check-heartbeat')
  .for(heartbeat)
  .does(async ctx => {
    const probe = await ctx.run(probeService, { service: ctx.unit.data.service });
    return probe.ok ? 'healthy' : 'down';
  });

const heartbeats = H.lane('heartbeats', heartbeat)
  .handler(checkHeartbeat)
  .retries(0, { exhausted: 'down' })
  .suppliers(H.clock('every-five-minutes', heartbeat, { every: { minutes: 5 } }, () => services.map(service => ({ create: { service } }))));

const heartbeatBug = H.trigger('failed-heartbeat-files-bug', H.on.enters(heartbeat, 'down'), (event, act) =>
  act.create(bugs, {
    title: `Heartbeat failed for ${event.unit.data.service}`,
    description: `The service ${event.unit.data.service} failed its health probe at ${event.at.toISOString()}.`,
  })
);

const productionHealth = H.command('production-health').argv(() => ['./scripts/production-health.sh']).on(localRunner);

const productOrder = H.policy.scheduler('heartbeats-bugs-features-epics', view => {
  const rank = (unit: PendingView): number => {
    if (unit.is(heartbeat)) return 0;
    if (unit.is(bug)) return 1;
    if (unit.is(feature)) return unit.waitedMs > 4 * 3600000 ? 0.5 : 2;
    return 3;
  };
  return { start: [...view.pending].sort((a, b) => rank(a) - rank(b) || b.waitedMs - a.waitedMs) };
});

export const product = H.harness('product')
  .ledger(sqlite.ledger('product/.harness/ledger.sqlite'))
  .lanes(heartbeats, bugs, features, epics)
  .pools(productPool)
  .triggers(heartbeatBug)
  .scheduler(productOrder)
  .clients(
    claude.supervisor('owner-product', {
      grants: [
        H.ops.readWork,
        H.ops.writeWork,
        H.ops.resolveHalts,
        H.ops.writeMemory,
        H.ops.readTelemetry,
        H.ops.readAccounts,
        H.ops.setShares,
        H.operation('production-health', productionHealth),
      ],
    })
  )
  .observers(markdown.board('product/.harness/board.md'), markdown.telemetry('product/.harness/telemetry.md'));

const docsPool = H.pool(
  'docs-accounts',
  [
    { account: claudeOne, share: 0.3 },
    { account: claudeTwo, share: 0.3 },
    { account: claudeThree, share: 0.3 },
  ],
  soonestExpiringFirst
);

const docsExperience = H.library('docs-experience', experience, jsonl.memory('docs/.harness/experience.jsonl'));
const docsWorktree = git.worktree('docs-worktree', { repo: 'docs', slots: 2 });

const drafted = H.state('drafted', 'pending');
const published = H.state('published', 'terminal', 'success');
const needsHelp = H.state('needs-help', 'terminal', 'failure');
const docPage = H.kind('doc-page')
  .data(z.object({ path: z.string(), title: z.string(), body: z.string() }))
  .states(drafted, published, needsHelp);

const docFolder = folder.files(docPage, {
  dir: 'docs/pages',
  read: file => ({
    path: file.path,
    title: typeof file.frontmatter.title === 'string' ? file.frontmatter.title : file.path,
    body: file.body,
  }),
  key: file => file.path,
});

const writerRole = H.role('writer')
  .input(z.object({ title: z.string(), body: z.string() }))
  .output(z.object({ body: z.string() }))
  .prompt(input => `Rewrite the page "${input.title}" for clarity:\n${input.body}`)
  .intents(['read', 'edit']);
const writer = H.seat('writer', writerRole).model(sonnet).on(docsWorktree).recalls(ownerTaste, docsExperience);

const linkCheck = H.command('link-check')
  .input(z.object({ path: z.string() }))
  .argv(input => ['npx', 'linkinator', input.path])
  .on(docsWorktree);

const writePage = H.flow('write-page')
  .for(docPage)
  .does(async ctx => {
    const written = await ctx.run(writer, { title: ctx.unit.data.title, body: ctx.unit.data.body });
    if (!written.ok) return ctx.fail(written.error);
    await ctx.update({ body: written.value.body });
    const links = await ctx.run(linkCheck, { path: ctx.unit.data.path });
    return links.ok ? 'published' : ctx.fail(`broken links: ${links.error}`);
  });

const pages = H.lane('pages', docPage)
  .handler(writePage)
  .retries(2, { exhausted: 'needs-help' })
  .suppliers(docFolder)
  .store(docFolder)
  .wip(2);

export const docs = H.harness('docs')
  .ledger(sqlite.ledger('docs/.harness/ledger.sqlite'))
  .lanes(pages)
  .pools(docsPool)
  .scheduler(H.policy.scheduler('oldest-first', view => ({ start: [...view.pending].sort((a, b) => b.waitedMs - a.waitedMs) })))
  .clients(
    claude.supervisor('owner-docs', {
      grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.writeMemory, H.ops.readTelemetry, H.ops.readAccounts],
    })
  )
  .observers(markdown.board('docs/.harness/board.md'), markdown.telemetry('docs/.harness/telemetry.md'));
