import { z } from 'zod';
import { H } from 'harness-dsl';
import type { AccountView, PendingView } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as cc from 'harness-dsl/claude-code';
import * as folder from 'harness-dsl/folder';
import * as git from 'harness-dsl/git';
import * as http from 'harness-dsl/http';
import * as jsonl from 'harness-dsl/jsonl';
import * as linear from 'harness-dsl/linear';
import * as markdown from 'harness-dsl/markdown';
import * as shell from 'harness-dsl/shell';
import * as sqlite from 'harness-dsl/sqlite';

const accountQuota = sqlite.quota('~/.harness/accounts.db');
const windowEnd = (view: AccountView) => view.windowEndsAt?.getTime() ?? Number.POSITIVE_INFINITY;

export const shared = {
  subscriptions: [
    cc.subscription('claude-max-1', { token: H.env('CLAUDE_TOKEN_1'), quota: accountQuota }),
    cc.subscription('claude-max-2', { token: H.env('CLAUDE_TOKEN_2'), quota: accountQuota }),
    cc.subscription('claude-max-3', { token: H.env('CLAUDE_TOKEN_3'), quota: accountQuota }),
  ],
  api: anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota: accountQuota }),
  soonestExpiring: H.policy.account('soonest-expiring-first', ({ accounts }) => {
    const subscriptions = accounts
      .filter((view) => view.eligible && view.account.plan === 'subscription')
      .sort((a, b) => windowEnd(a) - windowEnd(b));
    const metered = accounts.find((view) => view.eligible && view.account.plan === 'metered');
    return subscriptions[0]?.account ?? metered?.account ?? null;
  }),
  tasteArchive: H.archive('owner-taste', H.memory('taste', 'taste'), jsonl.memory('~/.harness/taste.jsonl')),
  experience: H.memory('experience', 'experience'),
  sonnet: cc.model('claude-sonnet-4-5'),
  opus: cc.model('claude-opus-4-1'),
};

const open = H.state('open', 'pending');
const done = H.state('done', 'terminal', 'success');
const abandoned = H.state('abandoned', 'terminal', 'failure');
const awaitingFeatures = H.state('awaitingFeatures', 'waiting');
const closing = H.state('closing', 'pending');
const due = H.state('due', 'pending');
const healthy = H.state('healthy', 'terminal', 'success');
const unhealthy = H.state('unhealthy', 'terminal', 'failure');

const ticket = z.object({ title: z.string(), description: z.string() });

const Bug = H.kind('bug').data(ticket).states(open, done, abandoned).failsTo('abandoned');
const Feature = H.kind('feature').data(ticket).states(open, done, abandoned).failsTo('abandoned');
const Epic = H.kind('epic').data(ticket).states(open, awaitingFeatures, closing, done, abandoned).failsTo('abandoned');
const Heartbeat = H.kind('service-heartbeat')
  .data(z.object({ service: z.string(), checkedAt: z.string() }))
  .states(due, healthy, unhealthy);

const codingExperience = H.archive(
  'coding-experience',
  shared.experience,
  jsonl.memory('coding/.harness/experience.jsonl'),
);

const builderRole = H.role('builder')
  .input(z.object({ task: z.string(), deficits: z.array(z.string()), ownerAnswer: z.string().optional() }))
  .output(z.object({ summary: z.string(), question: z.string().optional() }))
  .prompt(
    (work) =>
      `${work.task}\n\nOpen deficits:\n${work.deficits.join('\n')}\n\n${work.ownerAnswer === undefined ? '' : `Owner decided: ${work.ownerAnswer}`}`,
  )
  .intents(['read', 'edit', 'execute']);

const auditorRole = H.role('auditor')
  .input(z.object({ task: z.string(), summary: z.string() }))
  .output(z.object({ deficits: z.array(z.string()) }))
  .prompt((work) => `Audit the change for this task and list every deficit.\n\n${work.task}\n\nBuilder says: ${work.summary}`)
  .intents(['read', 'execute']);

const plannerRole = H.role('planner')
  .input(ticket)
  .output(z.object({ features: z.array(ticket) }))
  .prompt((epic) => `Decompose this epic into features.\n\n${epic.title}\n\n${epic.description}`)
  .intents(['read']);

const worktree = git.worktree('coding-worktree', { repo: '.', slots: 3 });
const local = shell.local('coding-local', { slots: 2 });

const projectChecks = H.command('project-checks').argv(() => ['npm', 'run', 'check']).on(worktree).recovers('rerun');

const healthCheck = H.command('health-check')
  .input(z.object({ service: z.string() }))
  .argv((target) => ['curl', '-fsS', `https://${target.service}.example.com/health`])
  .on(local)
  .recovers('rerun');

const productionProbe = H.command('production-health-probe')
  .output(z.object({ healthy: z.boolean(), detail: z.string() }))
  .argv(() => ['production-probe', '--json'])
  .on(local)
  .recovers('rerun');

const builderModel = H.policy.model('builder-model', ({ kind, metrics }) => {
  const cheaper = metrics.successRate({ kind, model: shared.sonnet, days: 14 });
  return cheaper.samples >= 20 && cheaper.value !== null && cheaper.value < 0.85 ? shared.opus : shared.sonnet;
});

