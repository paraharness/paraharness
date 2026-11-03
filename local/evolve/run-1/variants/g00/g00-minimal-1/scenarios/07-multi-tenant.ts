import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Account, Candidate, Kind, MemoryItem, Pending, RecallContext } from 'harness-dsl';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { linear } from 'harness-dsl/linear';
import { folder } from 'harness-dsl/folder';
import { git } from 'harness-dsl/git';
import { shell } from 'harness-dsl/shell';
import { markdown } from 'harness-dsl/markdown';

const sharedQuotaPath = '/home/owner/.harness/accounts.sqlite';

const max1 = claudeCode.subscription({ name: 'max-1', token: H.env('CLAUDE_MAX_1_TOKEN'), renewsAt: new Date('2026-11-09T00:00:00Z') });
const max2 = claudeCode.subscription({ name: 'max-2', token: H.env('CLAUDE_MAX_2_TOKEN'), renewsAt: new Date('2026-11-17T00:00:00Z') });
const max3 = claudeCode.subscription({ name: 'max-3', token: H.env('CLAUDE_MAX_3_TOKEN'), renewsAt: new Date('2026-11-24T00:00:00Z') });
const apiAccount = anthropic.account({ name: 'api-fallback', key: H.env('ANTHROPIC_API_KEY') });

const renewalTime = (candidate: Candidate<Account>) => candidate.quota?.renewsAt?.getTime() ?? Number.POSITIVE_INFINITY;

const claudePool = H.policy.pick('claude-pool', [max1, max2, max3, apiAccount], (ctx) => {
  const open = ctx.candidates.filter(
    (c) => c.eligible && c.value !== apiAccount && c.quota !== undefined && c.quota.shareUsed < c.quota.shareCap,
  );
  const soonest = [...open].sort((a, b) => renewalTime(a) - renewalTime(b))[0];
  return soonest === undefined ? apiAccount : soonest.value;
});

const sonnet = claudeCode.model({ name: 'sonnet', id: 'claude-sonnet-4-5', accounts: claudePool, price: { inputUsdPerMTok: 3, outputUsdPerMTok: 15 } });
const opus = claudeCode.model({ name: 'opus', id: 'claude-opus-4-1', accounts: claudePool, price: { inputUsdPerMTok: 15, outputUsdPerMTok: 75 } });

const builder = H.role('builder', {
  instructions: 'Implement the ticket in the worktree. Halt for the owner when a product decision is needed.',
  intents: ['read', 'write', 'execute', 'halt'],
});
const auditor = H.role('auditor', {
  instructions: 'Audit the change against the ticket. List every deficit. Record lessons other builders need.',
  intents: ['read', 'execute', 'record'],
});
const planner = H.role('planner', { instructions: 'Decompose the epic into independently shippable features.', intents: ['read'] });
const writer = H.role('writer', { instructions: 'Write or revise the documentation page so it is accurate and readable.', intents: ['read', 'write'] });

const within = (allowed: readonly string[] | undefined, present: readonly string[]) =>
  allowed === undefined || allowed.length === 0 || allowed.some((entry) => present.includes(entry));

const applies = (item: MemoryItem, ctx: RecallContext) =>
  item.status === 'active' &&
  within(item.when.kinds, [ctx.scope.kind]) &&
  within(item.when.roles, [ctx.scope.role]) &&
  within(item.when.tags, ctx.scope.tags) &&
  within(item.when.resources, ctx.scope.resources);

const tasteRecall = H.policy.recall('taste-most-specific', async (ctx) =>
  (await ctx.items()).filter((item) => applies(item, ctx)).sort((a, b) => ctx.specificity(b) - ctx.specificity(a)).slice(0, ctx.limit),
);

const experienceRecall = H.policy.recall('experience-specific-then-proven', async (ctx) =>
  (await ctx.items())
    .filter((item) => applies(item, ctx))
    .sort((a, b) => ctx.specificity(b) - ctx.specificity(a) || ctx.trackRecord(b).value - ctx.trackRecord(a).value)
    .slice(0, ctx.limit),
);

const Taste = H.memory('taste', { stance: 'taste' });
const Experience = H.memory('experience', { stance: 'experience' });

const ownerTaste = H.journal('owner-taste', Taste, jsonl.memory({ path: '/home/owner/.harness/taste.jsonl' }))
  .recall(tasteRecall)
  .recalledBy(builder, planner, writer)
  .recordedBy(H.operator);

