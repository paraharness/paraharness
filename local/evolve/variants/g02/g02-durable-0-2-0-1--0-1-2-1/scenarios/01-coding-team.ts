import { z } from 'zod';
import { H, AccountState } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { linear } from 'harness-dsl/linear';
import { folder } from 'harness-dsl/folder';
import { git } from 'harness-dsl/git';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const Todo = H.state('todo', 'pending');
const NeedsOwner = H.state('needs-owner', 'waiting');
const Done = H.terminal('done', 'success');
const Abandoned = H.terminal('abandoned', 'failure');
const Cancelled = H.terminal('cancelled', 'neutral');

const Due = H.state('due', 'pending');
const Healthy = H.terminal('healthy', 'success');
const Unhealthy = H.terminal('unhealthy', 'failure');

const WorkAttrs = z.object({
  externalId: z.string(),
  title: z.string(),
  description: z.string(),
  origin: z.string(),
});

const Bug = H.kind('Bug')
  .attributes(WorkAttrs)
  .states(Todo, NeedsOwner, Done, Abandoned, Cancelled)
  .key(attrs => attrs.externalId)
  .initial(Todo);

const Feature = H.kind('Feature')
  .attributes(WorkAttrs.extend({ epicId: z.string().optional() }))
  .states(Todo, NeedsOwner, Done, Abandoned, Cancelled)
  .key(attrs => attrs.externalId)
  .initial(Todo);

const Epic = H.kind('Epic')
  .attributes(WorkAttrs)
  .states(Todo, NeedsOwner, Done, Abandoned, Cancelled)
  .key(attrs => attrs.externalId)
  .initial(Todo);

const ServiceHeartbeat = H.kind('ServiceHeartbeat')
  .attributes(z.object({ service: z.string() }))
  .states(Due, Healthy, Unhealthy)
  .key(attrs => attrs.service)
  .initial(Due);

const quota = sqlite.quota('claude-accounts', { path: '.harness/quota.sqlite' });
const max1 = claudeCode.subscription('max-1', { token: H.env('CLAUDE_MAX_1_TOKEN'), quota });
const max2 = claudeCode.subscription('max-2', { token: H.env('CLAUDE_MAX_2_TOKEN'), quota });
const max3 = claudeCode.subscription('max-3', { token: H.env('CLAUDE_MAX_3_TOKEN'), quota });
const apiAccount = anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });

const sonnet = claudeCode.model('sonnet', { id: 'claude-sonnet-4-5' });
const opus = claudeCode.model('opus', { id: 'claude-opus-4-1' });

const soonestExpiringFirst = H.policy.account('soonest-expiring-first', ctx => {
  const eligible = ctx.candidates.filter(
    account =>
      account.shareUsed < account.shareCap &&
      (account.cooldownUntil === undefined || account.cooldownUntil.getTime() <= ctx.now.getTime()),
  );
  return eligible.reduce<AccountState | undefined>(
    (soonest, account) =>
      soonest === undefined || account.windowResetsAt.getTime() < soonest.windowResetsAt.getTime() ? account : soonest,
    undefined,
  );
});

const claudePool = H.pool('claude-subscriptions')
  .accounts(max1, max2, max3)
  .share(max1, 0.5)
  .share(max2, 0.5)
  .share(max3, 0.5)
  .drain(soonestExpiringFirst)
  .fallback(apiAccount);

const cheaperUntilItSlips = H.policy.model('cheaper-until-it-slips', [sonnet, opus], ctx => {
  const cheap = ctx.metrics.attempts({ of: ctx.kind, seat: ctx.seat, model: sonnet, window: { lastDays: 14 } });
  return cheap.samples >= 20 && cheap.successRate < 0.85 ? opus : sonnet;
});

const builderRole = H.role('builder')
  .intents('read', 'edit', 'run', 'search', 'halt')
  .instructions('Implement the task in the worktree. Fix every listed deficit. Halt for the owner when a product decision is needed.');
const auditorRole = H.role('auditor')
  .intents('read', 'run', 'search', 'record')
  .instructions('List every deficit of the change against the task. Record forward-phrased lessons you would want next time.');
const plannerRole = H.role('planner')
  .intents('read', 'search')
  .instructions('Decompose the epic into independently shippable features.');