const builder = H.agent('builder', builderRole)
  .model(builderModel)
  .on(worktree)
  .recalls(H.briefing('builder-briefing', [codingExperience, shared.tasteArchive]))
  .guards(cc.fileLeases(), cc.stopCheck(projectChecks));

const auditor = H.agent('auditor', auditorRole)
  .model(shared.opus)
  .on(worktree)
  .recalls(H.briefing('auditor-briefing', [codingExperience]))
  .records(codingExperience);

const planner = H.agent('planner', plannerRole)
  .model(shared.opus)
  .recalls(H.briefing('planner-briefing', [shared.tasteArchive]));

const ownerDecision = H.halt('owner-decision', z.object({ answer: z.string() }));

const ticketFlow = H.flow('ticket')
  .for(Bug, Feature)
  .params(z.object({ rounds: z.number().int().positive() }))
  .does(async (ctx) => {
    const task = `${ctx.unit.data.title}\n\n${ctx.unit.data.description}`;
    let deficits: string[] = [];
    let ownerAnswer: string | undefined;
    for (let round = 0; round < ctx.params.rounds; round += 1) {
      const built = await ctx.run(builder, { task, deficits, ownerAnswer });
      if (!built.ok) return ctx.fail(built.error);
      if (built.value.question !== undefined) {
        const reply = await ctx.halt(ownerDecision, built.value.question);
        ownerAnswer = reply.answer;
        continue;
      }
      const audit = await ctx.run(auditor, { task, summary: built.value.summary });
      if (!audit.ok) return ctx.fail(audit.error);
      if (audit.value.deficits.length === 0) return 'done';
      deficits = audit.value.deficits;
    }
    return ctx.fail(`deficits remain after ${ctx.params.rounds} rounds`, 'abandoned');
  });

const heartbeatFlow = H.flow('heartbeat')
  .for(Heartbeat)
  .does(async (ctx) => {
    const probe = await ctx.run(healthCheck, { service: ctx.unit.data.service });
    return probe.ok ? 'healthy' : 'unhealthy';
  });

const linearKey = H.env('LINEAR_API_KEY');
const ticketStatuses = { open: 'Todo', done: 'Done', abandoned: 'Canceled' };
const readIssue = (issue: linear.Issue) => ({ title: issue.title, description: issue.description });

const bugTracker = linear.tracker(Bug, {
  apiKey: linearKey,
  team: 'PRODUCT',
  label: 'bug',
  read: readIssue,
  statuses: ticketStatuses,
});
const featureTracker = linear.tracker(Feature, {
  apiKey: linearKey,
  team: 'PRODUCT',
  label: 'feature',
  read: readIssue,
  statuses: ticketStatuses,
});
const epicTracker = linear.tracker(Epic, {
  apiKey: linearKey,
  team: 'PRODUCT',
  label: 'epic',
  read: readIssue,
  statuses: { open: 'Todo', awaitingFeatures: 'In Progress', closing: 'In Review', done: 'Done', abandoned: 'Canceled' },
});
const bugFolder = folder.files(Bug, {
  dir: 'bugs',
  read: (file) => ({
    title: typeof file.frontmatter.title === 'string' ? file.frontmatter.title : file.path,
    description: file.body,
  }),
});

const bugs = H.lane('bugs', Bug)
  .handler(ticketFlow, { rounds: 3 })
  .suppliers(bugTracker, bugFolder, H.operator)
  .store(bugTracker)
  .wip(2);

const features = H.lane('features', Feature)
  .handler(ticketFlow, { rounds: 5 })
  .suppliers(featureTracker, H.operator)
  .store(featureTracker);

const epicFlow = H.flow('epic')
  .for(Epic)
  .does(async (ctx) => {
    const plan = await ctx.run(planner, { title: ctx.unit.data.title, description: ctx.unit.data.description });
    if (!plan.ok) return ctx.fail(plan.error);
    await ctx.spawn(features, plan.value.features);
    return ctx.wait('awaitingFeatures', { children: true, then: 'closing' });
  })
  .phase('closing', async (ctx) => {
    const children = await ctx.children(features);
    return children.every((child) => child.state === 'done') ? 'done' : 'abandoned';
  });

const epics = H.lane('epics', Epic).handler(epicFlow).suppliers(epicTracker).store(epicTracker).wip(1);

const services = ['api', 'web', 'worker'];
const heartbeats = H.lane('heartbeats', Heartbeat)
  .handler(heartbeatFlow)
  .suppliers(
    H.clock('heartbeat-clock', Heartbeat, { every: { minutes: 5 } }, ({ now }) =>
      services.map((service) => ({ create: { service, checkedAt: now.toISOString() } })),
    ),
  );

const unhealthyServiceFilesBug = H.trigger(
  'unhealthy-service-files-bug',
  H.on.enters(Heartbeat, 'unhealthy'),
  (event, act) =>
    act.create(
      bugs,
      {
        title: `Service ${event.unit.data.service} failed its heartbeat`,
        description: `The heartbeat at ${event.unit.data.checkedAt} failed.`,
      },
      `heartbeat-${event.unit.data.service}`,
    ),
);