const TicketData = z.object({ title: z.string(), body: z.string(), area: z.string(), parent: z.string().optional() });

const Bug = H.kind('Bug', {
  data: TicketData,
  states: { triage: 'pending', building: 'active', auditing: 'active', merged: 'succeeded', abandoned: 'failed', withdrawn: 'cancelled' },
  initial: 'triage',
  tags: (ticket) => [ticket.area],
});
const Feature = Bug.extend('Feature');
const Epic = H.kind('Epic', {
  data: z.object({ title: z.string(), body: z.string() }),
  states: { proposed: 'pending', planning: 'active', waitingOnFeatures: 'pending', delivered: 'succeeded', incomplete: 'failed', dropped: 'cancelled' },
  initial: 'proposed',
});
const Heartbeat = H.kind('ServiceHeartbeat', {
  data: z.object({ service: z.string(), url: z.string().url() }),
  states: { due: 'pending', probing: 'active', up: 'succeeded', down: 'failed', skipped: 'cancelled' },
  initial: 'due',
  tags: (beat) => [beat.service],
});

const builderModelFor = (kind: Kind<unknown, string>) =>
  H.policy.pick(`builder-model-${kind.name}`, [sonnet, opus], (ctx) => {
    const cheap = ctx.metrics.successRate({ kind, sinceDays: 14, seat: 'builder', model: sonnet });
    return cheap.samples >= 20 && cheap.value < 0.85 ? opus : sonnet;
  });

const appWorktree = git.worktree({ repo: '/home/owner/src/app', base: 'main' });
const fileLease = git.fileLease();
const projectChecks = H.command('project-checks', { argv: ['npm', 'run', 'check'], timeoutSeconds: 900 });

const ticketFlow = H.flow('ticket', { kinds: [Bug, Feature], args: z.object({ rounds: z.number().int().min(1) }) })
  .loop(
    'rounds',
    (args) => args.rounds,
    (round) =>
      round
        .mark('building')
        .step('build', (ctx) =>
          H.ask(builder, {
            prompt: `Round ${ctx.round}. ${ctx.unit.data.title}\n\n${ctx.unit.data.body}`,
            output: z.object({ summary: z.string(), files: z.array(z.string()) }),
            workspace: appWorktree,
            guards: [fileLease],
            beforeStop: projectChecks,
            resources: [ctx.unit.data.area],
          }),
        )
        .mark('auditing')
        .step('audit', (ctx) =>
          H.ask(auditor, {
            prompt: `Audit this change for "${ctx.unit.data.title}": ${ctx.out.build.summary}`,
            output: z.object({ deficits: z.array(z.string()) }),
            workspace: appWorktree,
            resources: [ctx.unit.data.area],
          }),
        ),
    (ctx) => ctx.out.audit.deficits.length === 0,
  )
  .end((ctx) => (ctx.out.rounds.satisfied ? 'merged' : 'abandoned'));

const ticketStatuses = {
  triage: 'Triage',
  building: 'In Progress',
  auditing: 'In Review',
  merged: 'Done',
  abandoned: 'Canceled',
  withdrawn: 'Duplicate',
};

const bugTracker = linear.issues(Bug, {
  team: 'APP',
  apiKey: H.env('LINEAR_API_KEY'),
  label: 'bug',
  statuses: ticketStatuses,
  map: (issue) => ({ title: issue.title, body: issue.description, area: issue.labels[0] ?? 'general', parent: issue.parentId }),
});
const featureTracker = linear.issues(Feature, {
  team: 'APP',
  apiKey: H.env('LINEAR_API_KEY'),
  label: 'feature',
  statuses: ticketStatuses,
  map: (issue) => ({ title: issue.title, body: issue.description, area: issue.labels[0] ?? 'general', parent: issue.parentId }),
});
const epicTracker = linear.issues(Epic, {
  team: 'APP',
  apiKey: H.env('LINEAR_API_KEY'),
  label: 'epic',
  statuses: { proposed: 'Backlog', planning: 'Planning', waitingOnFeatures: 'In Progress', delivered: 'Done', incomplete: 'Stalled', dropped: 'Canceled' },
  map: (issue) => ({ title: issue.title, body: issue.description }),
});

