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

const TicketData = z.object({
  title: z.string(),
  body: z.string(),
  area: z.string(),
  parent: z.string().optional(),
});

const Bug = H.kind('Bug', {
  data: TicketData,
  states: {
    triage: 'pending',
    building: 'active',
    auditing: 'active',
    merged: 'succeeded',
    abandoned: 'failed',
    withdrawn: 'cancelled',
  },
  initial: 'triage',
  tags: (ticket) => [ticket.area],
});

const Feature = Bug.extend('Feature');

const Epic = H.kind('Epic', {
  data: z.object({ title: z.string(), body: z.string() }),
  states: {
    proposed: 'pending',
    planning: 'active',
    waitingOnFeatures: 'pending',
    delivered: 'succeeded',
    incomplete: 'failed',
    dropped: 'cancelled',
  },
  initial: 'proposed',
});

const Heartbeat = H.kind('ServiceHeartbeat', {
  data: z.object({ service: z.string(), url: z.string().url() }),
  states: { due: 'pending', probing: 'active', up: 'succeeded', down: 'failed', skipped: 'cancelled' },
  initial: 'due',
  tags: (beat) => [beat.service],
});

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

const sonnet = claudeCode.model({
  name: 'sonnet',
  id: 'claude-sonnet-4-5',
  accounts: claudePool,
  price: { inputUsdPerMTok: 3, outputUsdPerMTok: 15 },
});
const opus = claudeCode.model({
  name: 'opus',
  id: 'claude-opus-4-1',
  accounts: claudePool,
  price: { inputUsdPerMTok: 15, outputUsdPerMTok: 75 },
});

const builderModelFor = (kind: Kind<unknown, string>) =>
  H.policy.pick(`builder-model-${kind.name}`, [sonnet, opus], (ctx) => {
    const cheap = ctx.metrics.successRate({ kind, sinceDays: 14, seat: 'builder', model: sonnet });
    return cheap.samples >= 20 && cheap.value < 0.85 ? opus : sonnet;
  });

const builder = H.role('builder', {
  instructions: 'Implement the ticket in the worktree. Halt for the owner when a product decision is needed.',
  intents: ['read', 'write', 'execute', 'halt'],
});
const auditor = H.role('auditor', {
  instructions: 'Audit the change against the ticket. List every deficit. Record lessons other builders need.',
  intents: ['read', 'execute', 'record'],
});
const planner = H.role('planner', {
  instructions: 'Decompose the epic into independently shippable features.',
  intents: ['read'],
});

const projectChecks = H.command('project-checks', { argv: ['npm', 'run', 'check'], timeoutSeconds: 900 });
const worktree = git.worktree({ repo: '.', base: 'main' });
const fileLease = git.fileLease();

const BuildReport = z.object({ summary: z.string(), files: z.array(z.string()) });
const AuditReport = z.object({ deficits: z.array(z.string()) });

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
            output: BuildReport,
            workspace: worktree,
            guards: [fileLease],
            beforeStop: projectChecks,
            resources: [ctx.unit.data.area],
          }),
        )
        .mark('auditing')
        .step('audit', (ctx) =>
          H.ask(auditor, {
            prompt: `Audit this change for "${ctx.unit.data.title}": ${ctx.out.build.summary}\nFiles: ${ctx.out.build.files.join(', ')}`,
            output: AuditReport,
            workspace: worktree,
            resources: [ctx.unit.data.area],
          }),
        ),
    (ctx) => ctx.out.audit.deficits.length === 0,
  )
  .end((ctx) => (ctx.out.rounds.satisfied ? 'merged' : 'abandoned'));

const FeaturePlan = z.object({
  features: z.array(z.object({ title: z.string(), body: z.string(), area: z.string() })),
});

const ticketStatuses = {
  triage: 'Triage',
  building: 'In Progress',
  auditing: 'In Review',
  merged: 'Done',
  abandoned: 'Canceled',
  withdrawn: 'Duplicate',
};