const FEATURE_STARVATION_MS = 4 * 60 * 60 * 1000;

const codingPriority = H.policy.scheduler('coding-priority', ({ pending }) => {
  const rank = (unit: PendingView) =>
    unit.is(Heartbeat)
      ? 0
      : unit.is(Feature) && unit.waitedMs > FEATURE_STARVATION_MS
        ? 1
        : unit.is(Bug)
          ? 2
          : unit.is(Feature)
            ? 3
            : 4;
  return { start: [...pending].sort((a, b) => rank(a) - rank(b) || b.waitedMs - a.waitedMs) };
});

const codingAccounts = H.pool(
  'coding-accounts',
  [...shared.subscriptions.map((account) => ({ account, share: 0.6 })), { account: shared.api, share: 1 }],
  shared.soonestExpiring,
);

const supervisorGrants = [
  H.ops.readWork,
  H.ops.writeWork,
  H.ops.resolveHalts,
  H.ops.writeMemory,
  H.ops.readTelemetry,
  H.ops.readAccounts,
  H.ops.setShares,
  H.operation('production-health', productionProbe),
];

export const codingHarness = H.harness('coding-team')
  .ledger(sqlite.ledger('coding/.harness/ledger.db'))
  .lanes(heartbeats, bugs, features, epics)
  .pools(codingAccounts)
  .triggers(unhealthyServiceFilesBug)
  .scheduler(codingPriority)
  .clients(
    cc.supervisor({ grants: supervisorGrants }),
    http.control({ port: 7101, token: H.env('CODING_CONTROL_TOKEN'), grants: supervisorGrants }),
  )
  .observers(markdown.board('coding/BOARD.md'), markdown.telemetry('coding/TELEMETRY.md'));

const stale = H.state('stale', 'pending');
const published = H.state('published', 'terminal', 'success');

const DocPage = H.kind('doc-page')
  .data(z.object({ path: z.string(), title: z.string() }))
  .states(stale, published);

const docsExperience = H.archive('docs-experience', shared.experience, jsonl.memory('docs/.harness/experience.jsonl'));
const docsWorktree = git.worktree('docs-worktree', { repo: '../docs', slots: 2 });

const writerRole = H.role('writer')
  .input(z.object({ path: z.string(), title: z.string(), brokenLinks: z.array(z.string()) }))
  .output(z.object({ summary: z.string() }))
  .prompt((page) => `Bring ${page.path} ("${page.title}") up to date. Fix these broken links: ${page.brokenLinks.join(', ')}`)
  .intents(['read', 'edit']);

const writer = H.agent('writer', writerRole)
  .model(shared.sonnet)
  .on(docsWorktree)
  .recalls(H.briefing('writer-briefing', [shared.tasteArchive, docsExperience]))
  .records(docsExperience);

const linkCheck = H.command('link-check')
  .input(z.object({ path: z.string() }))
  .output(z.object({ broken: z.array(z.string()) }))
  .argv((page) => ['link-check', '--json', page.path])
  .on(docsWorktree)
  .recovers('rerun');

const docFlow = H.flow('doc-page')
  .for(DocPage)
  .does(async (ctx) => {
    let broken: string[] = [];
    for (let round = 0; round < 2; round += 1) {
      const written = await ctx.run(writer, { path: ctx.unit.data.path, title: ctx.unit.data.title, brokenLinks: broken });
      if (!written.ok) return ctx.fail(written.error);
      const checked = await ctx.run(linkCheck, { path: ctx.unit.data.path });
      if (!checked.ok) return ctx.fail(checked.error);
      if (checked.value.broken.length === 0) return 'published';
      broken = checked.value.broken;
    }
    return ctx.fail(`broken links remain: ${broken.join(', ')}`);
  });

const docsFolder = folder.files(DocPage, {
  dir: '../docs/pages',
  read: (file) => ({
    path: file.path,
    title: typeof file.frontmatter.title === 'string' ? file.frontmatter.title : file.path,
  }),
  write: (page, state) => ({ title: page.title, status: state }),
});

const docPages = H.lane('doc-pages', DocPage).handler(docFlow).suppliers(docsFolder).store(docsFolder).wip(2);

const docsAccounts = H.pool(
  'docs-accounts',
  shared.subscriptions.map((account) => ({ account, share: 0.3 })),
  shared.soonestExpiring,
);

export const docsHarness = H.harness('documentation')
  .ledger(sqlite.ledger('docs/.harness/ledger.db'))
  .lanes(docPages)
  .pools(docsAccounts)
  .clients(
    http.control({
      port: 7102,
      token: H.env('DOCS_CONTROL_TOKEN'),
      grants: [
        H.ops.readWork,
        H.ops.writeWork,
        H.ops.resolveHalts,
        H.ops.readMemory,
        H.ops.writeMemory,
        H.ops.readTelemetry,
        H.ops.readAccounts,
        H.ops.setShares,
      ],
    }),
  )
  .observers(markdown.board('docs/BOARD.md'));
