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

const sharedQuota = sqlite.quota('owner-claude-quota', { path: '~/.harness-shared/quota.sqlite' });
const sharedClaudeA = claudeCode.subscription('claude-a', { token: H.env('CLAUDE_A_TOKEN'), quota: sharedQuota });
const sharedClaudeB = claudeCode.subscription('claude-b', { token: H.env('CLAUDE_B_TOKEN'), quota: sharedQuota });
const sharedClaudeC = claudeCode.subscription('claude-c', { token: H.env('CLAUDE_C_TOKEN'), quota: sharedQuota });
const sharedSonnet = claudeCode.model('sonnet', { id: 'claude-sonnet-4-5' });
const sharedOpus = claudeCode.model('opus', { id: 'claude-opus-4-1' });

const sharedSoonestExpiring = H.policy.account('soonest-expiring', ({ candidates, now }) =>
  candidates
    .filter(c => (c.cooldownUntil === undefined || c.cooldownUntil.getTime() <= now.getTime()) && c.shareUsed < c.shareCap)
    .reduce<AccountState | undefined>(
      (best, c) => (best === undefined || c.windowResetsAt.getTime() < best.windowResetsAt.getTime() ? c : best),
      undefined,
    ),
);

const sharedBuilderRole = H.role('builder').intents('read', 'edit', 'run', 'search').instructions('Implement the change; stop only when checks pass.');
const sharedAuditorRole = H.role('auditor').intents('read', 'run', 'search', 'record').instructions('Find every deficit in the change.');
const sharedPlannerRole = H.role('planner').intents('read', 'search').instructions('Decompose an epic into independent features.');
const sharedWriterRole = H.role('writer').intents('read', 'edit').instructions('Write clear documentation pages.');