const bugTracker = linear.issues(Bug, {
  team: 'ENG',
  apiKey: H.env('LINEAR_API_KEY'),
  label: 'bug',
  statuses: ticketStatuses,
  map: (issue) => ({ title: issue.title, body: issue.description, area: issue.labels[0] ?? 'general', parent: issue.parentId }),
});
const featureTracker = linear.issues(Feature, {
  team: 'ENG',
  apiKey: H.env('LINEAR_API_KEY'),
  label: 'feature',
  statuses: ticketStatuses,
  map: (issue) => ({ title: issue.title, body: issue.description, area: issue.labels[0] ?? 'general', parent: issue.parentId }),
});
const epicTracker = linear.issues(Epic, {
  team: 'ENG',
  apiKey: H.env('LINEAR_API_KEY'),
  label: 'epic',
  statuses: {
    proposed: 'Backlog',
    planning: 'Planning',
    waitingOnFeatures: 'In Progress',
    delivered: 'Done',
    incomplete: 'Stalled',
    dropped: 'Canceled',
  },
  map: (issue) => ({ title: issue.title, body: issue.description }),
});

const workstation = shell.local({ name: 'workstation', slots: 4 });

const bugLane = H.lane(Bug)
  .from(bugTracker, folder.markdown(Bug, { path: 'inbox/bugs' }), H.operator)
  .store(bugTracker)
  .handle(ticketFlow, { rounds: 3 })
  .cast({ builder: builderModelFor(Bug), auditor: sonnet })
  .states({ building: 'building', auditing: 'auditing', merged: 'merged', abandoned: 'abandoned', failed: 'abandoned', cancelled: 'withdrawn' })
  .runOn(workstation)
  .wip(2);

const featureLane = H.lane(Feature)
  .from(featureTracker, H.operator)
  .store(featureTracker)
  .handle(ticketFlow, { rounds: 5 })
  .cast({ builder: builderModelFor(Feature), auditor: sonnet })
  .states({ building: 'building', auditing: 'auditing', merged: 'merged', abandoned: 'abandoned', failed: 'abandoned', cancelled: 'withdrawn' })
  .runOn(workstation);

const epicFlow = H.flow('epic', { kinds: [Epic] })
  .mark('planning')
  .step('plan', (ctx) => H.ask(planner, { prompt: `${ctx.unit.data.title}\n\n${ctx.unit.data.body}`, output: FeaturePlan }))
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
  .runOn(workstation)
  .wip(1);

const services = [
  { service: 'api', url: 'https://api.example.com/health' },
  { service: 'web', url: 'https://www.example.com/health' },
  { service: 'worker', url: 'https://worker.example.com/health' },
];

const heartbeatFlow = H.flow('heartbeat', { kinds: [Heartbeat] })
  .mark('probing')
  .step('probe', (ctx) =>
    H.command('probe-service', { argv: ['curl', '--fail', '--silent', '--max-time', '10', ctx.unit.data.url], timeoutSeconds: 15 }),
  )
  .end('up');

const heartbeatLane = H.lane(Heartbeat)
  .from(H.every(Heartbeat, { minutes: 5 }, (tick) => services.map((s) => ({ key: `${s.service}@${tick.now.toISOString()}`, data: s }))))
  .handle(heartbeatFlow)
  .states({ probing: 'probing', up: 'up', failed: 'down', cancelled: 'skipped' })
  .runOn(shell.local({ name: 'probes', slots: 3 }));

const within = (allowed: readonly string[] | undefined, present: readonly string[]) =>
  allowed === undefined || allowed.length === 0 || allowed.some((entry) => present.includes(entry));

const applies = (item: MemoryItem, ctx: RecallContext) =>
  item.status === 'active' &&
  within(item.when.kinds, [ctx.scope.kind]) &&
  within(item.when.roles, [ctx.scope.role]) &&
  within(item.when.tags, ctx.scope.tags) &&
  within(item.when.resources, ctx.scope.resources) &&
  within(item.when.skills, ctx.scope.skills);

