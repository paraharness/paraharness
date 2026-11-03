import { z } from 'zod';
import { H, ModelPolicy } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { linear } from 'harness-dsl/linear';
import { folder } from 'harness-dsl/folder';
import { git } from 'harness-dsl/git';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const Open = H.state('Open', 'pending');
const Building = H.state('Building', 'active');
const Auditing = H.state('Auditing', 'active');
const Done = H.state('Done', 'terminal', 'success');
const Abandoned = H.state('Abandoned', 'terminal', 'failure');
const Withdrawn = H.state('Withdrawn', 'terminal', 'neutral');

const EpicOpen = H.state('EpicOpen', 'pending');
const Planning = H.state('Planning', 'active');
const Decomposed = H.state('Decomposed', 'waiting');
const EpicDone = H.state('EpicDone', 'terminal', 'success');
const EpicIncomplete = H.state('EpicIncomplete', 'terminal', 'failure');

const HeartbeatDue = H.state('HeartbeatDue', 'pending');
const Probing = H.state('Probing', 'active');
const Healthy = H.state('Healthy', 'terminal', 'success');
const Unhealthy = H.state('Unhealthy', 'terminal', 'failure');

const ticketAttrs = z.object({ ref: z.string(), title: z.string(), description: z.string() });
const featureAttrs = z.object({ ref: z.string(), title: z.string(), description: z.string(), epic: z.string().optional() });

const Bug = H.kind('Bug')
  .attributes(ticketAttrs)
  .states(Open, Building, Auditing, Done, Abandoned, Withdrawn)
  .key(a => a.ref);

const Feature = H.kind('Feature')
  .attributes(featureAttrs)
  .states(Open, Building, Auditing, Done, Abandoned, Withdrawn)
  .key(a => a.ref);

const Epic = H.kind('Epic')
  .attributes(ticketAttrs)
  .states(EpicOpen, Planning, Decomposed, EpicDone, EpicIncomplete, Withdrawn)
  .key(a => a.ref);

const Heartbeat = H.kind('ServiceHeartbeat')
  .attributes(z.object({ service: z.string() }))
  .states(HeartbeatDue, Probing, Healthy, Unhealthy, Withdrawn)
  .key(a => a.service);

const max1 = claudeCode.subscription('max-1', { token: H.env('CLAUDE_MAX_1_TOKEN') });
const max2 = claudeCode.subscription('max-2', { token: H.env('CLAUDE_MAX_2_TOKEN') });
const max3 = claudeCode.subscription('max-3', { token: H.env('CLAUDE_MAX_3_TOKEN') });
const apiAccount = anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY') });

const soonestExpiring = H.policy.account('soonestExpiring', ctx =>
  [...ctx.candidates]
    .filter(a => (a.cooldownUntil === undefined || a.cooldownUntil.getTime() <= ctx.now.getTime()) && a.shareUsed < a.shareCap)
    .sort((a, b) => a.windowResetsAt.getTime() - b.windowResetsAt.getTime())[0]);

const claudePool = H.pool('claude')
  .accounts(max1, max2, max3)
  .share(max1, 0.5)
  .share(max2, 0.3)
  .share(max3, 0.2)
  .drain(soonestExpiring)
  .fallback(apiAccount);

const sonnet = claudeCode.model('sonnet', { id: 'claude-sonnet-4-5' });
const opus = claudeCode.model('opus', { id: 'claude-opus-4-1' });

const builderModel: ModelPolicy = H.policy.model('builderModel', [sonnet, opus], ctx => {
  const cheap = ctx.metrics.outcomes({ of: ctx.lane, model: sonnet, windowDays: 14 });
  if (cheap.units.samples < 20) return sonnet;
  return cheap.units.successRate < 0.85 ? opus : sonnet;
});

const builderRole = H.role('builder')
  .intents('read', 'edit', 'run', 'search', 'halt')
  .instructions('Implement the unit of work in the worktree. Halt for the owner when a product decision is needed.');
