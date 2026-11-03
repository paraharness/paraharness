import { H } from 'harness-dsl';
import type { PendingView } from 'harness-dsl';
import { z } from 'zod';
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

const sharedQuota = sqlite.quota('~/.harness/quota.db');

const subscriptions = [
  claude.subscription('claude-max-1', { token: H.env('CLAUDE_TOKEN_1'), quota: sharedQuota }),
  claude.subscription('claude-max-2', { token: H.env('CLAUDE_TOKEN_2'), quota: sharedQuota }),
  claude.subscription('claude-max-3', { token: H.env('CLAUDE_TOKEN_3'), quota: sharedQuota }),
];

const sonnet = claude.model('claude-sonnet');
const opus = claude.model('claude-opus');

const taste = H.memory('taste', 'taste');
const experience = H.memory('experience', 'experience');
const ownerTaste = H.library('owner-taste', taste, jsonl.memory('~/.harness/taste.jsonl'));

const soonestExpiringFirst = H.policy.account('soonestExpiringFirst', ({ accounts }) => {
  const open = accounts.filter((a) => a.eligible && a.usedShare < a.share);
  const subscribed = open
    .filter((a) => a.account.plan === 'subscription')
    .sort((a, b) => (a.windowEndsAt?.getTime() ?? Infinity) - (b.windowEndsAt?.getTime() ?? Infinity));
  return subscribed[0]?.account ?? open.find((a) => a.account.plan === 'metered')?.account ?? null;
});

const open = H.state('open', 'pending');
const decomposed = H.state('decomposed', 'waiting');
const done = H.state('done', 'terminal', 'success');
const wontDo = H.state('wontDo', 'terminal', 'neutral');
const stuck = H.state('stuck', 'terminal', 'failure');

const work = z.object({ title: z.string(), description: z.string() });

const bug = H.kind('Bug').data(work).states(open, done, wontDo, stuck);
const feature = H.kind('Feature').data(work.extend({ epic: z.string().optional() })).states(open, done, wontDo, stuck);
const epic = H.kind('Epic').data(work).states(open, decomposed, done, wontDo, stuck);
const heartbeat = H.kind('ServiceHeartbeat')
  .data(z.object({ service: z.string() }))
  .states(H.state('due', 'pending'), H.state('healthy', 'terminal', 'success'), H.state('unhealthy', 'terminal', 'failure'));

const codingExperience = H.library('coding-experience', experience, jsonl.memory('./.harness/experience.jsonl'));

const worktrees = git.worktree('worktrees', { repo: '.', slots: 3 });
const localBox = shell.local('local', { slots: 2 });

const projectChecks = H.command('projectChecks').argv(() => ['npm', 'run', 'check']).on(worktrees);

const builderRole = H.role('builder')
  .input(z.object({ title: z.string(), description: z.string(), deficits: z.array(z.string()) }))
  .output(z.object({ summary: z.string(), needsOwner: z.string().optional() }))
  .prompt((i) => `Build: ${i.title}\n${i.description}\nOpen deficits:\n${i.deficits.join('\n')}`)
  .intents(['read', 'edit', 'execute']);

const auditorRole = H.role('auditor')
  .input(z.object({ title: z.string(), summary: z.string() }))
  .output(z.object({ deficits: z.array(z.string()) }))
  .prompt((i) => `Audit the change for "${i.title}": ${i.summary}`)
  .intents(['read', 'execute']);

const plannerRole = H.role('planner')
  .input(z.object({ title: z.string(), description: z.string() }))
  .output(z.object({ features: z.array(work) }))
  .prompt((i) => `Split the epic "${i.title}" into features.\n${i.description}`)
  .intents(['read']);

const cheapUntilItSlips = H.policy.model('cheapUntilItSlips', [sonnet, opus], (choice) => {
  const record = choice.metrics.successRate({ kind: choice.kind, seat: choice.seat, model: sonnet, days: 14 });
  return record.samples >= 20 && record.value !== null && record.value < 0.85 ? opus : sonnet;
});

const builder = H.seat('builder', builderRole)
  .model(cheapUntilItSlips)
  .on(worktrees)
  .recalls(codingExperience, ownerTaste)
  .guards(claude.fileLeases(), claude.stopCheck(projectChecks));

const auditor = H.seat('auditor', auditorRole).model(sonnet).on(worktrees).recalls(codingExperience).records(codingExperience);
const planner = H.seat('planner', plannerRole).model(opus).recalls(ownerTaste);