const localRunner = local.runner('local');
const projectChecks = H.command('project-checks').argv(['npm', 'run', 'check']);
const attemptWorktree = git
  .worktree('attempt-worktree', { repo: '.', base: 'main' })
  .leaseFiles()
  .exitCheck(projectChecks);

const ownerDecision = H.halt('owner-decision').decision(z.object({ answer: z.string() }));

const Deficits = z.object({ deficits: z.array(z.string()) });

const builder = H.seat('builder')
  .role(builderRole)
  .model(cheaperUntilItSlips)
  .pool(claudePool)
  .runner(attemptWorktree)
  .halts(ownerDecision)
  .output(z.object({ summary: z.string() }));

const auditor = H.seat('auditor')
  .role(auditorRole)
  .model(opus)
  .pool(claudePool)
  .runner(attemptWorktree)
  .output(Deficits);

const planner = H.seat('planner')
  .role(plannerRole)
  .model(opus)
  .pool(claudePool)
  .output(z.object({ features: z.array(z.object({ title: z.string(), description: z.string() })) }));

const buildAndAudit = H.flow('build-and-audit')
  .input(z.object({ externalId: z.string(), title: z.string(), description: z.string() }))
  .params(z.object({ rounds: z.number() }))
  .loop(
    'rounds',
    Deficits,
    round =>
      round
        .step('build', builder, ctx => ({
          task: [
            `${ctx.unit.attributes.title}\n\n${ctx.unit.attributes.description}`,
            ...ctx.steps.rounds.map(
              (earlier, index) => `Auditor deficits from round ${index + 1}:\n- ${earlier.deficits.join('\n- ')}`,
            ),
          ].join('\n\n'),
        }))
        .step('audit', auditor, ctx => ({
          task: `Audit the change for "${ctx.unit.attributes.title}". The builder reports: ${ctx.steps.build.summary}`,
        })),
    {
      max: ctx => ctx.params.rounds,
      until: ctx => ctx.steps.audit.deficits.length === 0,
      keep: ctx => ctx.steps.audit,
    },
  )
  .exit('clean', ctx => ctx.steps.audit.deficits.length === 0)
  .exit('roundsExhausted');

const tracker = { apiKey: H.env('LINEAR_API_KEY'), team: 'ENG' };
const trackerStore = linear.store({
  ...tracker,
  workflow: ['Todo', 'In Progress', 'In Review', 'Blocked', 'Done', 'Canceled'],
});

const bugs = H.lane('bugs', Bug)
  .supply(linear.issues({ ...tracker, labels: ['bug'] }), (issue, to) =>
    to.create({ externalId: issue.identifier, title: issue.title, description: issue.description, origin: 'tracker' }),
  )
  .supply(folder.files({ path: 'inbox/bugs', glob: '*.md' }), (file, to) =>
    to.create({ externalId: `file:${file.name}`, title: file.name, description: file.body, origin: 'folder' }),
  )
  .supply(H.operator)
  .handler(buildAndAudit, { exits: { clean: Done, roundsExhausted: NeedsOwner }, params: { rounds: 3 } })
  .store(trackerStore, {
    states: { todo: 'Todo', 'needs-owner': 'Blocked', done: 'Done', abandoned: 'Canceled', cancelled: 'Canceled' },
    inFlight: 'In Progress',
    steps: { audit: 'In Review' },
  })
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 600_000, exhausted: Abandoned })
  .on(H.cancel, { enter: Cancelled });

const features = H.lane('features', Feature)
  .supply(linear.issues({ ...tracker, labels: ['feature'] }), (issue, to) =>
    to.create({ externalId: issue.identifier, title: issue.title, description: issue.description, origin: 'tracker' }),
  )
  .supply(H.operator)
  .handler(buildAndAudit, { exits: { clean: Done, roundsExhausted: NeedsOwner }, params: { rounds: 5 } })
  .store(trackerStore, {
    states: { todo: 'Todo', 'needs-owner': 'Blocked', done: 'Done', abandoned: 'Canceled', cancelled: 'Canceled' },
    inFlight: 'In Progress',
    steps: { audit: 'In Review' },
  })
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 600_000, exhausted: Abandoned })
  .on(H.cancel, { enter: Cancelled });

