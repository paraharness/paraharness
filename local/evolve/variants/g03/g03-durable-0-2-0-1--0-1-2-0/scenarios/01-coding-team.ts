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

export const ticket = z.object({ ref: z.string(), title: z.string(), body: z.string() });
export const featureAttributes = ticket.extend({ epic: z.string().optional() });

export const Todo = H.state('Todo', 'pending');
export const Done = H.terminal('Done', 'success');
export const Abandoned = H.terminal('Abandoned', 'failure');
export const Cancelled = H.terminal('Cancelled', 'neutral');

export const Bug = H.kind('Bug').attributes(ticket).states(Todo, Done, Abandoned, Cancelled).key(a => a.ref).initial(Todo);
export const Feature = H.kind('Feature')
  .attributes(featureAttributes)
  .states(Todo, Done, Abandoned, Cancelled)
  .key(a => a.ref)
  .initial(Todo);
export const Epic = H.kind('Epic').attributes(ticket).states(Todo, Done, Abandoned, Cancelled).key(a => a.ref).initial(Todo);

const Due = H.state('Due', 'pending');
const Healthy = H.terminal('Healthy', 'success');
const Unhealthy = H.terminal('Unhealthy', 'failure');
const ServiceHeartbeat = H.kind('ServiceHeartbeat')
  .attributes(z.object({ service: z.string() }))
  .states(Due, Healthy, Unhealthy)
  .key(a => a.service)
  .initial(Due);

export const claudeQuota = sqlite.quota('claude-subscriptions', { path: '~/.harness/quota.sqlite' });
export const subscriptionOne = claudeCode.subscription('claude-max-1', { token: H.env('CLAUDE_TOKEN_1'), quota: claudeQuota });
export const subscriptionTwo = claudeCode.subscription('claude-max-2', { token: H.env('CLAUDE_TOKEN_2'), quota: claudeQuota });
export const subscriptionThree = claudeCode.subscription('claude-max-3', { token: H.env('CLAUDE_TOKEN_3'), quota: claudeQuota });
export const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota: claudeQuota });

const sonnet = claudeCode.model('sonnet', { id: 'claude-sonnet-4-5' });
const opus = claudeCode.model('opus', { id: 'claude-opus-4-1' });

const soonestExpiring = H.policy.account('soonest-expiring', ctx =>
  [...ctx.candidates]
    .filter(c => c.shareUsed < c.shareCap && (c.cooldownUntil === undefined || c.cooldownUntil <= ctx.now))
    .sort((a, b) => a.windowResetsAt.getTime() - b.windowResetsAt.getTime())[0],
);

const claudePool = H.pool('claude')
  .accounts(subscriptionOne, subscriptionTwo, subscriptionThree)
  .share(subscriptionOne, 0.6)
  .share(subscriptionTwo, 0.6)
  .share(subscriptionThree, 0.4)
  .drain(soonestExpiring)
  .fallback(apiAccount);

const builderModel = H.policy.model('builder-model', [sonnet, opus], ctx => {
  const cheap = ctx.metrics.attempts({ of: ctx.kind, seat: ctx.seat, model: sonnet, window: { lastDays: 14 } });
  return cheap.samples < 20 || cheap.successRate >= 0.85 ? sonnet : opus;
});

const builder = H.role('builder').intents('read', 'edit', 'run', 'halt').instructions('Implement the change in the worktree until the checks pass.');
const auditor = H.role('auditor').intents('read', 'run', 'record').instructions('List every deficit of the change; record lessons as forward-phrased experience.');
const planner = H.role('planner').intents('read', 'search').instructions('Decompose the epic into independently shippable features.');

const builderSeat = H.seat('builder').role(builder).model(builderModel).pool(claudePool);
const auditorSeat = H.seat('auditor').role(auditor).model(opus).pool(claudePool);
const plannerSeat = H.seat('planner').role(planner).model(opus).pool(claudePool);