const ownerDecision = H.halt('ownerDecision', z.object({ answer: z.string() })).about(z.object({ question: z.string() }));

const buildAndAudit = H.flow('buildAndAudit')
  .for(bug, feature)
  .params(z.object({ rounds: z.number() }))
  .does(async (ctx) => {
    let deficits: string[] = [];
    for (let round = 0; round < ctx.params.rounds; round++) {
      const built = await ctx.run(builder, { title: ctx.unit.data.title, description: ctx.unit.data.description, deficits });
      if (!built.ok) return ctx.fail(built.error);
      let summary = built.value.summary;
      if (built.value.needsOwner !== undefined) {
        const decision = await ctx.halt(ownerDecision, built.value.needsOwner, { question: built.value.needsOwner });
        summary = `${summary}\nOwner decided: ${decision.answer}`;
      }
      const audit = await ctx.run(auditor, { title: ctx.unit.data.title, summary });
      if (!audit.ok) return ctx.fail(audit.error);
      if (audit.value.deficits.length === 0) return 'done';
      deficits = audit.value.deficits;
    }
    return ctx.fail(`deficits remain after ${ctx.params.rounds} rounds`);
  });

const workStatuses = { open: 'Todo', done: 'Done', wontDo: 'Canceled', stuck: 'Blocked' };

const bugTracker = linear.tracker(bug, {
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'ENG',
  label: 'bug',
  read: (issue) => ({ title: issue.title, description: issue.description }),
  statuses: workStatuses,
});
const featureTracker = linear.tracker(feature, {
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'ENG',
  label: 'feature',
  read: (issue) => ({ title: issue.title, description: issue.description, epic: issue.parentId }),
  statuses: workStatuses,
});
const epicTracker = linear.tracker(epic, {
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'ENG',
  label: 'epic',
  read: (issue) => ({ title: issue.title, description: issue.description }),
  statuses: { open: 'Todo', decomposed: 'In Progress', done: 'Done', wontDo: 'Canceled', stuck: 'Blocked' },
});

const bugFolder = folder.files(bug, {
  dir: './bugs',
  read: (file) => ({ title: String(file.frontmatter['title'] ?? file.path), description: file.body }),
});

const bugs = H.lane('bugs', bug)
  .handler(buildAndAudit, { rounds: 3 })
  .suppliers(bugTracker, bugFolder, H.operator)
  .store(bugTracker)
  .wip(2)
  .retries(2, { backoff: { first: { minutes: 5 }, factor: 2 }, exhausted: 'stuck' });

const features = H.lane('features', feature)
  .handler(buildAndAudit, { rounds: 5 })
  .suppliers(featureTracker, H.operator)
  .store(featureTracker)
  .retries(2, { backoff: { first: { minutes: 5 }, factor: 2 }, exhausted: 'stuck' });

const decompose = H.flow('decompose')
  .for(epic)
  .does(async (ctx) => {
    const plan = await ctx.run(planner, { title: ctx.unit.data.title, description: ctx.unit.data.description });
    if (!plan.ok) return ctx.fail(plan.error);
    const children = await ctx.spawn(features, plan.value.features.map((f) => ({ ...f, epic: ctx.unit.key })));
    const ended = await ctx.wait('decomposed', { children });
    return ended.every((f) => f.state === 'done') ? 'done' : 'stuck';
  });

const epics = H.lane('epics', epic)
  .handler(decompose)
  .suppliers(epicTracker)
  .store(epicTracker)
  .wip(1)
  .retries(1, { exhausted: 'stuck' });

const probeService = H.command('probeService')
  .input(z.object({ service: z.string() }))
  .argv((i) => ['./scripts/probe.sh', i.service])
  .on(localBox);

const checkHeartbeat = H.flow('checkHeartbeat')
  .for(heartbeat)
  .does(async (ctx) => {
    const probe = await ctx.run(probeService, { service: ctx.unit.data.service });
    return probe.ok ? 'healthy' : 'unhealthy';
  });

const heartbeats = H.lane('heartbeats', heartbeat)
  .handler(checkHeartbeat)
  .suppliers(H.clock('everyFiveMinutes', heartbeat, { every: { minutes: 5 } }, () => [{ create: { service: 'api' } }]))
  .retries(0, { exhausted: 'unhealthy' });

