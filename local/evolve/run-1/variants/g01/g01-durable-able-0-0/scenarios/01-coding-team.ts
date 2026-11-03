import { z } from 'zod';
import { H } from 'harness-dsl';
import type { AccountState } from 'harness-dsl';
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
const Planning = H.state('Planning', 'active');
const Building = H.state('Building', 'active');
const Auditing = H.state('Auditing', 'active');
const Delivering = H.state('Delivering', 'waiting');
const Done = H.state('Done', 'terminal', 'success');
const Abandoned = H.state('Abandoned', 'terminal', 'failure');

const Due = H.state('Due', 'pending');
const Probing = H.state('Probing', 'active');
const Healthy = H.state('Healthy', 'terminal', 'success');
const Down = H.state('Down', 'terminal', 'failure');

const ticket = z.object({
  title: z.string(),
  body: z.string(),
  source: z.string(),
  ref: z.string(),
});

const Bug = H.kind('Bug')
  .attributes(ticket)
  .states(Queued, Building, Auditing, Done, Abandoned)
  .key(attrs => attrs.ref);

const Feature = H.kind('Feature')
  .attributes(ticket.extend({ epic: z.string().optional() }))
  .states(Queued, Building, Auditing, Done, Abandoned)
  .key(attrs => attrs.ref);

const Epic = H.kind('Epic')
  .attributes(ticket)
  .states(Queued, Planning, Delivering, Done, Abandoned)
  .key(attrs => attrs.ref);

const ServiceHeartbeat = H.kind('ServiceHeartbeat')
  .attributes(z.object({ service: z.string(), url: z.string() }))
  .states(Due, Probing, Healthy, Down)
  .key(attrs => attrs.service);

const maxA = claudeCode.subscription('claude-max-a', { token: H.env('CLAUDE_MAX_A_TOKEN') });
const maxB = claudeCode.subscription('claude-max-b', { token: H.env('CLAUDE_MAX_B_TOKEN') });
const maxC = claudeCode.subscription('claude-max-c', { token: H.env('CLAUDE_MAX_C_TOKEN') });
const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });

const soonestExpiring = H.policy.account('soonest-expiring-window', ctx =>
  ctx.candidates.reduce<AccountState | undefined>(
    (best, next) =>
      best === undefined || next.windowResetsAt.getTime() < best.windowResetsAt.getTime() ? next : best,
    undefined,
  ),
);

const claudePool = H.pool('claude-subscriptions')
  .accounts(maxA, maxB, maxC)
  .share(maxA, 0.5)
  .share(maxB, 0.4)
  .share(maxC, 0.3)
  .drain(soonestExpiring)
  .fallback(apiAccount);

const sonnet = claudeCode.model('sonnet', { id: 'claude-sonnet-4-5' });
const opus = claudeCode.model('opus', { id: 'claude-opus-4-1' });

const builderModel = H.policy.model('builder-model', [sonnet, opus], ctx => {
  const cheap = ctx.metrics.outcomes({ of: ctx.lane, model: sonnet, windowDays: 14 }).attempts;
  return cheap.samples >= 20 && cheap.successRate < 0.85 ? opus : sonnet;
});

const localRunner = local.runner('local');

const projectChecks = H.command('project-checks')
  .argv(['npm', 'run', 'check'])
  .runner(localRunner);

const builderRole = H.role('builder')
  .intents('read', 'edit', 'run', 'search', 'halt')
  .instructions('Implement the task in the worktree. Halt for the owner when a product decision is needed.');

const auditorRole = H.role('auditor')
  .intents('read', 'run', 'search', 'record')
  .instructions('List every deficit against the task. Record lessons that will help the next build.');

const plannerRole = H.role('planner')
  .intents('read', 'search')
  .instructions('Decompose the epic into independently shippable features.');