const localRunner = local.runner('local');
const projectChecks = H.command('project-checks').argv(['npm', 'run', 'check']).runner(localRunner);
const ownerDecision = H.halt('owner-decision').decision(z.object({ choice: z.string(), note: z.string().optional() }));

const buildCall = H.call('build', builderSeat)
  .output(z.object({ summary: z.string() }))
  .workspace(git.worktree({ repo: '.', base: 'main' }))
  .guard({ leaseFiles: true, beforeStop: projectChecks })
  .halts(ownerDecision);
const auditCall = H.call('audit', auditorSeat).output(z.object({ deficits: z.array(z.string()) }));
const planCall = H.call('plan', plannerSeat).output(
  z.object({ features: z.array(z.object({ title: z.string(), body: z.string() })) }),
);

const buildAndAudit = H.flow('build-and-audit')
  .input(ticket)
  .params(z.object({ rounds: z.number().int() }))
  .loop(
    'rounds',
    { schema: z.array(z.string()), initial: [] },
    round =>
      round
        .step('build', buildCall, ctx => ({
          text: `Implement ${ctx.unit.attributes.ref}: ${ctx.unit.attributes.title}\n\n${ctx.unit.attributes.body}\n\nOpen deficits: ${ctx.steps.rounds.length === 0 ? 'none' : ctx.steps.rounds.join('; ')}`,
        }))
        .step('audit', auditCall, ctx => ({
          text: `Audit the change for ${ctx.unit.attributes.ref} against:\n${ctx.unit.attributes.body}\n\nBuilder summary: ${ctx.steps.build.summary}`,
        })),
    {
      max: ctx => ctx.params.rounds,
      until: ctx => ctx.steps.audit.deficits.length === 0,
      next: ctx => ctx.steps.audit.deficits,
    },
  )
  .exit('clean', ctx => ctx.steps.audit.deficits.length === 0)
  .exit('roundsExhausted');

const tracker = linear.store({
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'ENG',
  workflow: ['Todo', 'In Progress', 'In Review', 'Done', 'Canceled'],
});
const trackerMap = {
  states: { Todo: 'Todo', Done: 'Done', Abandoned: 'Canceled', Cancelled: 'Canceled' },
  inFlight: 'In Progress',
  steps: { audit: 'In Review' },
} as const satisfies object;

export const features = H.lane('features', Feature)
  .supply(linear.issues({ apiKey: H.env('LINEAR_API_KEY'), team: 'ENG', labels: ['feature'] }), (issue, to) =>
    to.create({ ref: issue.identifier, title: issue.title, body: issue.description }),
  )
  .supply(H.operator)
  .handler(buildAndAudit, { exits: { clean: Done, roundsExhausted: Abandoned }, params: { rounds: 5 } })
  .store(tracker, { states: trackerMap.states, inFlight: trackerMap.inFlight, steps: trackerMap.steps })
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 60_000, exhausted: Abandoned })
  .on(H.cancel, { enter: Cancelled });

export const bugs = H.lane('bugs', Bug)
  .supply(linear.issues({ apiKey: H.env('LINEAR_API_KEY'), team: 'ENG', labels: ['bug'] }), (issue, to) =>
    to.create({ ref: issue.identifier, title: issue.title, body: issue.description }),
  )
  .supply(folder.files({ path: './bugs', glob: '*.md' }), (file, to) =>
    to.create({ ref: `file-${file.name}`, title: file.name, body: file.body }),
  )
  .supply(H.operator)
  .handler(buildAndAudit, { exits: { clean: Done, roundsExhausted: Abandoned }, params: { rounds: 3 } })
  .store(tracker, { states: trackerMap.states, inFlight: trackerMap.inFlight, steps: trackerMap.steps })
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 60_000, exhausted: Abandoned })
  .on(H.cancel, { enter: Cancelled });