const unhealthyFilesBug = H.trigger('unhealthyFilesBug', H.on.enters(heartbeat, 'unhealthy'), (event, act) =>
  act.create(bugs, {
    title: `${event.unit.data.service} heartbeat failed`,
    description: `The heartbeat at ${event.at.toISOString()} failed.`,
  })
);

const codingOrder = H.policy.scheduler('codingOrder', (view) => {
  const rank = (p: PendingView) =>
    p.is(heartbeat) ? 0 : p.is(bug) ? 1 : p.is(feature) ? (p.waitedMs > 2 * 3_600_000 ? 1 : 2) : 3;
  return { start: [...view.pending].sort((a, b) => rank(a) - rank(b) || b.waitedMs - a.waitedMs) };
});

const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota: sharedQuota });

const codingAccounts = H.pool(
  'coding-accounts',
  [...subscriptions.map((account) => ({ account, share: 0.6 })), { account: apiAccount, share: 1 }],
  soonestExpiringFirst
);

const productionProbe = H.command('productionProbe').argv(() => ['./scripts/probe.sh', 'production']).on(localBox);

export const coding = H.harness('coding-team')
  .ledger(sqlite.ledger('./coding/.harness/ledger.db'))
  .lanes(heartbeats, bugs, features, epics)
  .pools(codingAccounts)
  .triggers(unhealthyFilesBug)
  .scheduler(codingOrder)
  .clients(
    http.control({
      port: 7401,
      token: H.env('CODING_CONTROL_TOKEN'),
      grants: [
        H.ops.readWork,
        H.ops.writeWork,
        H.ops.resolveHalts,
        H.ops.writeMemory,
        H.ops.readTelemetry,
        H.ops.readAccounts,
        H.ops.setShares,
        H.operation('productionProbe', productionProbe),
      ],
    })
  )
  .observers(markdown.board('./coding/BOARD.md'), markdown.telemetry('./coding/TELEMETRY.md'));

const docPage = H.kind('DocPage')
  .data(z.object({ title: z.string(), path: z.string(), body: z.string() }))
  .states(
    H.state('draft', 'pending'),
    H.state('published', 'terminal', 'success'),
    H.state('brokenLinks', 'terminal', 'failure')
  );

const docsExperience = H.library('docs-experience', experience, jsonl.memory('./docs-site/.harness/experience.jsonl'));

const docsFolder = folder.files(docPage, {
  dir: './docs-site/pages',
  read: (file) => ({ title: String(file.frontmatter['title'] ?? file.path), path: file.path, body: file.body }),
  key: (file) => file.path,
});

const writerRole = H.role('writer')
  .input(z.object({ title: z.string(), body: z.string() }))
  .output(z.object({ body: z.string() }))
  .prompt((i) => `Revise the page "${i.title}":\n${i.body}`)
  .intents(['read', 'edit']);

const writer = H.seat('writer', writerRole).model(sonnet).recalls(ownerTaste, docsExperience).records(docsExperience);

const linkCheck = H.command('linkCheck')
  .input(z.object({ path: z.string() }))
  .argv((i) => ['npx', 'linkinator', i.path])
  .on(shell.local('docs-local', { slots: 2 }));

const writePage = H.flow('writePage')
  .for(docPage)
  .does(async (ctx) => {
    const written = await ctx.run(writer, { title: ctx.unit.data.title, body: ctx.unit.data.body });
    if (!written.ok) return ctx.fail(written.error);
    await ctx.update({ body: written.value.body });
    const links = await ctx.run(linkCheck, { path: ctx.unit.data.path });
    return links.ok ? 'published' : 'brokenLinks';
  });

const pages = H.lane('pages', docPage)
  .handler(writePage)
  .suppliers(docsFolder)
  .store(docsFolder)
  .wip(2)
  .retries(1, { exhausted: 'brokenLinks' });

const docsAccounts = H.pool(
  'docs-accounts',
  subscriptions.map((account) => ({ account, share: 0.3 })),
  soonestExpiringFirst
);

export const docs = H.harness('documentation')
  .ledger(sqlite.ledger('./docs-site/.harness/ledger.db'))
  .lanes(pages)
  .pools(docsAccounts)
  .clients(
    http.control({
      port: 7402,
      token: H.env('DOCS_CONTROL_TOKEN'),
      grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.writeMemory, H.ops.readTelemetry, H.ops.readAccounts, H.ops.setShares],
    })
  )
  .observers(markdown.board('./docs-site/BOARD.md'));