const builder = H.agent('builder')
  .role(builderRole)
  .model(builderModel)
  .workspace(git.worktree({ repo: '.', base: 'main' }))
  .guards(H.guard.lease(), H.guard.beforeStop(projectChecks))
  .output(z.object({ summary: z.string(), files: z.array(z.string()) }));

const auditor = H.agent('auditor')
  .role(auditorRole)
  .model(opus)
  .output(z.object({ deficits: z.array(z.string()) }));

const planner = H.agent('planner')
  .role(plannerRole)
  .model(opus)
  .output(z.object({ features: z.array(z.object({ title: z.string(), body: z.string() })) }));

const deliverTicket = H.flow('deliver-ticket')
  .input(z.object({ title: z.string(), body: z.string() }))
  .params(z.object({ rounds: z.number().int() }))
  .loop(
    'rounds',
    round => round
      .step('build', builder, ctx => ({
        task: `${ctx.unit.attributes.title}\n\n${ctx.unit.attributes.body}`,
      }))
      .step('audit', auditor, ctx => ({
        task: `Audit this change against the task "${ctx.unit.attributes.title}".\n\n${ctx.steps.build.summary}`,
        resources: ctx.steps.build.files,
      })),
    {
      max: ctx => ctx.params.rounds,
      until: ctx => ctx.steps.audit.deficits.length === 0,
    },
  )
  .exit('clean', ctx => ctx.steps.audit.deficits.length === 0)
  .exit('exhausted');

const probeService = H.command('probe-service')
  .input(z.object({ url: z.string() }))
  .argv(input => ['curl', '--fail', '--silent', '--max-time', '10', input.url])
  .runner(localRunner);

const heartbeat = H.flow('service-heartbeat')
  .input(z.object({ service: z.string(), url: z.string() }))
  .step('probe', probeService, ctx => ({ url: ctx.unit.attributes.url }), { restart: 'rerun' })
  .exit('healthy');

const trackerKey = H.env('LINEAR_API_KEY');
const tracker = linear.store({
  apiKey: trackerKey,
  team: 'PRODUCT',
  states: {
    Queued: 'Todo',
    Planning: 'In Progress',
    Building: 'In Progress',
    Auditing: 'In Review',
    Delivering: 'In Progress',
    Done: 'Done',
    Abandoned: 'Canceled',
  },
});

const services = [
  { service: 'api', url: 'https://api.example.com/health' },
  { service: 'web', url: 'https://www.example.com/health' },
  { service: 'worker', url: 'https://worker.example.com/health' },
];

const heartbeatLane = H.lane('heartbeats', ServiceHeartbeat)
  .supply(H.clock('every-five-minutes').every({ minutes: 5 }), (_tick, to) =>
    services.map(service => to.create(service)),
  )
  .handler(heartbeat, {
    exits: { healthy: Healthy },
    during: { probe: Probing },
    failure: Down,
  });

const bugLane = H.lane('bugs', Bug)
  .supply(linear.issues({ apiKey: trackerKey, team: 'PRODUCT', labels: ['bug'] }), (issue, to) =>
    to.create({ title: issue.title, body: issue.description, source: 'tracker', ref: issue.identifier }),
  )
  .supply(folder.files({ path: 'bugs', glob: '*.md' }), (file, to) =>
    to.create({ title: file.name, body: file.body, source: 'folder', ref: file.path }),
  )
  .supply(H.operator)
  .store(tracker)
  .handler(deliverTicket, {
    params: { rounds: 3 },
    exits: { clean: Done, exhausted: Abandoned },
    during: { build: Building, audit: Auditing },
    failure: Abandoned,
  });

const featureLane = H.lane('features', Feature)
  .supply(linear.issues({ apiKey: trackerKey, team: 'PRODUCT', labels: ['feature'] }), (issue, to) =>
    to.create({ title: issue.title, body: issue.description, source: 'tracker', ref: issue.identifier, epic: issue.parentId }),
  )
  .supply(H.operator)
  .store(tracker)
  .handler(deliverTicket, {
    params: { rounds: 5 },
    exits: { clean: Done, exhausted: Abandoned },
    during: { build: Building, audit: Auditing },
    failure: Abandoned,
  });

