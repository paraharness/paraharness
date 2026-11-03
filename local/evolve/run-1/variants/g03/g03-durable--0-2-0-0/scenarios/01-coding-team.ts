import { H } from 'harness-dsl';
import { z } from 'zod';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { linear } from 'harness-dsl/linear';
import { folder } from 'harness-dsl/folder';
import { git } from 'harness-dsl/git';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const Queued = H.state('Queued', 'pending');
const Building = H.state('Building', 'active');
const Auditing = H.state('Auditing', 'active');
const Done = H.terminal('Done', 'success');
const Abandoned = H.terminal('Abandoned', 'failure');
const GaveUp = H.terminal('GaveUp', 'failure');

const Proposed = H.state('Proposed', 'pending');
const Planning = H.state('Planning', 'active');
const Decomposed = H.state('Decomposed', 'waiting');
const Completed = H.terminal('Completed', 'success');
const Incomplete = H.terminal('Incomplete', 'failure');

const Due = H.state('Due', 'pending');
const Checking = H.state('Checking', 'active');
const Healthy = H.terminal('Healthy', 'success');
const Unhealthy = H.terminal('Unhealthy', 'failure');

const ticketSchema = z.object({
  title: z.string(),
  description: z.string(),
  reference: z.string(),
});

const heartbeatSchema = z.object({
  service: z.string(),
  url: z.string(),
  at: z.string(),
});

const Bug = H.kind('Bug')
  .attributes(ticketSchema)
  .states(Queued, Building, Auditing, Done, Abandoned, GaveUp)
  .key(a => a.reference)
  .initial(Queued);

const Feature = H.kind('Feature')
  .attributes(ticketSchema)
  .states(Queued, Building, Auditing, Done, Abandoned, GaveUp)
  .key(a => a.reference)
  .initial(Queued);

const Epic = H.kind('Epic')
  .attributes(ticketSchema)
  .states(Proposed, Planning, Decomposed, Completed, Incomplete)
  .key(a => a.reference)
  .initial(Proposed);

const ServiceHeartbeat = H.kind('ServiceHeartbeat')
  .attributes(heartbeatSchema)
  .states(Due, Checking, Healthy, Unhealthy)
  .key(a => `${a.service}@${a.at}`)
  .initial(Due)
  .onAttemptFailed(Unhealthy);

const subscriptionA = claudeCode.subscription('claude-a', { token: H.env('CLAUDE_TOKEN_A') });
const subscriptionB = claudeCode.subscription('claude-b', { token: H.env('CLAUDE_TOKEN_B') });
const subscriptionC = claudeCode.subscription('claude-c', { token: H.env('CLAUDE_TOKEN_C') });
const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });

const sonnet = claudeCode.model('sonnet', { id: 'claude-sonnet-4-5' });
const opus = claudeCode.model('opus', { id: 'claude-opus-4-1' });

const soonestExpiring = H.policy.account('soonestExpiring', ctx =>
  [...ctx.candidates]
    .filter(c => c.shareUsed < c.shareCap)
    .filter(c => c.cooldownUntil === undefined || c.cooldownUntil.getTime() <= ctx.now.getTime())
    .sort((a, b) => a.windowResetsAt.getTime() - b.windowResetsAt.getTime())[0],
);

const subscriptions = H.pool('subscriptions')
  .accounts(subscriptionA, subscriptionB, subscriptionC)
  .share(subscriptionA, 0.5)
  .share(subscriptionB, 0.3)
  .share(subscriptionC, 0.2)
  .drain(soonestExpiring)
  .fallback(apiAccount);

const builderModel = H.policy.model('builderModel', [sonnet, opus], ctx => {
  const cheap = ctx.metrics.attempts({ of: ctx.kind, model: sonnet, window: { lastDays: 14 } });
  return cheap.samples >= 20 && cheap.successRate < 0.85 ? opus : sonnet;
});

const repoRunner = local.runner('repo');

const projectChecks = H.command('projectChecks')
  .argv(['npm', 'run', 'check'])
  .runner(repoRunner);

