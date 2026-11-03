import { z } from 'zod';
import { H } from 'harness-dsl';
import type { AccountState, Pool, Role } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { linear } from 'harness-dsl/linear';
import { folder } from 'harness-dsl/folder';
import { git } from 'harness-dsl/git';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const ownerHome = '/home/owner/.harness';

const sharedQuota = sqlite.quota({ path: `${ownerHome}/accounts.sqlite` });

const subscriptionOne = claudeCode.subscription('claude-max-1', { token: H.env('CLAUDE_MAX_1_TOKEN') });
const subscriptionTwo = claudeCode.subscription('claude-max-2', { token: H.env('CLAUDE_MAX_2_TOKEN') });
const subscriptionThree = claudeCode.subscription('claude-max-3', { token: H.env('CLAUDE_MAX_3_TOKEN') });
const subscriptions = [subscriptionOne, subscriptionTwo, subscriptionThree];
const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });

const sonnet = claudeCode.model('sonnet', { id: 'claude-sonnet-4' });
const opus = claudeCode.model('opus', { id: 'claude-opus-4' });

const soonestExpiring = H.policy.account('soonest-expiring', ctx =>
  ctx.candidates
    .filter(account => (account.cooldownUntil === undefined || account.cooldownUntil <= ctx.now) && account.shareUsed < account.shareCap)
    .reduce<AccountState | undefined>(
      (best, account) => (best === undefined || account.windowResetsAt < best.windowResetsAt ? account : best),
      undefined,
    ),
);

function sharedSubscriptionPool(name: string, shareOfWindow: number): Pool {
  return subscriptions.reduce(
    (pool, account) => pool.share(account, shareOfWindow),
    H.pool(name).accounts(...subscriptions).drain(soonestExpiring).fallback(apiAccount),
  );
}

const ownerTaste = H.memory('owner-taste').trust('taste');
const ownerTasteStore = jsonl.memoryStore({ path: `${ownerHome}/taste.jsonl` });
const ownerTasteRecall = H.recall('owner-taste-recall', { by: 'specificity', limit: 12 });

function ownerTastePlaybook(...readers: Role[]) {
  return H.playbook('owner-taste', ownerTaste).store(ownerTasteStore).recall(ownerTasteRecall).readBy(...readers);
}

const ownerGrants = [
  H.ops.workRead,
  H.ops.workCreate,
  H.ops.workUpdate,
  H.ops.blockersResolve,
  H.ops.memoryRead,
  H.ops.memoryWrite,
  H.ops.memoryCurate,
  H.ops.telemetryRead,
  H.ops.accountsRead,
  H.ops.accountsShare,
];

const productRepo = '/work/product';
const productRunner = local.runner('product-local').slots(3);

const workAttributes = z.object({
  title: z.string(),
  description: z.string(),
  origin: z.enum(['tracker', 'folder', 'operator', 'heartbeat', 'epic']),
  reference: z.string(),
});
type WorkAttributes = z.infer<typeof workAttributes>;

const Triage = H.state('Triage', 'pending');
const Building = H.state('Building', 'active');
const Auditing = H.state('Auditing', 'active');
const Done = H.state('Done', 'terminal', 'success');
const Abandoned = H.state('Abandoned', 'terminal', 'failure');

const Bug = H.kind('Bug').attributes(workAttributes).states(Triage, Building, Auditing, Done, Abandoned).key(work => work.reference);
const Feature = H.kind('Feature').attributes(workAttributes).states(Triage, Building, Auditing, Done, Abandoned).key(work => work.reference);

const epicAttributes = z.object({ title: z.string(), description: z.string(), reference: z.string() });
const EpicOpen = H.state('EpicOpen', 'pending');
const Planning = H.state('Planning', 'active');
const Decomposed = H.state('Decomposed', 'waiting');
const EpicComplete = H.state('EpicComplete', 'terminal', 'success');
const EpicIncomplete = H.state('EpicIncomplete', 'terminal', 'failure');
const Epic = H.kind('Epic').attributes(epicAttributes).states(EpicOpen, Planning, Decomposed, EpicComplete, EpicIncomplete).key(epic => epic.reference);