const deliverEpic = H.flow('deliver-epic')
  .input(ticket)
  .step('plan', planner, ctx => ({
    task: `Decompose this epic into features.\n\n${ctx.unit.attributes.title}\n\n${ctx.unit.attributes.body}`,
  }))
  .spawn('features', featureLane, ctx =>
    ctx.steps.plan.features.map((feature, index) => ({
      title: feature.title,
      body: feature.body,
      source: 'epic',
      ref: `${ctx.unit.key}/${index + 1}`,
      epic: ctx.unit.key,
    })),
  )
  .exit('completed', ctx => ctx.steps.features.every(child => child.verdict === 'success'))
  .exit('incomplete');

const epicLane = H.lane('epics', Epic)
  .supply(linear.issues({ apiKey: trackerKey, team: 'PRODUCT', labels: ['epic'] }), (issue, to) =>
    to.create({ title: issue.title, body: issue.description, source: 'tracker', ref: issue.identifier }),
  )
  .store(tracker)
  .handler(deliverEpic, {
    exits: { completed: Done, incomplete: Abandoned },
    during: { plan: Planning, features: Delivering },
    failure: Abandoned,
  });

const heartbeatFailureFilesBug = H.trigger('heartbeat-failure-files-bug')
  .on(H.when.transition(heartbeatLane, { to: Down }))
  .create(bugLane, event => ({
    title: `Service ${event.unit.attributes.service} failed its heartbeat`,
    body: `The health probe of ${event.unit.attributes.url} failed at ${event.at.toISOString()}.`,
    source: 'heartbeat',
    ref: `heartbeat/${event.unit.attributes.service}`,
  }));

const experience = H.memory('experience').trust('experience');
const taste = H.memory('taste').trust('taste');

const experiencePlaybook = H.playbook('coding-experience', experience)
  .store(jsonl.memoryStore({ path: '.harness/memory/experience.jsonl' }))
  .recall(H.recall('experience-by-specificity', { by: 'specificity', limit: 8 }))
  .readBy(builderRole, auditorRole)
  .recordedBy(auditorRole);

const tastePlaybook = H.playbook('owner-taste', taste)
  .store(jsonl.memoryStore({ path: '.harness/memory/taste.jsonl' }))
  .recall(H.recall('taste-by-specificity', { by: 'specificity', limit: 12 }))
  .readBy(builderRole, plannerRole);

const productionHealth = H.operation('production-health-probe').run(
  H.command('production-health')
    .argv(['./scripts/production-health.sh'])
    .runner(localRunner),
);

const supervisor = claudeCode.supervisor('supervisor', {
  grants: [
    H.ops.workRead,
    H.ops.workCreate,
    H.ops.workUpdate,
    H.ops.workCancel,
    H.ops.workSignal,
    H.ops.blockersResolve,
    H.ops.memoryRead,
    H.ops.memoryWrite,
    H.ops.telemetryRead,
    H.ops.accountsRead,
    H.ops.accountsShare,
    productionHealth,
  ],
});

const scheduler = H.scheduler('coding-team')
  .priority(heartbeatLane, bugLane, featureLane, epicLane)
  .wip(bugLane, 2)
  .wip(epicLane, 1)
  .boost(featureLane, { afterMinutes: 240 });

export const codingTeam = H.harness('coding-team')
  .ledger(sqlite.ledger({ path: '.harness/ledger.sqlite' }))
  .pools(claudePool)
  .lanes(heartbeatLane, bugLane, featureLane, epicLane)
  .playbooks(experiencePlaybook, tastePlaybook)
  .triggers(heartbeatFailureFilesBug)
  .scheduler(scheduler)
  .clients(supervisor)
  .observers(
    markdown.board({ path: 'BOARD.md' }),
    markdown.telemetry({ path: 'TELEMETRY.md' }),
  );