const appWorkstation = shell.local({ name: 'app-workstation', slots: 4 });

const bugLane = H.lane(Bug)
  .from(bugTracker, folder.markdown(Bug, { path: '/home/owner/src/app/inbox/bugs' }), H.operator)
  .store(bugTracker)
  .handle(ticketFlow, { rounds: 3 })
  .cast({ builder: builderModelFor(Bug), auditor: sonnet })
  .states({ building: 'building', auditing: 'auditing', merged: 'merged', abandoned: 'abandoned', failed: 'abandoned', cancelled: 'withdrawn' })
  .runOn(appWorkstation)
  .wip(2);

const featureLane = H.lane(Feature)
  .from(featureTracker, H.operator)
  .store(featureTracker)
  .handle(ticketFlow, { rounds: 5 })
  .cast({ builder: builderModelFor(Feature), auditor: sonnet })
  .states({ building: 'building', auditing: 'auditing', merged: 'merged', abandoned: 'abandoned', failed: 'abandoned', cancelled: 'withdrawn' })
  .runOn(appWorkstation);

const epicFlow = H.flow('epic', { kinds: [Epic] })
  .mark('planning')
  .step('plan', (ctx) =>
    H.ask(planner, {
      prompt: `${ctx.unit.data.title}\n\n${ctx.unit.data.body}`,
      output: z.object({ features: z.array(z.object({ title: z.string(), body: z.string(), area: z.string() })) }),
    }),
  )
  .mark('waitingOnFeatures')
  .spawn('features', featureLane, (ctx) =>
    ctx.out.plan.features.map((feature, index) => ({
      key: `${ctx.unit.key}-feature-${index + 1}`,
      data: { title: feature.title, body: feature.body, area: feature.area, parent: ctx.unit.key },
    })),
  )
  .end((ctx) => (ctx.out.features.every((child) => child.outcome === 'succeeded') ? 'delivered' : 'incomplete'));

const epicLane = H.lane(Epic)
  .from(epicTracker)
  .store(epicTracker)
  .handle(epicFlow)
  .cast({ planner: opus })
  .states({ planning: 'planning', waitingOnFeatures: 'waitingOnFeatures', delivered: 'delivered', incomplete: 'incomplete', failed: 'incomplete', cancelled: 'dropped' })
  .runOn(appWorkstation)
  .wip(1);

const services = [
  { service: 'api', url: 'https://api.example.com/health' },
  { service: 'web', url: 'https://www.example.com/health' },
];

const heartbeatLane = H.lane(Heartbeat)
  .from(H.every(Heartbeat, { minutes: 5 }, (tick) => services.map((s) => ({ key: `${s.service}@${tick.now.toISOString()}`, data: s }))))
  .handle(
    H.flow('heartbeat', { kinds: [Heartbeat] })
      .mark('probing')
      .step('probe', (ctx) => H.command('probe-service', { argv: ['curl', '--fail', '--silent', '--max-time', '10', ctx.unit.data.url] }))
      .end('up'),
  )
  .states({ probing: 'probing', up: 'up', failed: 'down', cancelled: 'skipped' })
  .runOn(shell.local({ name: 'app-probes', slots: 2 }));

const appExperience = H.journal('app-experience', Experience, jsonl.memory({ path: '/home/owner/src/app/.harness/experience.jsonl' }))
  .recall(experienceRecall)
  .recalledBy(builder, auditor)
  .recordedBy(auditor);

const outageFilesBug = H.trigger('heartbeat-down-files-bug', H.when.enters(Heartbeat, 'down'), (then) =>
  then.create(bugLane, (event) => ({
    key: `outage-${event.unit.data.service}-${event.at.toISOString()}`,
    data: { title: `${event.unit.data.service} heartbeat failed`, body: `Probe of ${event.unit.data.url} failed.`, area: event.unit.data.service },
  })),
);

const appProjections = H.trigger('projections', H.when.transition(), (then) => [
  then.run(markdown.board({ path: '/home/owner/src/app/BOARD.md' })),
  then.run(markdown.telemetry({ path: '/home/owner/src/app/TELEMETRY.md', sinceDays: 14 })),
]);

const kindPriority = [Heartbeat.name, Bug.name, Feature.name, Epic.name];
const rankOf = (unit: Pending) =>
  unit.kind === Feature.name && unit.waitingSeconds > 4 * 3600 ? 0.5 : kindPriority.indexOf(unit.kind);

