import { z } from 'zod';
import { H, Account } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { linear } from 'harness-dsl/linear';
import { folder } from 'harness-dsl/folder';
import { git } from 'harness-dsl/git';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

export const sharedQuota = sqlite.quota('claude-subscriptions', { path: '/var/lib/harness/shared-quota.sqlite' });

export const max1 = claudeCode.subscription('max-1', { token: H.env('CLAUDE_MAX_1_TOKEN'), quota: sharedQuota });
export const max2 = claudeCode.subscription('max-2', { token: H.env('CLAUDE_MAX_2_TOKEN'), quota: sharedQuota });
export const max3 = claudeCode.subscription('max-3', { token: H.env('CLAUDE_MAX_3_TOKEN'), quota: sharedQuota });
export const subscriptions: readonly Account[] = [max1, max2, max3];

export const sonnet = claudeCode.model('sonnet', { id: 'claude-sonnet-4-5' });
export const opus = claudeCode.model('opus', { id: 'claude-opus-4-1' });

export const soonestExpiring = H.policy.account('soonest-expiring', ctx =>
  [...ctx.candidates]
    .filter(a => a.shareUsed < a.shareCap && (a.cooldownUntil === undefined || a.cooldownUntil <= ctx.now))
    .sort((a, b) => a.windowResetsAt.getTime() - b.windowResetsAt.getTime())[0],
);

export function sharedPool(name: string, shareOfEachWindow: number) {
  return subscriptions.reduce(
    (pool, account) => pool.share(account, shareOfEachWindow),
    H.pool(name).accounts(...subscriptions).drain(soonestExpiring),
  );
}

export const builderRole = H.role('builder').intents('read', 'edit', 'run', 'halt').instructions('Implement the task in the worktree. Stop only when the checks pass.');
export const plannerRole = H.role('planner').intents('read', 'search').instructions('Decompose the epic into independently shippable features.');
export const auditorRole = H.role('auditor').intents('read', 'run', 'record').instructions('List every deficit against the task. Record lessons worth keeping.');
export const writerRole = H.role('writer').intents('read', 'edit').instructions('Revise the documentation page for accuracy and clarity.');

export const ownerTaste = H.memory('owner-taste', 'taste');
export const experience = H.memory('experience', 'experience');

export const tasteJournal = H.journal('owner-taste', ownerTaste)
  .store(jsonl.memoryStore({ path: '/var/lib/harness/owner-taste.jsonl' }))
  .recall({ by: 'specificity', limit: 12 })
  .readBy(builderRole, plannerRole, writerRole);

const WorkItem = z.object({ ticket: z.string().optional(), title: z.string(), description: z.string() });
const EpicAttrs = z.object({ ticket: z.string(), title: z.string(), description: z.string() });
const HeartbeatAttrs = z.object({ service: z.string() });
const Deficits = z.object({ deficits: z.array(z.string()) });
const FeaturePlan = z.object({ features: z.array(z.object({ title: z.string(), description: z.string() })) });

const Todo = H.state('Todo', 'pending');
const Done = H.terminal('Done', 'success');
const Unresolved = H.terminal('Unresolved', 'failure');
const WontDo = H.terminal('WontDo', 'neutral');

const EpicOpen = H.state('EpicOpen', 'pending');
const EpicDelivered = H.terminal('EpicDelivered', 'success');
const EpicAbandoned = H.terminal('EpicAbandoned', 'failure');

const HeartbeatDue = H.state('HeartbeatDue', 'pending');
const Healthy = H.terminal('Healthy', 'success');
const Unhealthy = H.terminal('Unhealthy', 'failure');

const Bug = H.kind('Bug').attributes(WorkItem).states(Todo, Done, Unresolved, WontDo).key(a => a.ticket ?? a.title).initial(Todo);
const Feature = H.kind('Feature').attributes(WorkItem).states(Todo, Done, Unresolved, WontDo).key(a => a.ticket ?? a.title).initial(Todo);
const Epic = H.kind('Epic').attributes(EpicAttrs).states(EpicOpen, EpicDelivered, EpicAbandoned).key(a => a.ticket).initial(EpicOpen);
const Heartbeat = H.kind('Heartbeat').attributes(HeartbeatAttrs).states(HeartbeatDue, Healthy, Unhealthy).key(a => a.service).initial(HeartbeatDue);

const ownerDecision = H.halt('owner-decision').decision(z.object({ choice: z.string(), note: z.string() }));

const apiAccount = anthropic.account('project-a-api', {
  apiKey: H.env('ANTHROPIC_API_KEY'),
  quota: sqlite.quota('project-a-api', { path: './project-a/api-quota.sqlite' }),
});

const poolA = sharedPool('project-a-subscriptions', 0.6).fallback(apiAccount);