const sharedTaste = H.memory('taste', 'taste');
const sharedExperience = H.memory('experience', 'experience');
const sharedTasteJournal = H.journal('owner-taste', sharedTaste)
  .store(jsonl.memoryStore({ path: '~/.harness-shared/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 10 })
  .readBy(sharedBuilderRole, sharedPlannerRole, sharedWriterRole);

const sharedResumeWork = H.signal('resume-work');
const sharedOwnerSession = claudeCode.supervisor('owner');

const productQuota = sqlite.quota('product-api-quota', { path: 'product/.harness/api-quota.sqlite' });
const productApi = anthropic.account('product-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota: productQuota });
const productPool = H.pool('product-claude')
  .accounts(sharedClaudeA, sharedClaudeB, sharedClaudeC)
  .share(sharedClaudeA, 0.6)
  .share(sharedClaudeB, 0.6)
  .share(sharedClaudeC, 0.6)
  .drain(sharedSoonestExpiring)
  .fallback(productApi);

const productExperience = H.journal('product-experience', sharedExperience)
  .store(jsonl.memoryStore({ path: 'product/.harness/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 8 })
  .readBy(sharedBuilderRole, sharedAuditorRole)
  .recordedBy(sharedAuditorRole);

const productRunner = local.runner('product-local').slots(4);
const projectChecks = H.command('project-checks').argv(['npm', 'run', 'check']).runner(productRunner);
const ownerDecision = H.halt('owner-decision').decision(z.object({ choice: z.string(), note: z.string() }));

const builderModel = H.policy.model('builder-model', [sharedSonnet, sharedOpus], ({ kind, seat, metrics }) => {
  const cheap = metrics.attempts({ of: kind, seat, model: sharedSonnet, window: { lastDays: 14 } });
  return cheap.samples >= 20 && cheap.successRate < 0.85 ? sharedOpus : sharedSonnet;
});

const builder = H.seat('builder')
  .role(sharedBuilderRole)
  .model(builderModel)
  .pool(productPool)
  .workspace(git.worktree({ repo: '.', base: 'main' }))
  .guard({ leaseFiles: true, beforeStop: projectChecks })
  .halts(ownerDecision);

const auditor = H.seat('auditor')
  .role(sharedAuditorRole)
  .model(sharedOpus)
  .pool(productPool)
  .output(z.object({ deficits: z.array(z.string()) }));

const workItem = z.object({ externalId: z.string(), title: z.string(), description: z.string() });

const planner = H.seat('planner')
  .role(sharedPlannerRole)
  .model(sharedOpus)
  .pool(productPool)
  .output(z.object({ features: z.array(workItem) }));

const Queued = H.state('queued', 'pending');
const Building = H.state('building', 'active');
const Auditing = H.state('auditing', 'active');
const Planning = H.state('planning', 'active');
const Delivering = H.state('delivering', 'waiting');
const Stuck = H.state('stuck', 'waiting');
const Done = H.terminal('done', 'success');
const Dropped = H.terminal('dropped', 'neutral');
const Due = H.state('due', 'pending');
const Probing = H.state('probing', 'active');
const Healthy = H.terminal('healthy', 'success');
const Unhealthy = H.terminal('unhealthy', 'failure');

const Bug = H.kind('Bug').attributes(workItem).states(Queued, Building, Auditing, Stuck, Done, Dropped).key(a => a.externalId);
const Feature = H.kind('Feature').attributes(workItem).states(Queued, Building, Auditing, Stuck, Done, Dropped).key(a => a.externalId);
const Epic = H.kind('Epic').attributes(workItem).states(Queued, Planning, Delivering, Stuck, Done, Dropped).key(a => a.externalId);
const heartbeatAttrs = z.object({ service: z.string(), tick: z.string() });
const Heartbeat = H.kind('Heartbeat').attributes(heartbeatAttrs).states(Due, Probing, Healthy, Unhealthy).key(a => `${a.service}@${a.tick}`);

const buildAndAudit = H.flow('build-and-audit')
  .input(workItem)
  .params(z.object({ rounds: z.number() }))
  .loop(
    'rounds',
    round =>
      round
        .step('build', builder, ctx => ({ task: `Implement ${ctx.unit.attributes.title}: ${ctx.unit.attributes.description}` }))
        .step('audit', auditor, ctx => ({ task: `Audit the work on ${ctx.unit.attributes.title} and list every remaining deficit.` })),
    { max: ctx => ctx.params.rounds, until: ctx => ctx.steps.audit.deficits.length === 0 },
  )
  .exit('clean', ctx => ctx.steps.audit.deficits.length === 0)
  .exit('roundsSpent');

const trackerKey = H.env('LINEAR_API_KEY');
const trackerStore = linear.store({
  apiKey: trackerKey,
  team: 'PROD',
  workflow: ['Todo', 'In Progress', 'In Review', 'Blocked', 'Done', 'Canceled'],
});

const bugLane = H.lane('bugs', Bug)
  .supply(linear.issues({ apiKey: trackerKey, team: 'PROD', labels: ['bug'] }), (issue, to) =>
    to.create({ externalId: issue.identifier, title: issue.title, description: issue.description }),
  )
  .supply(folder.files({ path: 'bugs', glob: '*.md' }), (file, to) =>
    to.create({ externalId: file.path, title: file.name, description: file.body }),
  )
  .supply(H.operator)
  .store(trackerStore, { queued: 'Todo', building: 'In Progress', auditing: 'In Review', stuck: 'Blocked', done: 'Done', dropped: 'Canceled' })
  .handler(buildAndAudit, { params: { rounds: 3 }, exits: { clean: Done, roundsSpent: Stuck }, during: { build: Building, audit: Auditing } })
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 60_000, exhausted: Stuck })
  .on(sharedResumeWork, { enter: Queued })
  .on(H.cancel, { enter: Dropped });

const featureLane = H.lane('features', Feature)
  .supply(linear.issues({ apiKey: trackerKey, team: 'PROD', labels: ['feature'] }), (issue, to) =>
    to.create({ externalId: issue.identifier, title: issue.title, description: issue.description }),
  )
  .supply(H.operator)
  .store(trackerStore, { queued: 'Todo', building: 'In Progress', auditing: 'In Review', stuck: 'Blocked', done: 'Done', dropped: 'Canceled' })
  .handler(buildAndAudit, { params: { rounds: 5 }, exits: { clean: Done, roundsSpent: Stuck }, during: { build: Building, audit: Auditing } })
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 60_000, exhausted: Stuck })
  .on(sharedResumeWork, { enter: Queued })
  .on(H.cancel, { enter: Dropped });

const decomposeEpic = H.flow('decompose-epic')
  .input(workItem)
  .step('plan', planner, ctx => ({ task: `Decompose ${ctx.unit.attributes.title} into features: ${ctx.unit.attributes.description}` }))
  .spawn('features', featureLane, ctx => ctx.steps.plan.features)
  .exit('delivered', ctx => ctx.steps.features.every(f => f.verdict === 'success'))
  .exit('partial');

const epicLane = H.lane('epics', Epic)
  .supply(linear.issues({ apiKey: trackerKey, team: 'PROD', labels: ['epic'] }), (issue, to) =>
    to.create({ externalId: issue.identifier, title: issue.title, description: issue.description }),
  )
  .store(trackerStore, { queued: 'Todo', planning: 'In Progress', delivering: 'In Review', stuck: 'Blocked', done: 'Done', dropped: 'Canceled' })
  .handler(decomposeEpic, { exits: { delivered: Done, partial: Stuck }, during: { plan: Planning, features: Delivering } })
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 300_000, exhausted: Stuck })
  .on(sharedResumeWork, { enter: Queued })
  .on(H.cancel, { enter: Dropped });

const probeService = H.command('probe-service')
  .input(z.object({ service: z.string() }))
  .argv(i => ['./scripts/probe', i.service])
  .runner(productRunner);

const heartbeatFlow = H.flow('heartbeat')
  .input(heartbeatAttrs)
  .step('probe', probeService, ctx => ({ service: ctx.unit.attributes.service }))
  .exit('healthy');

const heartbeatLane = H.lane('heartbeats', Heartbeat)
  .supply(H.clock('every-five-minutes').every({ minutes: 5 }), (tick, to) => to.create({ service: 'api', tick: tick.at.toISOString() }))
  .handler(heartbeatFlow, { exits: { healthy: Healthy }, during: { probe: Probing } })
  .retry({ maxAttempts: 1, backoff: 'fixed', initialDelayMs: 0, exhausted: Unhealthy });

const unhealthyServiceFilesBug = H.trigger('unhealthy-service-files-bug')
  .on(H.when.transition(heartbeatLane, Unhealthy))
  .create(bugLane, e => ({
    externalId: `heartbeat:${e.unit.attributes.service}:${e.unit.attributes.tick}`,
    title: `${e.unit.attributes.service} heartbeat failed`,
    description: `The probe of ${e.unit.attributes.service} failed at ${e.at.toISOString()}.`,
  }));

const productionHealth = H.operation(
  'production-health',
  H.command('production-health-probe').argv(['./scripts/prod-health']).runner(productRunner),
);

const productControl = sharedOwnerSession.client('product-control', {
  port: H.slot.port(1),
  grants: [
    H.ops.workRead,
    H.ops.workCreate,
    H.ops.signal(H.cancel),
    H.ops.signal(sharedResumeWork),
    H.ops.resolve(ownerDecision),
    H.ops.memoryRead,
    H.ops.memoryWrite,
    H.ops.telemetryRead,
    H.ops.accountsRead,
    H.ops.accountsShare,
    productionHealth,
  ],
});

export const product = H.harness('product')
  .ledger(sqlite.ledger({ path: 'product/.harness/ledger.sqlite' }))
  .lanes(heartbeatLane, bugLane, featureLane, epicLane)
  .journals(sharedTasteJournal, productExperience)
  .triggers(unhealthyServiceFilesBug)
  .scheduler(
    H.scheduler('product-scheduler')
      .priority(heartbeatLane, bugLane, featureLane, epicLane)
      .wip(bugLane, 2)
      .wip(epicLane, 1)
      .boost(featureLane, { afterMinutes: 120 }),
  )
  .clients(productControl)
  .observers(markdown.board({ path: 'product/BOARD.md' }), markdown.telemetry({ path: 'product/TELEMETRY.md' }));

const docsPool = H.pool('docs-claude')
  .accounts(sharedClaudeA, sharedClaudeB, sharedClaudeC)
  .share(sharedClaudeA, 0.3)
  .share(sharedClaudeB, 0.3)
  .share(sharedClaudeC, 0.3)
  .drain(sharedSoonestExpiring);

const docsExperience = H.journal('docs-experience', sharedExperience)
  .store(jsonl.memoryStore({ path: 'docs/.harness/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 8 })
  .readBy(sharedWriterRole)
  .recordedBy(sharedWriterRole);

const docPageAttrs = z.object({ path: z.string(), title: z.string(), body: z.string() });
const PageDraft = H.state('page-draft', 'pending');
const PageWriting = H.state('page-writing', 'active');
const PageChecking = H.state('page-checking', 'active');
const PageNeedsEditor = H.state('page-needs-editor', 'waiting');
const PagePublished = H.terminal('page-published', 'success');
const PageRetired = H.terminal('page-retired', 'neutral');

const DocPage = H.kind('DocPage')
  .attributes(docPageAttrs)
  .states(PageDraft, PageWriting, PageChecking, PageNeedsEditor, PagePublished, PageRetired)
  .key(a => a.path);

const writer = H.seat('writer').role(sharedWriterRole).model(sharedSonnet).pool(docsPool);
const docsRunner = local.runner('docs-local').slots(2);
const linkCheck = H.command('link-check')
  .input(z.object({ path: z.string() }))
  .argv(i => ['./scripts/link-check', i.path])
  .runner(docsRunner);

const writeAndCheck = H.flow('write-and-check')
  .input(docPageAttrs)
  .step('write', writer, ctx => ({ task: `Revise the page ${ctx.unit.attributes.path} titled ${ctx.unit.attributes.title}.` }))
  .step('link-check', linkCheck, ctx => ({ path: ctx.unit.attributes.path }))
  .exit('published');

const docsLane = H.lane('docs', DocPage)
  .supply(folder.files({ path: 'docs', glob: '**/*.md' }), (file, to) => to.create({ path: file.path, title: file.name, body: file.body }))
  .store(folder.frontmatter({ path: 'docs' }))
  .handler(writeAndCheck, { exits: { published: PagePublished }, during: { write: PageWriting, 'link-check': PageChecking } })
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 60_000, exhausted: PageNeedsEditor })
  .on(sharedResumeWork, { enter: PageDraft })
  .on(H.cancel, { enter: PageRetired });

const docsControl = sharedOwnerSession.client('docs-control', {
  port: H.slot.port(2),
  grants: [
    H.ops.workRead,
    H.ops.workCreate,
    H.ops.signal(H.cancel),
    H.ops.signal(sharedResumeWork),
    H.ops.memoryRead,
    H.ops.memoryWrite,
    H.ops.telemetryRead,
    H.ops.accountsRead,
  ],
});

export const docs = H.harness('docs')
  .ledger(sqlite.ledger({ path: 'docs/.harness/ledger.sqlite' }))
  .lanes(docsLane)
  .journals(sharedTasteJournal, docsExperience)
  .scheduler(H.scheduler('docs-scheduler').priority(docsLane).wip(docsLane, 2))
  .clients(docsControl)
  .observers(markdown.board({ path: 'docs/BOARD.md' }), markdown.telemetry({ path: 'docs/TELEMETRY.md' }));