const heartbeatAttributes = z.object({ service: z.string(), at: z.string() });
const HeartbeatDue = H.state('HeartbeatDue', 'pending');
const Probing = H.state('Probing', 'active');
const Healthy = H.state('Healthy', 'terminal', 'success');
const Unhealthy = H.state('Unhealthy', 'terminal', 'failure');
const ServiceHeartbeat = H.kind('ServiceHeartbeat').attributes(heartbeatAttributes).states(HeartbeatDue, Probing, Healthy, Unhealthy).key(beat => `${beat.service}@${beat.at}`);

const builderRole = H.role('builder').intents('read', 'edit', 'run', 'search', 'halt').instructions('Implement the change with tests. Halt for the owner when a product decision is needed.');
const auditorRole = H.role('auditor').intents('read', 'run', 'search', 'record').instructions('List every deficit against the task. Record forward-phrased lessons.');
const plannerRole = H.role('planner').intents('read', 'search').instructions('Decompose the epic into independently shippable features.');

const builderModel = H.policy.model('builder-model', [sonnet, opus], ctx => {
  const cheaper = ctx.metrics.outcomes({ of: ctx.lane, model: sonnet, windowDays: 14 }).attempts;
  return cheaper.samples >= 20 && cheaper.successRate < 0.85 ? opus : sonnet;
});

const projectChecks = H.command('project-checks').argv(['npm', 'run', 'check']).runner(productRunner);

const builder = H.agent('builder')
  .role(builderRole)
  .model(builderModel)
  .workspace(git.worktree({ repo: productRepo, base: 'main' }))
  .guards(H.guard.lease(), H.guard.beforeStop(projectChecks))
  .budgetTokens(400_000);

const auditor = H.agent('auditor')
  .role(auditorRole)
  .model(opus)
  .output(z.object({ deficits: z.array(z.string()) }));

const planner = H.agent('planner')
  .role(plannerRole)
  .model(opus)
  .output(z.object({ features: z.array(z.object({ title: z.string(), description: z.string() })) }));

const delivery = H.flow('delivery')
  .input(workAttributes)
  .params(z.object({ rounds: z.number() }))
  .loop('rounds', flow => flow
    .step('build', builder, ctx => ({
      task: `${ctx.unit.attributes.title}\n\n${ctx.unit.attributes.description}`,
      resources: [productRepo],
    }), { restart: 'ask' })
    .step('audit', auditor, ctx => ({
      task: `Audit the change for ${ctx.unit.attributes.reference}: ${ctx.unit.attributes.title}`,
      resources: [productRepo],
    }), { restart: 'ask' }),
  {
    max: ctx => ctx.params.rounds,
    until: ctx => ctx.steps.audit.deficits.length === 0,
  })
  .exit('delivered', ctx => ctx.steps.audit.deficits.length === 0)
  .exit('exhausted');

const linearKey = H.env('LINEAR_API_KEY');
const trackerStates = { Triage: 'Triage', Building: 'In Progress', Auditing: 'In Review', Done: 'Done', Abandoned: 'Canceled' };
const trackerStore = linear.store({ apiKey: linearKey, team: 'PROD', states: trackerStates });

const deliveryMap = {
  exits: { delivered: Done, exhausted: Abandoned },
  during: { build: Building, audit: Auditing },
};

const bugLane = H.lane('bugs', Bug)
  .supply(linear.issues({ apiKey: linearKey, team: 'PROD', labels: ['bug'] }), (issue, to) =>
    to.create({ title: issue.title, description: issue.description, origin: 'tracker', reference: issue.identifier }))
  .supply(folder.files({ path: `${productRepo}/bugs`, glob: '*.md' }), (file, to) =>
    to.create({ title: file.name, description: file.body, origin: 'folder', reference: file.path }))
  .supply(H.operator)
  .store(trackerStore)
  .handler(delivery, { ...deliveryMap, params: { rounds: 3 } });