const builderModel = H.policy.model('builder-model', [sonnet, opus], ctx => {
  const cheap = ctx.metrics.attempts({ of: ctx.kind, seat: ctx.seat, model: sonnet, window: { lastDays: 14 } });
  return cheap.samples >= 20 && cheap.successRate < 0.85 ? opus : sonnet;
});

const projectChecks = H.command('project-checks').argv(['npm', 'run', 'check']);
const worktree = git.worktree('project-a-worktree', { repo: '.', base: 'main' }).leaseFiles().exitCheck(projectChecks);

const builder = H.seat('builder').role(builderRole).model(builderModel).pool(poolA).runner(worktree).halts(ownerDecision);
const auditor = H.seat('auditor').role(auditorRole).model(opus).pool(poolA).runner(worktree).output(Deficits);
const planner = H.seat('planner').role(plannerRole).model(opus).pool(poolA).output(FeaturePlan);

const experienceA = H.journal('project-a-experience', experience)
  .store(jsonl.memoryStore({ path: './project-a/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 8 })
  .readBy(builderRole, auditorRole)
  .recordedBy(auditorRole);

const buildAndAudit = H.flow('build-and-audit')
  .input(WorkItem)
  .params(z.object({ rounds: z.number() }))
  .loop('rounds', Deficits, f => f
    .step('build', builder, ctx => ({
      task: `${ctx.unit.attributes.title}\n\n${ctx.unit.attributes.description}\n\nDeficits from earlier rounds:\n${ctx.steps.rounds.flatMap(r => r.deficits).join('\n')}`,
    }))
    .step('audit', auditor, ctx => ({ task: `Audit the change for: ${ctx.unit.attributes.title}\n\nBuilder report:\n${ctx.steps.build}` })),
    {
      max: ctx => ctx.params.rounds,
      until: ctx => ctx.steps.audit.deficits.length === 0,
      keep: ctx => ctx.steps.audit,
    })
  .exit('done', ctx => ctx.steps.audit.deficits.length === 0)
  .exit('outOfRounds');

const trackerKey = H.env('LINEAR_API_KEY');
const tracker = linear.store({ apiKey: trackerKey, team: 'PROD', workflow: ['Todo', 'In Progress', 'Done', 'Canceled'] });

const bugLane = H.lane('bugs', Bug)
  .supply(linear.issues({ apiKey: trackerKey, team: 'PROD', labels: ['bug'] }), (issue, to) =>
    to.create({ ticket: issue.identifier, title: issue.title, description: issue.description }))
  .supply(folder.files({ path: './bugs', glob: '*.md' }), (file, to) => to.create({ title: file.name, description: file.body }))
  .supply(H.operator)
  .handler(buildAndAudit, { exits: { done: Done, outOfRounds: Unresolved }, params: { rounds: 3 } })
  .store(tracker, { states: { Todo: 'Todo', Done: 'Done', Unresolved: 'Canceled', WontDo: 'Canceled' }, inFlight: 'In Progress' })
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 60_000, exhausted: Unresolved })
  .on(H.cancel, { enter: WontDo });

const featureLane = H.lane('features', Feature)
  .supply(linear.issues({ apiKey: trackerKey, team: 'PROD', labels: ['feature'] }), (issue, to) =>
    to.create({ ticket: issue.identifier, title: issue.title, description: issue.description }))
  .supply(H.operator)
  .handler(buildAndAudit, { exits: { done: Done, outOfRounds: Unresolved }, params: { rounds: 5 } })
  .store(tracker, { states: { Todo: 'Todo', Done: 'Done', Unresolved: 'Canceled', WontDo: 'Canceled' }, inFlight: 'In Progress' })
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 60_000, exhausted: Unresolved })
  .on(H.cancel, { enter: WontDo });

const epicFlow = H.flow('epic')
  .input(EpicAttrs)
  .step('plan', planner, ctx => ({ task: `Decompose epic ${ctx.unit.attributes.title}:\n${ctx.unit.attributes.description}` }))
  .spawn('features', featureLane, ctx => ctx.steps.plan.features.map(f => ({ title: f.title, description: f.description })))
  .exit('delivered', ctx => ctx.steps.features.every(c => c.verdict === 'success'))
  .exit('abandoned');

const epicLane = H.lane('epics', Epic)
  .supply(linear.issues({ apiKey: trackerKey, team: 'PROD', labels: ['epic'] }), (issue, to) =>
    to.create({ ticket: issue.identifier, title: issue.title, description: issue.description }))
  .handler(epicFlow, { exits: { delivered: EpicDelivered, abandoned: EpicAbandoned } })
  .store(tracker, { states: { EpicOpen: 'Todo', EpicDelivered: 'Done', EpicAbandoned: 'Canceled' }, inFlight: 'In Progress' })
  .retry({ maxAttempts: 2, exhausted: EpicAbandoned });

const localRunner = local.runner('project-a-local');
const probe = H.command('service-probe')
  .input(HeartbeatAttrs)
  .argv(i => ['./scripts/probe.sh', i.service])
  .runner(localRunner);