const builderRole = H.role('builder')
  .intents('read', 'edit', 'run', 'search', 'halt')
  .instructions('Implement the work item. Halt when a decision belongs to the owner.');

const auditorRole = H.role('auditor')
  .intents('read', 'run', 'search', 'record')
  .instructions('Find deficits in the change. Record forward-phrased lessons worth keeping.');

const plannerRole = H.role('planner')
  .intents('read', 'search')
  .instructions('Decompose the epic into independently shippable features.');

const builder = H.agent('builder')
  .role(builderRole)
  .model(builderModel)
  .pool(subscriptions)
  .workspace(git.worktree({ repo: '.', base: 'main' }))
  .guards(H.guard.lease(), H.guard.beforeStop(projectChecks));

const auditor = H.agent('auditor')
  .role(auditorRole)
  .model(opus)
  .pool(subscriptions)
  .output(z.object({ deficits: z.array(z.string()) }));

const planner = H.agent('planner')
  .role(plannerRole)
  .model(opus)
  .pool(subscriptions)
  .output(z.object({
    features: z.array(z.object({ title: z.string(), description: z.string() })),
  }));

const experienceKind = H.memory('experience', 'experience');
const tasteKind = H.memory('taste', 'taste');

const experience = H.journal('experience', experienceKind)
  .store(jsonl.memoryStore({ path: '.harness/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 12 })
  .readBy(builderRole, auditorRole)
  .recordedBy(auditorRole);

const taste = H.journal('taste', tasteKind)
  .store(jsonl.memoryStore({ path: '.harness/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 12 })
  .readBy(builderRole, plannerRole);

const ticketFlow = H.flow('buildAndAudit')
  .input(ticketSchema)
  .params(z.object({ rounds: z.number() }))
  .loop(
    'rounds',
    f => f
      .step('build', builder, ctx => ({
        task: `${ctx.unit.attributes.title}\n\n${ctx.unit.attributes.description}`,
      }))
      .step('audit', auditor, ctx => ({
        task: `Audit the change for ${ctx.unit.attributes.title}. Builder notes:\n${ctx.steps.build}`,
      })),
    {
      max: ctx => ctx.params.rounds,
      until: ctx => ctx.steps.audit.deficits.length === 0,
    },
  )
  .exit('clean', ctx => ctx.steps.audit.deficits.length === 0)
  .exit('roundsExhausted');

const healthProbe = H.command('healthProbe')
  .input(z.object({ url: z.string() }))
  .argv(i => ['curl', '-fsS', '--max-time', '10', i.url])
  .runner(repoRunner);

const heartbeatFlow = H.flow('serviceHeartbeat')
  .input(heartbeatSchema)
  .step('probe', healthProbe, ctx => ({ url: ctx.unit.attributes.url }))
  .exit('healthy');

const tracker = linear.store({ apiKey: H.env('LINEAR_API_KEY'), team: 'PROD' });

const ticketStates = {
  Queued: 'Todo',
  Building: 'In Progress',
  Auditing: 'In Review',
  Done: 'Done',
  Abandoned: 'Canceled',
  GaveUp: 'Canceled',
};

const ticketRetry = { maxAttempts: 3, initialDelayMs: 600000, exhausted: GaveUp };

const bugs = H.lane('bugs', Bug)
  .supply(
    linear.issues({ apiKey: H.env('LINEAR_API_KEY'), team: 'PROD', labels: ['bug'] }),
    (issue, to) => to.create({ title: issue.title, description: issue.description, reference: issue.identifier }),
  )
  .supply(
    folder.files({ path: 'bugs', glob: '*.md' }),
    (file, to) => to.create({ title: file.name, description: file.body, reference: file.path }),
  )
  .supply(H.operator)
  .store(tracker, ticketStates)
  .handler(ticketFlow, {
    params: { rounds: 3 },
    exits: { clean: Done, roundsExhausted: Abandoned },
    during: { build: Building, audit: Auditing },
  })
  .retry(ticketRetry);

const features = H.lane('features', Feature)
  .supply(
    linear.issues({ apiKey: H.env('LINEAR_API_KEY'), team: 'PROD', labels: ['feature'] }),
    (issue, to) => to.create({ title: issue.title, description: issue.description, reference: issue.identifier }),
  )
  .supply(H.operator)
  .store(tracker, ticketStates)
  .handler(ticketFlow, {
    params: { rounds: 5 },
    exits: { clean: Done, roundsExhausted: Abandoned },
    during: { build: Building, audit: Auditing },
  })
  .retry(ticketRetry);

const epicFlow = H.flow('decomposeEpic')
  .input(ticketSchema)
  .step('plan', planner, ctx => ({
    task: `Decompose this epic into features.\n\n${ctx.unit.attributes.title}\n\n${ctx.unit.attributes.description}`,
  }))
  .spawn('decompose', features, ctx => ctx.steps.plan.features.map(f => ({
    title: f.title,
    description: f.description,
    reference: `${ctx.unit.attributes.reference}/${f.title}`,
  })))
  .exit('complete', ctx => ctx.steps.decompose.every(child => child.verdict === 'success'))
  .exit('incomplete');

const epics = H.lane('epics', Epic)
  .supply(
    linear.issues({ apiKey: H.env('LINEAR_API_KEY'), team: 'PROD', labels: ['epic'] }),
    (issue, to) => to.create({ title: issue.title, description: issue.description, reference: issue.identifier }),
  )
  .store(tracker, {
    Proposed: 'Todo',
    Planning: 'In Progress',
    Decomposed: 'In Progress',
    Completed: 'Done',
    Incomplete: 'Canceled',
  })
  .handler(epicFlow, {
    exits: { complete: Completed, incomplete: Incomplete },
    during: { plan: Planning, decompose: Decomposed },
  })
  .retry({ maxAttempts: 2, initialDelayMs: 1800000, exhausted: Incomplete });

const services = [
  { service: 'api', url: 'https://api.example.com/health' },
  { service: 'web', url: 'https://www.example.com/health' },
];

const heartbeats = H.lane('heartbeats', ServiceHeartbeat)
  .supply(
    H.clock('everyFiveMinutes').every({ minutes: 5 }),
    (tick, to) => services.map(s => to.create({ service: s.service, url: s.url, at: tick.at.toISOString() })),
  )
  .handler(heartbeatFlow, {
    exits: { healthy: Healthy },
    during: { probe: Checking },
  });

const failedHeartbeatFilesBug = H.trigger('failedHeartbeatFilesBug')
  .on(H.when.transition(heartbeats, { to: Unhealthy }))
  .create(bugs, e => ({
    title: `Service ${e.unit.attributes.service} failed its heartbeat`,
    description: `The health probe of ${e.unit.attributes.url} failed at ${e.unit.attributes.at}.`,
    reference: `heartbeat/${e.unit.attributes.service}`,
  }));

const scheduler = H.scheduler('codingTeam')
  .priority(heartbeats, bugs, features, epics)
  .wip(bugs, 2)
  .wip(epics, 1)
  .boost(features, { afterMinutes: 240 });

const productionHealth = H.operation(
  'productionHealth',
  H.command('productionHealthProbe')
    .argv(['curl', '-fsS', 'https://api.example.com/health/deep'])
    .runner(repoRunner),
);

const supervisor = claudeCode.supervisor('supervisor', {
  grants: [
    H.ops.workRead,
    H.ops.workCreate,
    H.ops.workUpdate,
    H.ops.workCancel,
    H.ops.blockersResolve,
    H.ops.memoryWrite,
    H.ops.telemetryRead,
    H.ops.accountsRead,
    H.ops.accountsShare,
    productionHealth,
  ],
});

export const codingTeam = H.harness('codingTeam')
  .ledger(sqlite.ledger({ path: '.harness/ledger.db' }))
  .lanes(heartbeats, bugs, features, epics)
  .journals(experience, taste)
  .triggers(failedHeartbeatFilesBug)
  .scheduler(scheduler)
  .clients(supervisor)
  .observers(
    markdown.board({ path: '.harness/board.md' }),
    markdown.telemetry({ path: '.harness/telemetry.md' }),
  );

void codingTeam.start();
