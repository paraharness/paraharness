import { z } from 'zod';
import { H } from 'harness-dsl';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { linear } from 'harness-dsl/linear';
import { folder } from 'harness-dsl/folder';
import { git } from 'harness-dsl/git';
import { local } from 'harness-dsl/local';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { markdown } from 'harness-dsl/markdown';

const Ticket = z.object({
  title: z.string(),
  description: z.string(),
  externalId: z.string().optional(),
});

const Service = z.object({ service: z.string() });

const Backlog = H.state('Backlog', 'pending');
const Done = H.terminal('Done', 'success');
const Exhausted = H.terminal('Exhausted', 'failure');
const Cancelled = H.terminal('Cancelled', 'neutral');

const Planned = H.state('Planned', 'pending');
const Completed = H.terminal('Completed', 'success');
const Incomplete = H.terminal('Incomplete', 'failure');

const Due = H.state('Due', 'pending');
const Healthy = H.terminal('Healthy', 'success');
const Unhealthy = H.terminal('Unhealthy', 'failure');

export const Bug = H.kind('Bug')
  .attributes(Ticket)
  .states(Backlog, Done, Exhausted, Cancelled)
  .key(ticket => ticket.externalId ?? ticket.title)
  .initial(Backlog)
  .onCancelled(Cancelled);

export const Feature = H.kind('Feature')
  .attributes(Ticket)
  .states(Backlog, Done, Exhausted, Cancelled)
  .key(ticket => ticket.externalId ?? ticket.title)
  .initial(Backlog)
  .onCancelled(Cancelled);

export const Epic = H.kind('Epic')
  .attributes(Ticket)
  .states(Planned, Completed, Incomplete, Cancelled)
  .key(ticket => ticket.externalId ?? ticket.title)
  .initial(Planned)
  .onCancelled(Cancelled);

export const Heartbeat = H.kind('ServiceHeartbeat')
  .attributes(Service)
  .states(Due, Healthy, Unhealthy, Cancelled)
  .key(heartbeat => heartbeat.service)
  .initial(Due)
  .onCancelled(Cancelled);

export const max1 = claudeCode.subscription('claude-max-1', { token: H.env('CLAUDE_MAX_1_TOKEN') });
export const max2 = claudeCode.subscription('claude-max-2', { token: H.env('CLAUDE_MAX_2_TOKEN') });
export const max3 = claudeCode.subscription('claude-max-3', { token: H.env('CLAUDE_MAX_3_TOKEN') });
export const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });

export const sonnet = claudeCode.model('sonnet', { id: 'claude-sonnet-4-5' });
export const opus = claudeCode.model('opus', { id: 'claude-opus-4-1' });

export const claudePool = H.pool('claude')
  .accounts(max1, max2, max3)
  .share(max1, 0.5)
  .share(max2, 0.3)
  .share(max3, 0.2)
  .drain(H.policy.account('soonestExpiring', account => account.windowResetsAt.getTime()))
  .fallback(apiAccount)
  .serves(sonnet, opus)
  .ledger(sqlite.accountLedger({ path: '../shared/accounts.sqlite' }));

const localRunner = local.runner('local').slots(4);

const projectChecks = H.command('projectChecks')
  .argv(['npm', 'run', 'check'])
  .runner(localRunner);

const probe = H.command('probeService')
  .input(Service)
  .argv(input => ['./scripts/probe.sh', input.service])
  .runner(localRunner)
  .acceptExitCodes(1);

const productionHealthProbe = H.command('productionHealthProbe')
  .argv(['./scripts/probe-production.sh'])
  .runner(localRunner);

const builderRole = H.role('builder')
  .intents('read', 'edit', 'run', 'search', 'halt')
  .instructions('Implement the change in the worktree. Halt for an owner decision when the requirement is ambiguous.');

const auditorRole = H.role('auditor')
  .intents('read', 'run', 'search', 'record')
  .instructions('List every deficit of the change against its description. Record lessons worth keeping.');

const plannerRole = H.role('planner')
  .intents('read', 'search')
  .instructions('Decompose the epic into independently shippable features.');

const builderModel = H.policy.model('builderModel', [sonnet, opus], ctx => {
  const cheaper = ctx.metrics.attempts({ of: ctx.kind, model: sonnet, window: { lastDays: 14 } });
  return cheaper.samples >= 20 && cheaper.successRate < 0.85 ? opus : sonnet;
});

const builder = H.agent('builder')
  .role(builderRole)
  .model(builderModel)
  .workspace(git.worktree({ repo: '.', base: 'main' }))
  .guards(H.guard.lease(), H.guard.beforeStop(projectChecks))
  .budgetTokens(400_000);

const auditor = H.agent('auditor')
  .role(auditorRole)
  .model(opus)
  .output(z.object({ deficits: z.array(z.string()) }))
  .budgetTokens(150_000);

const planner = H.agent('planner')
  .role(plannerRole)
  .model(opus)
  .output(z.object({ features: z.array(z.object({ title: z.string(), description: z.string() })) }))
  .budgetTokens(100_000);