const epicFlow = H.flow('epic')
  .input(ticket)
  .step('plan', planCall, ctx => ({
    text: `Decompose epic ${ctx.unit.attributes.ref}: ${ctx.unit.attributes.title}\n\n${ctx.unit.attributes.body}`,
  }))
  .spawn('features', features, ctx =>
    ctx.steps.plan.features.map((f, i) => ({
      ref: `${ctx.unit.attributes.ref}-${i + 1}`,
      title: f.title,
      body: f.body,
      epic: ctx.unit.attributes.ref,
    })),
  )
  .exit('delivered', ctx => ctx.steps.features.every(child => child.verdict === 'success'))
  .exit('incomplete');

export const epics = H.lane('epics', Epic)
  .supply(linear.issues({ apiKey: H.env('LINEAR_API_KEY'), team: 'ENG', labels: ['epic'] }), (issue, to) =>
    to.create({ ref: issue.identifier, title: issue.title, body: issue.description }),
  )
  .handler(epicFlow, { exits: { delivered: Done, incomplete: Abandoned } })
  .store(tracker, { states: trackerMap.states, inFlight: trackerMap.inFlight })
  .retry({ maxAttempts: 2, backoff: 'fixed', initialDelayMs: 300_000, exhausted: Abandoned })
  .on(H.cancel, { enter: Cancelled });

const serviceProbe = H.command('service-probe')
  .input(z.object({ service: z.string() }))
  .argv(i => ['./scripts/heartbeat.sh', i.service])
  .runner(localRunner);

const heartbeatFlow = H.flow('heartbeat')
  .input(z.object({ service: z.string() }))
  .step('probe', serviceProbe, ctx => ({ service: ctx.unit.attributes.service }))
  .exit('healthy');

export const heartbeats = H.lane('heartbeats', ServiceHeartbeat)
  .supply(H.clock('every-five-minutes').every({ minutes: 5 }), (tick, to) => to.create({ service: 'api' }))
  .handler(heartbeatFlow, { exits: { healthy: Healthy } })
  .retry({ maxAttempts: 1, exhausted: Unhealthy });

const heartbeatFailed = H.trigger('heartbeat-failed-opens-bug')
  .on(H.when.transition(heartbeats, { to: Unhealthy }))
  .create(bugs, e => ({
    ref: `heartbeat-${e.unit.attributes.service}`,
    title: `Heartbeat failed for ${e.unit.attributes.service}`,
    body: `The ${e.unit.attributes.service} heartbeat failed at ${e.at.toISOString()}.`,
  }));

const experienceKind = H.memory('experience', 'experience');
const tasteKind = H.memory('taste', 'taste');

export const experience = H.journal('experience', experienceKind)
  .store(jsonl.memoryStore({ path: './memory/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 8 })
  .readBy(builder, auditor)
  .recordedBy(auditor);

export const taste = H.journal('taste', tasteKind)
  .store(jsonl.memoryStore({ path: '~/.harness/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 12 })
  .readBy(builder, planner);

const scheduler = H.scheduler('coding-team')
  .standard(heartbeats, bugs, features, epics)
  .wip(bugs, 2)
  .wip(epics, 1)
  .aging(features, { afterMinutes: 240 });

const productionProbe = H.command('production-health-probe').argv(['./scripts/prod-health.sh']).runner(localRunner);

export const supervisor = claudeCode.supervisor('supervisor', {
  grants: [
    H.ops.workRead,
    H.ops.workCreate,
    H.ops.workUpdate,
    H.ops.workCancel,
    H.ops.resolve(ownerDecision),
    H.ops.memoryWrite,
    H.ops.telemetryRead,
    H.ops.accountsRead,
    H.ops.accountsShare,
    H.operation('production-health-probe', productionProbe),
  ],
});

export const codingTeam = H.harness('coding-team')
  .ledger(sqlite.ledger({ path: './.harness/ledger.sqlite' }))
  .lanes(heartbeats, bugs, features, epics)
  .journals(experience, taste)
  .triggers(heartbeatFailed)
  .scheduler(scheduler)
  .clients(supervisor)
  .observers(markdown.board({ path: './BOARD.md' }), markdown.telemetry({ path: './TELEMETRY.md' }));

void codingTeam.start();