const heartbeatFlow = H.flow('heartbeat')
  .input(HeartbeatAttrs)
  .step('probe', probe, ctx => ({ service: ctx.unit.attributes.service }))
  .exit('healthy');

const heartbeatLane = H.lane('heartbeats', Heartbeat)
  .supply(H.clock('every-five-minutes').every({ minutes: 5 }), (_tick, to) => ['api', 'worker'].map(service => to.create({ service })))
  .handler(heartbeatFlow, { exits: { healthy: Healthy } })
  .retry({ maxAttempts: 1, exhausted: Unhealthy });

const heartbeatFailureFilesBug = H.trigger('heartbeat-failure-files-bug')
  .on(H.when.transition(heartbeatLane, { to: Unhealthy }))
  .create(bugLane, ev => ({
    title: `Heartbeat failed: ${ev.unit.attributes.service}`,
    description: `The ${ev.unit.attributes.service} heartbeat failed at ${ev.at.toISOString()}.`,
  }));

const productionProbe = H.operation('production-health-probe', H.command('production-probe').argv(['./scripts/prod-health.sh']).runner(localRunner));

const supervisorA = claudeCode.supervisor('project-a-supervisor', {
  port: H.slot.port(1),
  grants: [
    H.ops.workRead, H.ops.workCreate, H.ops.workUpdate, H.ops.workCancel,
    H.ops.resolve(ownerDecision), H.ops.memoryWrite, H.ops.telemetryRead,
    H.ops.accountsRead, H.ops.accountsShare, productionProbe,
  ],
});

export const harnessA = H.harness('project-a')
  .ledger(sqlite.ledger({ path: './project-a/ledger.sqlite' }))
  .lanes(heartbeatLane, bugLane, featureLane, epicLane)
  .journals(tasteJournal, experienceA)
  .triggers(heartbeatFailureFilesBug)
  .scheduler(H.scheduler('project-a')
    .expedite(heartbeatLane)
    .standard(bugLane, featureLane, epicLane)
    .wip(bugLane, 2)
    .wip(epicLane, 1)
    .aging(featureLane, { afterMinutes: 240 }))
  .clients(supervisorA)
  .observers(markdown.board({ path: './project-a/BOARD.md' }), markdown.telemetry({ path: './project-a/TELEMETRY.md' }));

const DocPageAttrs = z.object({ path: z.string(), title: z.string(), body: z.string() });
const DocQueued = H.state('DocQueued', 'pending');
const Published = H.terminal('Published', 'success');
const Broken = H.terminal('Broken', 'failure');
const DocPage = H.kind('DocPage').attributes(DocPageAttrs).states(DocQueued, Published, Broken).key(a => a.path).initial(DocQueued);

const poolB = sharedPool('project-b-subscriptions', 0.3);
const docsWorktree = git.worktree('docs-worktree', { repo: '../docs', base: 'main' });
const writer = H.seat('writer').role(writerRole).model(sonnet).pool(poolB).runner(docsWorktree);
const linkCheck = H.command('link-check').input(z.object({ path: z.string() })).argv(i => ['npx', 'linkinator', i.path]).runner(docsWorktree);

const experienceB = H.journal('project-b-experience', experience)
  .store(jsonl.memoryStore({ path: '../docs/.harness/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 8 })
  .readBy(writerRole)
  .recordedBy(writerRole);

const docFlow = H.flow('write-doc')
  .input(DocPageAttrs)
  .step('write', writer, ctx => ({ task: `Revise ${ctx.unit.attributes.path} (${ctx.unit.attributes.title}).` }))
  .step('linkCheck', linkCheck, ctx => ({ path: ctx.unit.attributes.path }))
  .exit('published');

const docLane = H.lane('docs', DocPage)
  .supply(folder.files({ path: '../docs/pages', glob: '**/*.md' }), (file, to) => to.create({ path: file.path, title: file.name, body: file.body }))
  .handler(docFlow, { exits: { published: Published } })
  .store(folder.frontmatter({ path: '../docs/pages' }))
  .retry({ maxAttempts: 2, exhausted: Broken });

const supervisorB = claudeCode.supervisor('project-b-supervisor', {
  port: H.slot.port(2),
  grants: [H.ops.workRead, H.ops.workCreate, H.ops.memoryWrite, H.ops.telemetryRead, H.ops.accountsRead, H.ops.accountsShare],
});

export const harnessB = H.harness('project-b')
  .ledger(sqlite.ledger({ path: '../docs/.harness/ledger.sqlite' }))
  .lanes(docLane)
  .journals(tasteJournal, experienceB)
  .scheduler(H.scheduler('project-b').standard(docLane))
  .clients(supervisorB)
  .observers(markdown.board({ path: '../docs/.harness/BOARD.md' }));

export const ownerSession = claudeCode.session('owner', { endpoints: [supervisorA, supervisorB] });