const provenness = (ctx: RecallContext, item: MemoryItem) => {
  const record = ctx.trackRecord(item);
  return record.samples >= 5 ? record.value : 0.5;
};

const experienceRecall = H.policy.recall('experience-specific-then-proven', async (ctx) =>
  (await ctx.items())
    .filter((item) => applies(item, ctx))
    .sort((a, b) => ctx.specificity(b) - ctx.specificity(a) || provenness(ctx, b) - provenness(ctx, a))
    .slice(0, ctx.limit),
);

const tasteRecall = H.policy.recall('taste-most-specific', async (ctx) =>
  (await ctx.items())
    .filter((item) => applies(item, ctx))
    .sort((a, b) => ctx.specificity(b) - ctx.specificity(a))
    .slice(0, ctx.limit),
);

const Experience = H.memory('experience', { stance: 'experience' });
const Taste = H.memory('taste', { stance: 'taste' });

const experienceJournal = H.journal('coding-experience', Experience, jsonl.memory({ path: '.harness/experience.jsonl' }))
  .recall(experienceRecall)
  .recalledBy(builder, auditor)
  .recordedBy(auditor);

const tasteJournal = H.journal('owner-taste', Taste, jsonl.memory({ path: '.harness/taste.jsonl' }))
  .recall(tasteRecall)
  .recalledBy(builder, planner)
  .recordedBy(H.operator);

const outageFilesBug = H.trigger('heartbeat-down-files-bug', H.when.enters(Heartbeat, 'down'), (then) =>
  then.create(bugLane, (event) => ({
    key: `outage-${event.unit.data.service}-${event.at.toISOString()}`,
    data: {
      title: `${event.unit.data.service} heartbeat failed`,
      body: `The heartbeat probe of ${event.unit.data.url} failed at ${event.at.toISOString()}.`,
      area: event.unit.data.service,
    },
  })),
);

const projections = H.trigger('projections', H.when.transition(), (then) => [
  then.run(markdown.board({ path: 'BOARD.md' })),
  then.run(markdown.telemetry({ path: 'TELEMETRY.md', sinceDays: 14 })),
]);

const kindPriority = [Heartbeat.name, Bug.name, Feature.name, Epic.name];
const featureStarvationSeconds = 4 * 3600;

const rankOf = (unit: Pending) =>
  unit.kind === Feature.name && unit.waitingSeconds > featureStarvationSeconds ? 0.5 : kindPriority.indexOf(unit.kind);

const codingOrder = H.policy.order('heartbeats-bugs-features-epics', (ctx) => ({
  order: [...ctx.pending].sort((a, b) => rankOf(a) - rankOf(b) || b.waitingSeconds - a.waitingSeconds),
}));

const probeProduction = H.operation('probe-production', {
  input: z.object({ endpoint: z.string().url() }),
  run: (input) => H.command('probe-production', { argv: ['curl', '--fail', '--silent', '--max-time', '20', input.endpoint] }),
});

const supervisor = claudeCode.supervisor({
  name: 'coding-supervisor',
  endpoint: H.slot.port(7401),
  grants: [
    H.op.readWork,
    H.op.writeWork,
    H.op.createWork,
    H.op.cancelWork,
    H.op.resolveBlocker,
    H.op.writeMemory,
    H.op.readTelemetry,
    H.op.setShares,
    probeProduction,
  ],
});

export const codingTeam = H.harness('coding-team')
  .ledger(sqlite.ledger({ path: '.harness/ledger.sqlite' }))
  .lanes(heartbeatLane, bugLane, featureLane, epicLane)
  .journals(experienceJournal, tasteJournal)
  .triggers(outageFilesBug, projections)
  .scheduler(codingOrder)
  .share(max1, 0.5)
  .share(max2, 0.4)
  .share(max3, 0.3)
  .operations(probeProduction)
  .clients(supervisor);

export const running = codingTeam.start();
