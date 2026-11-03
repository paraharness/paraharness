import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { linear } from 'harness-dsl/linear';
import { folder } from 'harness-dsl/folder';
import { git } from 'harness-dsl/git';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const workItem = z.object({ ref: z.string(), title: z.string(), description: z.string() });
const featureItem = workItem.extend({ epic: z.string().optional() });

const Todo = H.state('Todo', 'pending');
const InProgress = H.state('InProgress', 'active');
const Done = H.terminal('Done', 'success');
const Abandoned = H.terminal('Abandoned', 'failure');
const Cancelled = H.terminal('Cancelled', 'neutral');

const Bug = H.kind('Bug')
  .attributes(workItem)
  .states(Todo, InProgress, Done, Abandoned, Cancelled)
  .key(a => a.ref);
const Feature = H.kind('Feature')
  .attributes(featureItem)
  .states(Todo, InProgress, Done, Abandoned, Cancelled)
  .key(a => a.ref);
const Epic = H.kind('Epic')
  .attributes(workItem)
  .states(Todo, InProgress, Done, Abandoned, Cancelled)
  .key(a => a.ref);

const Due = H.state('Due', 'pending');
const Probing = H.state('Probing', 'active');
const Healthy = H.terminal('Healthy', 'success');
const Unhealthy = H.terminal('Unhealthy', 'failure');

const ServiceHeartbeat = H.kind('ServiceHeartbeat')
  .attributes(z.object({ service: z.string(), dueAt: z.string() }))
  .states(Due, Probing, Healthy, Unhealthy)
  .key(a => `${a.service}@${a.dueAt}`);

type TrackerState = 'Todo' | 'In Progress' | 'Done' | 'Canceled';
const trackerWorkflow: readonly TrackerState[] = ['Todo', 'In Progress', 'Done', 'Canceled'];
const trackerStates: Record<'Todo' | 'InProgress' | 'Done' | 'Abandoned' | 'Cancelled', TrackerState> = {
  Todo: 'Todo',
  InProgress: 'In Progress',
  Done: 'Done',
  Abandoned: 'Canceled',
  Cancelled: 'Canceled',
};

const linearKey = H.env('LINEAR_API_KEY');
const tracker = linear.store({ apiKey: linearKey, team: 'ENG', workflow: trackerWorkflow });

const quota = sqlite.quota('claude-accounts', { path: '../shared/quota.sqlite' });
const sub1 = claudeCode.subscription('claude-sub-1', { token: H.env('CLAUDE_SUB_1_TOKEN'), quota });
const sub2 = claudeCode.subscription('claude-sub-2', { token: H.env('CLAUDE_SUB_2_TOKEN'), quota });
const sub3 = claudeCode.subscription('claude-sub-3', { token: H.env('CLAUDE_SUB_3_TOKEN'), quota });
const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });

const sonnet = claudeCode.model('sonnet', { id: 'claude-sonnet-4-5' });
const opus = claudeCode.model('opus', { id: 'claude-opus-4-1' });

const soonestExpiring = H.policy.account('soonest-expiring', ctx =>
  ctx.candidates
    .filter(a => (a.cooldownUntil === undefined || a.cooldownUntil <= ctx.now) && a.shareUsed < a.shareCap)
    .sort((a, b) => a.windowResetsAt.getTime() - b.windowResetsAt.getTime())[0],
);

const subscriptions = H.pool('claude-subscriptions')
  .accounts(sub1, sub2, sub3)
  .share(sub1, 0.8)
  .share(sub2, 0.6)
  .share(sub3, 0.6)
  .drain(soonestExpiring)
  .fallback(apiAccount);

const localRunner = local.runner('local');

const builderRole = H.role('builder')
  .intents('read', 'edit', 'run', 'search')
  .instructions('Implement the work item and keep the project checks green.');
const auditorRole = H.role('auditor')
  .intents('read', 'run', 'record')
  .instructions('List every deficit of the change against the work item; record lessons as experience.');