const auditorRole = H.role('auditor')
  .intents('read', 'run', 'search')
  .instructions('Find deficits in the change against the request. Report each deficit; report none when there are none.');
const plannerRole = H.role('planner')
  .intents('read', 'search')
  .instructions('Decompose the epic into independently shippable features.');

const Experience = H.memory('experience')
  .body(z.object({ do: z.string(), when: z.string(), because: z.string() }))
  .trust('experience');
const Taste = H.memory('taste')
  .body(z.object({ preference: z.string() }))
  .trust('taste');

const experience = H.journal('codingExperience', Experience)
  .store(jsonl.memoryStore({ path: '.harness/memory/experience.jsonl' }))
  .recall(H.recall('mostSpecificExperience', { by: 'specificity', limit: 8 }))
  .readBy(builderRole, auditorRole)
  .writtenBy(auditorRole);

const taste = H.journal('ownerTaste', Taste)
  .store(jsonl.memoryStore({ path: '.harness/memory/taste.jsonl' }))
  .recall(H.recall('broadTaste', { by: 'specificity', limit: 12 }))
  .readBy(builderRole, plannerRole);

const localRunner = local.runner('local');

const projectChecks = H.command('projectChecks')
  .argv(['npm', 'run', 'check'])
  .runner(localRunner);

const builder = H.agent('builder')
  .role(builderRole)
  .model(builderModel)
  .workspace(git.worktree({ repo: '.', base: 'main' }))
  .guards(H.guard.lease(), H.guard.beforeStop(projectChecks))
  .budgetTokens(400000)
  .output(z.object({ summary: z.string() }));

const auditor = H.agent('auditor')
  .role(auditorRole)
  .model(sonnet)
  .output(z.object({ deficits: z.array(z.string()) }));

const planner = H.agent('planner')
  .role(plannerRole)
  .model(opus)
  .output(z.object({ features: z.array(z.object({ title: z.string(), description: z.string() })) }));

const ticketFlow = H.flow('buildAndAudit')
  .input(z.object({ title: z.string(), description: z.string() }))
  .params(z.object({ rounds: z.number() }))
  .loop('rounds', flow => flow
    .step('build', builder, ctx => ({ task: `${ctx.unit.attributes.title}\n\n${ctx.unit.attributes.description}` }))
    .step('audit', auditor, ctx => ({ task: `Audit the change for "${ctx.unit.attributes.title}". Builder summary: ${ctx.steps.build.summary}` })),
  {
    max: ctx => ctx.params.rounds,
    until: ctx => ctx.steps.audit.deficits.length === 0,
  })
  .exit('clean', ctx => ctx.steps.audit.deficits.length === 0)
  .exit('exhausted');

const linearKey = H.env('LINEAR_API_KEY');
const trackerStates = { Open: 'Todo', Building: 'In Progress', Auditing: 'In Review', Done: 'Done', Abandoned: 'Canceled', Withdrawn: 'Canceled', EpicOpen: 'Todo', Planning: 'In Progress', Decomposed: 'In Progress', EpicDone: 'Done', EpicIncomplete: 'Canceled' };
const tracker = linear.store({ apiKey: linearKey, team: 'PROD', states: trackerStates });

const bugs = H.lane('bugs', Bug)
  .supply(H.operator)
  .supply(linear.issues({ apiKey: linearKey, team: 'PROD', labels: ['bug'] }), (issue, to) =>
    to.create({ ref: issue.identifier, title: issue.title, description: issue.description }))
  .supply(folder.files({ path: 'bugs', glob: '*.md' }), (file, to) =>
    to.create({ ref: file.path, title: file.name, description: file.body }))
  .store(tracker)
  .handler(ticketFlow, {
    params: { rounds: 3 },
    during: { build: Building, audit: Auditing },
    exits: { clean: Done, exhausted: Abandoned },
    failure: Abandoned,
  })
  .on(H.cancel, { enter: Withdrawn });

