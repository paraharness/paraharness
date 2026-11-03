import { z } from 'zod';
import { H } from 'harness-dsl';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { linear, LinearIssue } from 'harness-dsl/linear';
import { folder } from 'harness-dsl/folder';
import { git } from 'harness-dsl/git';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const issue = z.object({ ref: z.string(), title: z.string(), body: z.string() });
const heartbeatAttrs = z.object({ service: z.string(), at: z.string() });

const todo = H.state('Todo', 'pending');
const inProgress = H.state('InProgress', 'active');
const delivering = H.state('Delivering', 'waiting');
const done = H.terminal('Done', 'success');
const unresolved = H.terminal('Unresolved', 'failure');
const cancelled = H.terminal('Cancelled', 'neutral');

const due = H.state('Due', 'pending');
const probing = H.state('Probing', 'active');
const healthy = H.terminal('Healthy', 'success');
const down = H.terminal('Down', 'failure');

const bug = H.kind('Bug')
  .attributes(issue)
  .states(todo, inProgress, done, unresolved, cancelled)
  .key(a => a.ref)
  .initial(todo);

const feature = H.kind('Feature')
  .attributes(issue)
  .states(todo, inProgress, done, unresolved, cancelled)
  .key(a => a.ref)
  .initial(todo);

const epic = H.kind('Epic')
  .attributes(issue)
  .states(todo, inProgress, delivering, done, unresolved, cancelled)
  .key(a => a.ref)
  .initial(todo);

const heartbeat = H.kind('ServiceHeartbeat')
  .attributes(heartbeatAttrs)
  .states(due, probing, healthy, down)
  .key(a => `${a.service}@${a.at}`)
  .initial(due);

const builderRole = H.role('builder')
  .intents('read', 'edit', 'run', 'search')
  .instructions('Implement the work item in the worktree. Halt for an owner decision when the requirement is ambiguous.');
const auditorRole = H.role('auditor')
  .intents('read', 'run', 'record')
  .instructions('Find deficits in the change. Record forward-phrased experience when a lesson generalises.');
const plannerRole = H.role('planner')
  .intents('read', 'search')
  .instructions('Decompose the epic into independently deliverable features.');

const ownerDecision = H.halt('owner-decision').decision(z.object({ answer: z.string() }));

const quota = sqlite.quota('claude-subscriptions', { path: '~/.harness/quota.db' });
const subscriptionA = claudeCode.subscription('claude-max-a', { token: H.env('CLAUDE_TOKEN_A'), quota });
const subscriptionB = claudeCode.subscription('claude-max-b', { token: H.env('CLAUDE_TOKEN_B'), quota });
const subscriptionC = claudeCode.subscription('claude-max-c', { token: H.env('CLAUDE_TOKEN_C'), quota });
const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });

const soonestExpiring = H.policy.account('soonest-expiring-first', ctx => {
  const eligible = ctx.candidates.filter(
    c => c.shareUsed < c.shareCap && (c.cooldownUntil === undefined || c.cooldownUntil <= ctx.now),
  );
  return [...eligible].sort((a, b) => a.windowResetsAt.getTime() - b.windowResetsAt.getTime())[0];
});

const subscriptions = H.pool('claude-subscriptions')
  .accounts(subscriptionA, subscriptionB, subscriptionC)
  .share(subscriptionA, 0.5)
  .share(subscriptionB, 0.5)
  .share(subscriptionC, 0.3)
  .drain(soonestExpiring)
  .fallback(apiAccount);

const sonnet = claudeCode.model('sonnet', { id: 'claude-sonnet-4-5' });
const opus = claudeCode.model('opus', { id: 'claude-opus-4-1' });

const builderModel = H.policy.model('cheaper-until-below-0.85', [sonnet, opus], ctx => {
  const cheap = ctx.metrics.attempts({ of: ctx.kind, seat: ctx.seat, model: sonnet, window: { lastDays: 14 } });
  return cheap.samples >= 20 && cheap.successRate < 0.85 ? opus : sonnet;
});

const experience = H.memory('experience', 'experience');
const taste = H.memory('taste', 'taste');