const plannerRole = H.role('planner')
  .intents('read', 'search')
  .instructions('Decompose the epic into independently shippable features.');

const experience = H.journal('experience', H.memory('experience', 'experience'))
  .store(jsonl.memoryStore({ path: '.harness/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 12 })
  .readBy(builderRole, auditorRole)
  .recordedBy(auditorRole);

const taste = H.journal('taste', H.memory('taste', 'taste'))
  .store(jsonl.memoryStore({ path: '.harness/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 20 })
  .readBy(builderRole, plannerRole);

const ownerDecision = H.halt('owner-decision').decision(z.object({ answer: z.string() }));

const projectChecks = H.command('project-checks').argv(['npm', 'run', 'check']).runner(localRunner);

const builderModel = H.policy.model('builder-model', [sonnet, opus], ctx => {
  const cheap = ctx.metrics.attempts({ of: ctx.kind, seat: ctx.seat, model: sonnet, window: { lastDays: 14 } });
  return cheap.samples >= 20 && cheap.successRate < 0.85 ? opus : sonnet;
});

const builder = H.seat('builder')
  .role(builderRole)
  .model(builderModel)
  .pool(subscriptions)
  .workspace(git.worktree({ repo: '.', base: 'main' }))
  .guard({ leaseFiles: true, beforeStop: projectChecks })
  .halts(ownerDecision);

const auditor = H.seat('auditor')
  .role(auditorRole)
  .model(sonnet)
  .pool(subscriptions)
  .output(z.object({ deficits: z.array(z.string()) }));

const planner = H.seat('planner')
  .role(plannerRole)
  .model(opus)
  .pool(subscriptions)
  .output(z.object({ features: z.array(z.object({ title: z.string(), description: z.string() })) }));

const buildAndAudit = H.flow('build-and-audit')
  .input(workItem)
  .params(z.object({ rounds: z.number() }))
  .loop(
    'rounds',
    f =>
      f
        .step(
          'build',
          builder,
          ctx => ({ task: `${ctx.unit.attributes.title}\n\n${ctx.unit.attributes.description}` }),
          { afterCrash: 'askDriver' },
        )
        .step('audit', auditor, ctx => ({
          task: `Audit the change for ${ctx.unit.attributes.title}. Builder report:\n${ctx.steps.build}`,
        })),
    { max: ctx => ctx.params.rounds, until: ctx => ctx.steps.audit.deficits.length === 0 },
  )
  .exit('clean', ctx => ctx.steps.audit.deficits.length === 0)
  .exit('roundsExhausted');

const heartbeatProbe = H.command('service-probe')
  .input(z.object({ service: z.string() }))
  .argv(i => ['./scripts/probe', i.service])
  .acceptExitCodes(0, 1)
  .runner(localRunner);

const heartbeatFlow = H.flow('service-heartbeat')
  .input(z.object({ service: z.string() }))
  .step('probe', heartbeatProbe, ctx => ({ service: ctx.unit.attributes.service }))
  .exit('healthy', ctx => ctx.steps.probe.exitCode === 0)
  .exit('unhealthy');

const bugs = H.lane('bugs', Bug)
  .supply(linear.issues({ apiKey: linearKey, team: 'ENG', labels: ['bug'] }), (issue, to) =>
    to.create({ ref: issue.identifier, title: issue.title, description: issue.description }),
  )
  .supply(folder.files({ path: 'inbox/bugs', glob: '*.md' }), (file, to) =>
    to.create({ ref: `file:${file.name}`, title: file.name, description: file.body }),
  )
  .supply(H.operator)
  .store(tracker, trackerStates)
  .handler(buildAndAudit, {
    params: { rounds: 3 },
    exits: { clean: Done, roundsExhausted: Abandoned },
    during: { build: InProgress, audit: InProgress },
  })
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 60_000, exhausted: Abandoned })
  .on(H.cancel, { enter: Cancelled });

const features = H.lane('features', Feature)
  .supply(linear.issues({ apiKey: linearKey, team: 'ENG', labels: ['feature'] }), (issue, to) =>
    to.create({ ref: issue.identifier, title: issue.title, description: issue.description }),
  )
  .supply(H.operator)
  .store(tracker, trackerStates)
  .handler(buildAndAudit, {
    params: { rounds: 5 },
    exits: { clean: Done, roundsExhausted: Abandoned },
    during: { build: InProgress, audit: InProgress },
  })
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 60_000, exhausted: Abandoned })
  .on(H.cancel, { enter: Cancelled });

const decomposeEpic = H.flow('decompose-epic')
  .input(workItem)
  .step('plan', planner, ctx => ({ task: `${ctx.unit.attributes.title}\n\n${ctx.unit.attributes.description}` }))
  .spawn('features', features, ctx =>
    ctx.steps.plan.features.map((f, i) => ({
      ref: `${ctx.unit.attributes.ref}-${i + 1}`,
      title: f.title,
      description: f.description,
      epic: ctx.unit.attributes.ref,
    })),
  )
  .exit('delivered', ctx => ctx.steps.features.every(c => c.verdict === 'success'))
  .exit('incomplete');

const epics = H.lane('epics', Epic)
  .supply(linear.issues({ apiKey: linearKey, team: 'ENG', labels: ['epic'] }), (issue, to) =>
    to.create({ ref: issue.identifier, title: issue.title, description: issue.description }),
  )
  .store(tracker, trackerStates)
  .handler(decomposeEpic, {
    exits: { delivered: Done, incomplete: Abandoned },
    during: { plan: InProgress },
  })
  .retry({ maxAttempts: 2, backoff: 'fixed', initialDelayMs: 300_000, exhausted: Abandoned })
  .on(H.cancel, { enter: Cancelled });

const heartbeats = H.lane('heartbeats', ServiceHeartbeat)
  .supply(H.clock('every-five-minutes').every({ minutes: 5 }), (tick, to) =>
    to.create({ service: 'api', dueAt: tick.at.toISOString() }),
  )
  .handler(heartbeatFlow, {
    exits: { healthy: Healthy, unhealthy: Unhealthy },
    during: { probe: Probing },
  })
  .retry({ maxAttempts: 1, backoff: 'fixed', initialDelayMs: 0, exhausted: Unhealthy });

const heartbeatFailureFilesBug = H.trigger('heartbeat-failure-files-bug')
  .on(H.when.transition(heartbeats, Unhealthy))
  .create(bugs, e => ({
    ref: `heartbeat:${e.unit.attributes.service}:${e.unit.attributes.dueAt}`,
    title: `Service ${e.unit.attributes.service} failed its heartbeat`,
    description: `The heartbeat due at ${e.unit.attributes.dueAt} reported the service unhealthy.`,
  }));

const scheduler = H.scheduler('coding-team')
  .priority(heartbeats, bugs, features, epics)
  .wip(bugs, 2)
  .wip(epics, 1)
  .boost(features, { afterMinutes: 120 });

const healthProbe = H.operation(
  'production-health-probe',
  H.command('production-health-probe').argv(['./scripts/prod-health']).runner(localRunner),
);

const supervisor = claudeCode.supervisor('owner').client('coding-supervisor', {
  grants: [
    H.ops.workRead,
    H.ops.workCreate,
    H.ops.signal(H.cancel),
    H.ops.resolve(ownerDecision),
    H.ops.memoryRead,
    H.ops.memoryWrite,
    H.ops.telemetryRead,
    H.ops.accountsRead,
    H.ops.accountsShare,
    healthProbe,
  ],
});

export const codingTeam = H.harness('coding-team')
  .ledger(sqlite.ledger({ path: '.harness/ledger.sqlite' }))
  .lanes(heartbeats, bugs, features, epics)
  .journals(experience, taste)
  .triggers(heartbeatFailureFilesBug)
  .scheduler(scheduler)
  .clients(supervisor)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));