const featureLane = H.lane('features', Feature)
  .supply(linear.issues({ apiKey: linearKey, team: 'PROD', labels: ['feature'] }), (issue, to) =>
    to.create({ title: issue.title, description: issue.description, origin: 'tracker', reference: issue.identifier }))
  .supply(H.operator)
  .store(trackerStore)
  .handler(delivery, { ...deliveryMap, params: { rounds: 5 } });

function epicFeature(epicReference: string, index: number, title: string, description: string): WorkAttributes {
  return { title, description, origin: 'epic', reference: `${epicReference}/${index + 1}` };
}

const epicFlow = H.flow('epic-decomposition')
  .input(epicAttributes)
  .step('plan', planner, ctx => ({ task: `Decompose epic ${ctx.unit.attributes.reference}: ${ctx.unit.attributes.title}\n\n${ctx.unit.attributes.description}` }))
  .spawn('features', featureLane, ctx =>
    ctx.steps.plan.features.map((feature, index) => epicFeature(ctx.unit.attributes.reference, index, feature.title, feature.description)))
  .exit('complete', ctx => ctx.steps.features.every(child => child.verdict === 'success'))
  .exit('incomplete');

const epicLane = H.lane('epics', Epic)
  .supply(linear.issues({ apiKey: linearKey, team: 'PROD', labels: ['epic'] }), (issue, to) =>
    to.create({ title: issue.title, description: issue.description, reference: issue.identifier }))
  .store(trackerStore)
  .handler(epicFlow, {
    exits: { complete: EpicComplete, incomplete: EpicIncomplete },
    during: { plan: Planning, features: Decomposed },
  });

const probeService = H.command('probe-service')
  .input(z.object({ service: z.string() }))
  .argv(input => ['probe-service', input.service])
  .runner(productRunner);

const heartbeatFlow = H.flow('heartbeat')
  .input(heartbeatAttributes)
  .step('probe', probeService, ctx => ({ service: ctx.unit.attributes.service }), { restart: 'rerun', timeoutMs: 30_000 })
  .exit('healthy', ctx => ctx.steps.probe.exitCode === 0)
  .exit('unhealthy');

const heartbeatLane = H.lane('heartbeats', ServiceHeartbeat)
  .supply(H.clock('every-five-minutes').every({ minutes: 5 }), (tick, to) =>
    to.create({ service: 'product-api', at: tick.at.toISOString() }))
  .handler(heartbeatFlow, {
    exits: { healthy: Healthy, unhealthy: Unhealthy },
    during: { probe: Probing },
  });

const unhealthyServiceBecomesBug = H.trigger('unhealthy-service-becomes-bug')
  .on(H.when.transition(heartbeatLane, { to: Unhealthy }))
  .create(bugLane, (event): WorkAttributes => ({
    title: `${event.unit.attributes.service} failed its heartbeat`,
    description: `The heartbeat at ${event.unit.attributes.at} failed.`,
    origin: 'heartbeat',
    reference: `heartbeat/${event.unit.attributes.service}`,
  }));

const codingExperience = H.memory('coding-experience').trust('experience');
const codingExperiencePlaybook = H.playbook('coding-experience', codingExperience)
  .store(jsonl.memoryStore({ path: `${productRepo}/.harness/experience.jsonl` }))
  .recall(H.recall('coding-experience-recall', { by: 'specificity', limit: 10 }))
  .readBy(builderRole, auditorRole)
  .recordedBy(auditorRole);

const productionHealthProbe = H.operation('production-health-probe').run(
  H.command('production-health-probe').argv(['probe-service', 'product-api', '--production']).runner(productRunner),
);

const productScheduler = H.scheduler('product')
  .priority(heartbeatLane, bugLane, featureLane, epicLane)
  .wip(bugLane, 2)
  .wip(epicLane, 1)
  .boost(featureLane, { afterMinutes: 240 });