const lessons = H.journal('engineering-lessons', experience)
  .store(jsonl.memoryStore({ path: 'memory/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 8 })
  .readBy(builderRole, auditorRole)
  .recordedBy(auditorRole);

const preferences = H.journal('owner-taste', taste)
  .store(jsonl.memoryStore({ path: 'memory/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 12 })
  .readBy(builderRole, plannerRole);

const localRunner = local.runner('local');

const projectChecks = H.command('project-checks').argv(['npm', 'run', 'check']).runner(localRunner);

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
  .output(z.object({ features: z.array(z.object({ title: z.string(), body: z.string() })) }));

const buildAndAudit = H.flow('build-and-audit')
  .input(issue)
  .params(z.object({ rounds: z.number() }))
  .loop(
    'rounds',
    f =>
      f
        .step('build', builder, ctx => ({
          task: `Implement ${ctx.unit.attributes.title}\n\n${ctx.unit.attributes.body}`,
          skills: ['implement'],
        }))
        .step('audit', auditor, ctx => ({
          task: `Audit the change for ${ctx.unit.attributes.title}. The builder reported:\n${ctx.steps.build}`,
          skills: ['audit'],
        })),
    {
      max: ctx => ctx.params.rounds,
      until: ctx => ctx.steps.audit.deficits.length === 0,
    },
  )
  .exit('clean', ctx => ctx.steps.audit.deficits.length === 0)
  .exit('deficient');

const tracker = linear.store({
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'ENG',
  workflow: ['Todo', 'In Progress', 'In Review', 'Done', 'Blocked', 'Canceled'],
});

const fromIssue = (i: LinearIssue) => ({ ref: i.identifier, title: i.title, body: i.description });

const bugs = H.lane('bugs', bug)
  .supply(linear.issues({ apiKey: H.env('LINEAR_API_KEY'), team: 'ENG', labels: ['bug'] }), (i, to) => to.create(fromIssue(i)))
  .supply(folder.files({ path: 'bugs', glob: '*.md' }), (f, to) => to.create({ ref: `file:${f.path}`, title: f.name, body: f.body }))
  .supply(H.operator)
  .store(tracker, { Todo: 'Todo', InProgress: 'In Progress', Done: 'Done', Unresolved: 'Blocked', Cancelled: 'Canceled' })
  .handler(buildAndAudit, {
    params: { rounds: 3 },
    exits: { clean: done, deficient: unresolved },
    during: { build: inProgress, audit: inProgress },
  })
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 60000, exhausted: unresolved })
  .on(H.cancel, { enter: cancelled });

const features = H.lane('features', feature)
  .supply(linear.issues({ apiKey: H.env('LINEAR_API_KEY'), team: 'ENG', labels: ['feature'] }), (i, to) => to.create(fromIssue(i)))
  .supply(H.operator)
  .store(tracker, { Todo: 'Todo', InProgress: 'In Progress', Done: 'Done', Unresolved: 'Blocked', Cancelled: 'Canceled' })
  .handler(buildAndAudit, {
    params: { rounds: 5 },
    exits: { clean: done, deficient: unresolved },
    during: { build: inProgress, audit: inProgress },
  })
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 60000, exhausted: unresolved })
  .on(H.cancel, { enter: cancelled });

const decomposeEpic = H.flow('decompose-epic')
  .input(issue)
  .step('plan', planner, ctx => ({
    task: `Decompose the epic ${ctx.unit.attributes.title} into features\n\n${ctx.unit.attributes.body}`,
    skills: ['plan'],
  }))
  .spawn('features', features, ctx =>
    ctx.steps.plan.features.map((f, i) => ({ ref: `${ctx.unit.key}/feature-${i + 1}`, title: f.title, body: f.body })),
  )
  .exit('completed', ctx => ctx.steps.features.every(c => c.verdict === 'success'))
  .exit('incomplete');

const epics = H.lane('epics', epic)
  .supply(linear.issues({ apiKey: H.env('LINEAR_API_KEY'), team: 'ENG', labels: ['epic'] }), (i, to) => to.create(fromIssue(i)))
  .store(tracker, {
    Todo: 'Todo',
    InProgress: 'In Progress',
    Delivering: 'In Review',
    Done: 'Done',
    Unresolved: 'Blocked',
    Cancelled: 'Canceled',
  })
  .handler(decomposeEpic, {
    exits: { completed: done, incomplete: unresolved },
    during: { plan: inProgress, features: delivering },
  })
  .retry({ maxAttempts: 2, backoff: 'fixed', initialDelayMs: 300000, exhausted: unresolved })
  .on(H.cancel, { enter: cancelled });

const probeService = H.command('probe-service')
  .input(heartbeatAttrs)
  .argv(i => ['./scripts/heartbeat.sh', i.service])
  .runner(localRunner)
  .acceptExitCodes(0, 1);

const heartbeatFlow = H.flow('service-heartbeat')
  .input(heartbeatAttrs)
  .step('probe', probeService, ctx => ctx.unit.attributes)
  .exit('healthy', ctx => ctx.steps.probe.exitCode === 0)
  .exit('down');

const heartbeats = H.lane('heartbeats', heartbeat)
  .supply(H.clock('every-five-minutes').every({ minutes: 5 }), (tick, to) =>
    to.create({ service: 'api', at: tick.at.toISOString() }),
  )
  .handler(heartbeatFlow, { exits: { healthy, down }, during: { probe: probing } })
  .retry({ maxAttempts: 1, backoff: 'fixed', initialDelayMs: 0, exhausted: down });

const heartbeatDownFilesBug = H.trigger('heartbeat-down-files-bug')
  .on(H.when.transition(heartbeats, { to: down }))
  .create(bugs, e => ({
    ref: `heartbeat:${e.unit.attributes.service}`,
    title: `${e.unit.attributes.service} heartbeat failed`,
    body: `The heartbeat ${e.unit.key} ended Down at ${e.at.toISOString()}.`,
  }));

const scheduler = H.scheduler('coding-team')
  .priority(heartbeats, bugs, features, epics)
  .wip(bugs, 2)
  .wip(epics, 1)
  .boost(features, { afterMinutes: 240 });

const productionHealth = H.operation(
  'production-health-probe',
  H.command('production-health').argv(['./scripts/production-health.sh']).runner(localRunner),
);

const owner = claudeCode.supervisor('owner');

export const codingTeam = H.harness('coding-team')
  .ledger(sqlite.ledger({ path: '.harness/coding-team.db' }))
  .lanes(heartbeats, bugs, features, epics)
  .journals(lessons, preferences)
  .triggers(heartbeatDownFilesBug)
  .scheduler(scheduler)
  .clients(
    owner.client('owner-console', {
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
    }),
  )
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));

void codingTeam.start();