const ticketFlow = H.flow('buildAndAudit')
  .input(Ticket)
  .params(z.object({ rounds: z.number().int().positive() }))
  .step('build', builder, ctx => ({
    task: `${ctx.unit.attributes.title}\n\n${ctx.unit.attributes.description}`,
  }))
  .loop(
    'rounds',
    flow => flow
      .step('audit', auditor, ctx => ({
        task: `Audit the change made for "${ctx.unit.attributes.title}" against:\n\n${ctx.unit.attributes.description}`,
      }))
      .exit('clean', ctx => ctx.steps.audit.deficits.length === 0)
      .step('fix', builder, ctx => ({
        task: `Resolve these deficits in "${ctx.unit.attributes.title}":\n${ctx.steps.audit.deficits.map(deficit => `- ${deficit}`).join('\n')}`,
      })),
    { max: ctx => ctx.params.rounds },
  )
  .exit('exhausted');

const heartbeatFlow = H.flow('heartbeat')
  .input(Service)
  .step('probe', probe, ctx => ({ service: ctx.unit.attributes.service }))
  .exit('healthy', ctx => ctx.steps.probe.exitCode === 0)
  .exit('unhealthy');

const linearKey = H.env('LINEAR_API_KEY');

const tracker = linear.store({
  apiKey: linearKey,
  team: 'ENG',
  states: {
    Backlog: 'Backlog',
    Done: 'Done',
    Exhausted: 'Canceled',
    Cancelled: 'Canceled',
    Planned: 'Backlog',
    Completed: 'Done',
    Incomplete: 'Canceled',
  },
  whileActive: 'In Progress',
  whileWaiting: 'Blocked',
});

export const heartbeats = H.lane('heartbeats', Heartbeat)
  .supply(H.clock('everyFiveMinutes').every({ minutes: 5 }), (_tick, to) =>
    ['api', 'web', 'worker'].map(service => to.create({ service })))
  .handler(heartbeatFlow, { exits: { healthy: Healthy, unhealthy: Unhealthy } });

export const bugs = H.lane('bugs', Bug)
  .supply(linear.issues({ apiKey: linearKey, team: 'ENG', labels: ['bug'] }), (issue, to) =>
    to.create({ title: issue.title, description: issue.description, externalId: issue.id }))
  .supply(folder.files({ path: 'bugs', glob: '*.md' }), (file, to) =>
    to.create({ title: file.name, description: file.body, externalId: file.path }))
  .supply(H.operator)
  .store(tracker)
  .handler(ticketFlow, { exits: { clean: Done, exhausted: Exhausted }, params: { rounds: 3 } });

export const features = H.lane('features', Feature)
  .supply(linear.issues({ apiKey: linearKey, team: 'ENG', labels: ['feature'] }), (issue, to) =>
    to.create({ title: issue.title, description: issue.description, externalId: issue.id }))
  .supply(H.operator)
  .store(tracker)
  .handler(ticketFlow, { exits: { clean: Done, exhausted: Exhausted }, params: { rounds: 5 } });

const epicFlow = H.flow('decomposeEpic')
  .input(Ticket)
  .step('plan', planner, ctx => ({
    task: `Decompose into features:\n${ctx.unit.attributes.title}\n\n${ctx.unit.attributes.description}`,
  }))
  .spawn('features', features, ctx =>
    ctx.steps.plan.features.map(feature => ({ title: feature.title, description: feature.description })))
  .exit('completed', ctx => ctx.steps.features.every(child => child.verdict === 'success'))
  .exit('incomplete');

export const epics = H.lane('epics', Epic)
  .supply(linear.issues({ apiKey: linearKey, team: 'ENG', labels: ['epic'] }), (issue, to) =>
    to.create({ title: issue.title, description: issue.description, externalId: issue.id }))
  .store(tracker)
  .handler(epicFlow, { exits: { completed: Completed, incomplete: Incomplete } });

const heartbeatFilesBug = H.trigger('heartbeatFailureFilesBug', H.when.transition(heartbeats, { to: Unhealthy }))
  .create(bugs, event => ({
    title: `Service ${event.unit.attributes.service} failed its heartbeat`,
    description: `Heartbeat ${event.unit.id} ended Unhealthy at ${event.at.toISOString()}.`,
  }));

const Experience = H.memory('experience')
  .body(z.object({ do: z.string(), when: z.string(), because: z.string() }))
  .trust('experience');

export const Taste = H.memory('taste').trust('taste');

const mostSpecific = H.recall('mostSpecific', { by: 'specificity', limit: 12 });

const experience = H.journal('codingExperience', Experience)
  .store(jsonl.memoryStore({ path: '.harness/experience.jsonl' }))
  .recall(mostSpecific)
  .readBy(builderRole, auditorRole)
  .recordedBy(auditorRole);

const taste = H.journal('ownerTaste', Taste)
  .store(jsonl.memoryStore({ path: '../shared/taste.jsonl' }))
  .recall(mostSpecific)
  .readBy(builderRole, plannerRole);

const scheduler = H.scheduler('codingTeam')
  .priority(heartbeats, bugs, features, epics)
  .wip(bugs, 2)
  .wip(epics, 1)
  .boost(features, { afterMinutes: 240 });

const probeProduction = H.operation('probeProduction').run(productionHealthProbe);

const supervisor = claudeCode.supervisor('codingSupervisor', {
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
    probeProduction,
  ],
});

export const codingTeam = H.harness('codingTeam')
  .ledger(sqlite.ledger({ path: '.harness/ledger.sqlite' }))
  .pools(claudePool)
  .lanes(heartbeats, bugs, features, epics)
  .journals(experience, taste)
  .triggers(heartbeatFilesBug)
  .scheduler(scheduler)
  .clients(supervisor)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));