const decomposeEpic = H.flow('decompose-epic')
  .input(z.object({ externalId: z.string(), title: z.string(), description: z.string() }))
  .step('plan', planner, ctx => ({
    task: `Decompose the epic "${ctx.unit.attributes.title}":\n\n${ctx.unit.attributes.description}`,
  }))
  .spawn('features', features, ctx =>
    ctx.steps.plan.features.map((feature, index) => ({
      externalId: `${ctx.unit.attributes.externalId}/${index + 1}`,
      title: feature.title,
      description: feature.description,
      origin: 'epic',
      epicId: ctx.unit.attributes.externalId,
    })),
  )
  .exit('delivered', ctx => ctx.steps.features.every(child => child.verdict === 'success'))
  .exit('incomplete');

const epics = H.lane('epics', Epic)
  .supply(linear.issues({ ...tracker, labels: ['epic'] }), (issue, to) =>
    to.create({ externalId: issue.identifier, title: issue.title, description: issue.description, origin: 'tracker' }),
  )
  .handler(decomposeEpic, { exits: { delivered: Done, incomplete: NeedsOwner } })
  .store(trackerStore, {
    states: { todo: 'Todo', 'needs-owner': 'Blocked', done: 'Done', abandoned: 'Canceled', cancelled: 'Canceled' },
    inFlight: 'In Progress',
  })
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 600_000, exhausted: Abandoned })
  .on(H.cancel, { enter: Cancelled });

const heartbeatProbe = H.command('heartbeat-probe')
  .input(z.object({ service: z.string() }))
  .argv(input => ['./ops/heartbeat.sh', input.service])
  .runner(localRunner);

const heartbeat = H.flow('heartbeat')
  .input(z.object({ service: z.string() }))
  .step('probe', heartbeatProbe, ctx => ({ service: ctx.unit.attributes.service }))
  .exit('healthy');

const heartbeats = H.lane('heartbeats', ServiceHeartbeat)
  .supply(H.clock('every-five-minutes').every({ minutes: 5 }), (_tick, to) => to.create({ service: 'api' }))
  .handler(heartbeat, { exits: { healthy: Healthy } })
  .retry({ maxAttempts: 1, exhausted: Unhealthy });

const failedHeartbeatFilesBug = H.trigger('failed-heartbeat-files-bug')
  .on(H.when.transition(heartbeats, { to: Unhealthy }))
  .create(bugs, event => ({
    externalId: `heartbeat:${event.unit.attributes.service}`,
    title: `Heartbeat failed for ${event.unit.attributes.service}`,
    description: `The ${event.unit.attributes.service} heartbeat failed at ${event.at.toISOString()}.`,
    origin: 'heartbeat',
  }));

const experience = H.journal('coding-experience', H.memory('experience', 'experience'))
  .store(jsonl.memoryStore({ path: '.harness/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 12 })
  .readBy(builderRole, auditorRole)
  .recordedBy(auditorRole);

const taste = H.journal('owner-taste', H.memory('taste', 'taste'))
  .store(jsonl.memoryStore({ path: '.harness/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 20 })
  .readBy(builderRole, plannerRole);

const scheduler = H.scheduler('coding-team')
  .expedite(heartbeats)
  .standard(bugs, features, epics)
  .wip(bugs, 2)
  .wip(epics, 1)
  .aging(features, { afterMinutes: 240 });

const productionHealth = H.operation(
  'production-health',
  H.command('production-health-probe').argv(['./ops/probe-production.sh']).runner(localRunner),
);

const supervisor = claudeCode.supervisor('supervisor', {
  port: H.slot.port(0),
  grants: [
    H.ops.workRead,
    H.ops.workCreate,
    H.ops.workUpdate,
    H.ops.workCancel,
    H.ops.resolve(ownerDecision),
    H.ops.attemptsRecover,
    H.ops.memoryRead,
    H.ops.memoryWrite,
    H.ops.telemetryRead,
    H.ops.accountsRead,
    H.ops.accountsShare,
    productionHealth,
  ],
});

export default H.harness('coding-team')
  .ledger(sqlite.ledger({ path: '.harness/ledger.sqlite' }))
  .lanes(heartbeats, bugs, features, epics)
  .journals(experience, taste)
  .triggers(failedHeartbeatFilesBug)
  .scheduler(scheduler)
  .clients(supervisor)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));