const probeProduction = H.operation('probe-production', {
  input: z.object({ endpoint: z.string().url() }),
  run: (input) => H.command('probe-production', { argv: ['curl', '--fail', '--silent', input.endpoint] }),
});

export const appHarness = H.harness('app')
  .ledger(sqlite.ledger({ path: '/home/owner/src/app/.harness/ledger.sqlite', quotaPath: sharedQuotaPath }))
  .lanes(heartbeatLane, bugLane, featureLane, epicLane)
  .journals(ownerTaste, appExperience)
  .triggers(outageFilesBug, appProjections)
  .scheduler(
    H.policy.order('heartbeats-bugs-features-epics', (ctx) => ({
      order: [...ctx.pending].sort((a, b) => rankOf(a) - rankOf(b) || b.waitingSeconds - a.waitingSeconds),
    })),
  )
  .share(max1, 0.6)
  .share(max2, 0.6)
  .share(max3, 0.6)
  .operations(probeProduction)
  .clients(
    claudeCode.supervisor({
      name: 'app-supervisor',
      endpoint: H.slot.port(7401),
      grants: [
        H.op.readWork,
        H.op.writeWork,
        H.op.createWork,
        H.op.resolveBlocker,
        H.op.writeMemory,
        H.op.readTelemetry,
        H.op.setShares,
        probeProduction,
      ],
    }),
  );

const DocPage = H.kind('DocPage', {
  data: z.object({ title: z.string(), path: z.string(), body: z.string() }),
  states: { draft: 'pending', writing: 'active', checking: 'active', published: 'succeeded', brokenLinks: 'failed', archived: 'cancelled' },
  initial: 'draft',
});

const docsFolder = folder.markdown(DocPage, { path: '/home/owner/src/docs/content', stateField: 'status' });
const docsWorktree = git.worktree({ repo: '/home/owner/src/docs', base: 'main' });

const docFlow = H.flow('doc-page', { kinds: [DocPage] })
  .mark('writing')
  .step('write', (ctx) =>
    H.ask(writer, {
      prompt: `Revise ${ctx.unit.data.path}: ${ctx.unit.data.title}\n\n${ctx.unit.data.body}`,
      output: z.object({ summary: z.string() }),
      workspace: docsWorktree,
      guards: [fileLease],
      resources: [ctx.unit.data.path],
    }),
  )
  .mark('checking')
  .step('linkCheck', (ctx) => H.command('link-check', { argv: ['npx', 'markdown-link-check', ctx.unit.data.path], timeoutSeconds: 300 }))
  .end('published');

const docLane = H.lane(DocPage)
  .from(docsFolder)
  .store(docsFolder)
  .handle(docFlow)
  .cast({ writer: sonnet })
  .states({ writing: 'writing', checking: 'checking', published: 'published', failed: 'brokenLinks', cancelled: 'archived' })
  .runOn(shell.local({ name: 'docs-workstation', slots: 2 }));

const docsExperience = H.journal('docs-experience', Experience, jsonl.memory({ path: '/home/owner/src/docs/.harness/experience.jsonl' }))
  .recall(experienceRecall)
  .recalledBy(writer)
  .recordedBy(H.operator);

export const docsHarness = H.harness('docs')
  .ledger(sqlite.ledger({ path: '/home/owner/src/docs/.harness/ledger.sqlite', quotaPath: sharedQuotaPath }))
  .lanes(docLane)
  .journals(ownerTaste, docsExperience)
  .triggers(H.trigger('projections', H.when.transition(), (then) => then.run(markdown.board({ path: '/home/owner/src/docs/BOARD.md' }))))
  .scheduler(H.policy.order('oldest-first', (ctx) => ({ order: [...ctx.pending].sort((a, b) => b.waitingSeconds - a.waitingSeconds) })))
  .share(max1, 0.3)
  .share(max2, 0.3)
  .share(max3, 0.3)
  .clients(
    claudeCode.supervisor({
      name: 'docs-supervisor',
      endpoint: H.slot.port(7411),
      grants: [H.op.readWork, H.op.writeWork, H.op.createWork, H.op.resolveBlocker, H.op.writeMemory, H.op.readTelemetry, H.op.setShares],
    }),
  );

export const runningApp = appHarness.start();
export const runningDocs = docsHarness.start();