const features = H.lane('features', Feature)
  .supply(H.operator)
  .supply(linear.issues({ apiKey: linearKey, team: 'PROD', labels: ['feature'] }), (issue, to) =>
    to.create({ ref: issue.identifier, title: issue.title, description: issue.description, epic: issue.parentId }))
  .store(tracker)
  .handler(ticketFlow, {
    params: { rounds: 5 },
    during: { build: Building, audit: Auditing },
    exits: { clean: Done, exhausted: Abandoned },
    failure: Abandoned,
  })
  .on(H.cancel, { enter: Withdrawn });

const epicFlow = H.flow('decomposeEpic')
  .input(ticketAttrs)
  .step('plan', planner, ctx => ({ task: `Decompose epic "${ctx.unit.attributes.title}":\n${ctx.unit.attributes.description}` }))
  .spawn('decompose', features, ctx => ctx.steps.plan.features.map((f, i) => ({
    ref: `${ctx.unit.key}-f${i + 1}`,
    title: f.title,
    description: f.description,
    epic: ctx.unit.key,
  })))
  .exit('completed', ctx => ctx.steps.decompose.every(child => child.verdict === 'success'))
  .exit('incomplete');

const epics = H.lane('epics', Epic)
  .supply(linear.issues({ apiKey: linearKey, team: 'PROD', labels: ['epic'] }), (issue, to) =>
    to.create({ ref: issue.identifier, title: issue.title, description: issue.description }))
  .store(tracker)
  .handler(epicFlow, {
    during: { plan: Planning },
    waits: { decompose: Decomposed },
    exits: { completed: EpicDone, incomplete: EpicIncomplete },
    failure: EpicIncomplete,
  })
  .on(H.cancel, { enter: Withdrawn });

const probe = H.command('serviceProbe')
  .input(z.object({ service: z.string() }))
  .argv(i => ['./scripts/probe.sh', i.service])
  .runner(localRunner);

const heartbeatFlow = H.flow('heartbeat')
  .input(z.object({ service: z.string() }))
  .step('probe', probe, ctx => ({ service: ctx.unit.attributes.service }))
  .exit('healthy');

const services = ['api', 'web', 'worker'];

const heartbeats = H.lane('heartbeats', Heartbeat)
  .supply(H.clock('everyFiveMinutes').every({ minutes: 5 }), (_tick, to) =>
    services.map(service => to.create({ service })))
  .handler(heartbeatFlow, {
    during: { probe: Probing },
    exits: { healthy: Healthy },
    failure: Unhealthy,
  })
  .on(H.cancel, { enter: Withdrawn });

const heartbeatFailureFilesBug = H.trigger('heartbeatFailureFilesBug')
  .on(H.when.transition(heartbeats, { to: Unhealthy }))
  .create(bugs, e => ({
    ref: `heartbeat:${e.unit.attributes.service}`,
    title: `Service ${e.unit.attributes.service} failed its heartbeat`,
    description: `The heartbeat probe for ${e.unit.attributes.service} failed at ${e.at.toISOString()}.`,
  }));

const scheduler = H.scheduler('codingTeam')
  .priority(heartbeats, bugs, features, epics)
  .wip(bugs, 2)
  .wip(epics, 1)
  .boost(features, { afterMinutes: 240 });

const productionHealth = H.operation('productionHealth')
  .run(H.command('productionHealthProbe').argv(['./scripts/prod-health.sh']).runner(localRunner));

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
    H.ops.memoryCurate,
    H.ops.telemetryRead,
    H.ops.accountsRead,
    H.ops.accountsShare,
    productionHealth,
  ],
});

export const codingTeam = H.harness('coding-team')
  .ledger(sqlite.ledger({ path: '.harness/ledger.sqlite' }))
  .pool(claudePool)
  .lanes(heartbeats, bugs, features, epics)
  .journals(experience, taste)
  .triggers(heartbeatFailureFilesBug)
  .scheduler(scheduler)
  .clients(supervisor)
  .observers(
    markdown.board({ path: '.harness/BOARD.md' }),
    markdown.telemetry({ path: '.harness/TELEMETRY.md' }),
  );