export const projectA = H.harness('product')
  .ledger(sqlite.ledger({ path: `${productRepo}/.harness/ledger.sqlite` }))
  .quota(sharedQuota)
  .pools(sharedSubscriptionPool('product-subscriptions', 0.6))
  .lanes(heartbeatLane, bugLane, featureLane, epicLane)
  .playbooks(codingExperiencePlaybook, ownerTastePlaybook(builderRole, plannerRole))
  .triggers(unhealthyServiceBecomesBug)
  .scheduler(productScheduler)
  .clients(claudeCode.supervisor('owner-supervisor-product', {
    grants: [...ownerGrants, productionHealthProbe],
    endpoint: 'product',
  }))
  .observers(
    markdown.board({ path: `${productRepo}/BOARD.md` }),
    markdown.telemetry({ path: `${productRepo}/TELEMETRY.md` }),
  );

const docsRepo = '/work/docs';
const docsRunner = local.runner('docs-local').slots(2);

const docPageAttributes = z.object({ path: z.string(), title: z.string(), body: z.string() });
const Stale = H.state('Stale', 'pending');
const Writing = H.state('Writing', 'active');
const Checking = H.state('Checking', 'active');
const Published = H.state('Published', 'terminal', 'success');
const BrokenLinks = H.state('BrokenLinks', 'terminal', 'failure');
const DocPage = H.kind('DocPage').attributes(docPageAttributes).states(Stale, Writing, Checking, Published, BrokenLinks).key(page => page.path);

const writerRole = H.role('writer').intents('read', 'edit', 'record').instructions('Bring the page up to date with the product. Keep every link valid.');
const writer = H.agent('writer').role(writerRole).model(sonnet).budgetTokens(120_000);

const linkCheck = H.command('link-check')
  .input(z.object({ path: z.string() }))
  .argv(input => ['link-check', input.path])
  .runner(docsRunner);

const docFlow = H.flow('doc-page')
  .input(docPageAttributes)
  .step('write', writer, ctx => ({ task: `Update ${ctx.unit.attributes.title} at ${ctx.unit.attributes.path}`, resources: [ctx.unit.attributes.path] }), { restart: 'ask' })
  .step('linkCheck', linkCheck, ctx => ({ path: ctx.unit.attributes.path }), { restart: 'rerun' })
  .exit('published', ctx => ctx.steps.linkCheck.exitCode === 0)
  .exit('brokenLinks');

const docLane = H.lane('doc-pages', DocPage)
  .supply(folder.files({ path: `${docsRepo}/content`, glob: '**/*.md' }), (file, to) =>
    to.create({ path: file.path, title: file.name, body: file.body }))
  .store(folder.frontmatter({ path: `${docsRepo}/content` }))
  .handler(docFlow, {
    exits: { published: Published, brokenLinks: BrokenLinks },
    during: { write: Writing, linkCheck: Checking },
  });

const docsExperience = H.memory('docs-experience').trust('experience');
const docsExperiencePlaybook = H.playbook('docs-experience', docsExperience)
  .store(jsonl.memoryStore({ path: `${docsRepo}/.harness/experience.jsonl` }))
  .recall(H.recall('docs-experience-recall', { by: 'specificity', limit: 8 }))
  .readBy(writerRole)
  .recordedBy(writerRole);

export const projectB = H.harness('docs')
  .ledger(sqlite.ledger({ path: `${docsRepo}/.harness/ledger.sqlite` }))
  .quota(sharedQuota)
  .pools(sharedSubscriptionPool('docs-subscriptions', 0.3))
  .lanes(docLane)
  .playbooks(docsExperiencePlaybook, ownerTastePlaybook(writerRole))
  .scheduler(H.scheduler('docs').priority(docLane).wip(docLane, 2))
  .clients(claudeCode.supervisor('owner-supervisor-docs', { grants: ownerGrants, endpoint: 'docs' }))
  .observers(
    markdown.board({ path: `${docsRepo}/BOARD.md` }),
    markdown.telemetry({ path: `${docsRepo}/TELEMETRY.md` }),
  );

export const startProjectA = () => projectA.start();
export const startProjectB = () => projectB.start();
