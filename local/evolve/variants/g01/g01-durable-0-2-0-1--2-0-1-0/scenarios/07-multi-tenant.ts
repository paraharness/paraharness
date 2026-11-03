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

const ownerQuota = sqlite.quota('owner-subscriptions', { path: '/srv/owner/quota.sqlite' });
const subscriptionA = claudeCode.subscription('subscription-a', { token: H.env('CLAUDE_TOKEN_A'), quota: ownerQuota });
const subscriptionB = claudeCode.subscription('subscription-b', { token: H.env('CLAUDE_TOKEN_B'), quota: ownerQuota });
const subscriptionC = claudeCode.subscription('subscription-c', { token: H.env('CLAUDE_TOKEN_C'), quota: ownerQuota });
const apiAccount = anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota: ownerQuota });

const sonnet = claudeCode.model('sonnet', { id: 'claude-sonnet-4-5' });
const opus = claudeCode.model('opus', { id: 'claude-opus-4-1' });

const soonestExpiring = H.policy.account('soonest-expiring', ctx =>
  ctx.candidates
    .filter(c => c.shareUsed < c.shareCap && (c.cooldownUntil === undefined || c.cooldownUntil <= ctx.now))
    .sort((a, b) => a.windowResetsAt.getTime() - b.windowResetsAt.getTime())[0],
);

const taste = H.memory('taste', 'taste');
const experience = H.memory('experience', 'experience');
const ownerTaste = H.journal('owner-taste', taste)
  .store(jsonl.memoryStore({ path: '/srv/owner/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 12 });

const owner = claudeCode.supervisor('owner');

const plannerRole = H.role('planner').intents('read', 'search').instructions('Decompose an epic into independently shippable features.');
const builderRole = H.role('builder').intents('read', 'edit', 'run', 'search').instructions('Implement the work item until the project checks pass.');
const auditorRole = H.role('auditor').intents('read', 'run', 'record').instructions('List every remaining deficit; list none when the work is complete.');

const productPool = H.pool('product-pool')
  .accounts(subscriptionA, subscriptionB, subscriptionC)
  .share(subscriptionA, 0.6)
  .share(subscriptionB, 0.6)
  .share(subscriptionC, 0.6)
  .drain(soonestExpiring)
  .fallback(apiAccount);

const productRunner = local.runner('product-local');
const projectChecks = H.command('project-checks').argv(['npm', 'run', 'check']).runner(productRunner);
const productionProbe = H.command('production-health-probe').argv(['./scripts/probe-production']).runner(productRunner);

const ownerDecision = H.halt('owner-decision').decision(z.object({ choice: z.string(), reason: z.string() }));

const builderModel = H.policy.model('cheap-until-weak', [sonnet, opus], ctx => {
  const cheap = ctx.metrics.attempts({ of: ctx.kind, seat: ctx.seat, model: sonnet, window: { lastDays: 14 } });
  return cheap.samples < 20 || cheap.successRate >= 0.85 ? sonnet : opus;
});

const builder = H.seat('builder')
  .role(builderRole)
  .model(builderModel)
  .pool(productPool)
  .output(z.object({ summary: z.string() }))
  .workspace(git.worktree({ repo: './product', base: 'main' }))
  .guard({ leaseFiles: true, beforeStop: projectChecks })
  .halts(ownerDecision);

const auditor = H.seat('auditor')
  .role(auditorRole)
  .model(sonnet)
  .pool(productPool)
  .output(z.object({ deficits: z.array(z.string()) }));

const planner = H.seat('planner')
  .role(plannerRole)
  .model(opus)
  .pool(productPool)
  .output(z.object({ features: z.array(z.object({ title: z.string(), body: z.string() })) }));

const Backlog = H.state('Backlog', 'pending');
const Building = H.state('Building', 'active');
const Auditing = H.state('Auditing', 'active');
const Planning = H.state('Planning', 'active');
const Delivering = H.state('Delivering', 'waiting');
const Done = H.terminal('Done', 'success');
const Abandoned = H.terminal('Abandoned', 'failure');
const Cancelled = H.terminal('Cancelled', 'neutral');

const workItem = z.object({ issueId: z.string(), title: z.string(), body: z.string() });

const Bug = H.kind('Bug').attributes(workItem).states(Backlog, Building, Auditing, Done, Abandoned, Cancelled).key(a => a.issueId).initial(Backlog);
const Feature = H.kind('Feature').attributes(workItem).states(Backlog, Building, Auditing, Done, Abandoned, Cancelled).key(a => a.issueId).initial(Backlog);
const Epic = H.kind('Epic').attributes(workItem).states(Backlog, Planning, Delivering, Done, Abandoned, Cancelled).key(a => a.issueId).initial(Backlog);

const Scheduled = H.state('Scheduled', 'pending');
const Probing = H.state('Probing', 'active');
const Healthy = H.terminal('Healthy', 'success');
const Unhealthy = H.terminal('Unhealthy', 'failure');
const Skipped = H.terminal('Skipped', 'neutral');
const Heartbeat = H.kind('ServiceHeartbeat')
  .attributes(z.object({ service: z.string(), at: z.string() }))
  .states(Scheduled, Probing, Healthy, Unhealthy, Skipped)
  .key(a => `${a.service}@${a.at}`)
  .initial(Scheduled);

const tracker = linear.store({
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'PROD',
  workflow: ['Backlog', 'In Progress', 'In Review', 'Done', 'Canceled'],
});

const buildAudit = H.flow('build-audit')
  .input(workItem)
  .params(z.object({ rounds: z.number() }))
  .loop(
    'rounds',
    f =>
      f
        .step('build', builder, ctx => ({ task: `${ctx.unit.attributes.title}\n\n${ctx.unit.attributes.body}` }))
        .step('audit', auditor, ctx => ({ task: `Audit the change for ${ctx.unit.attributes.title}: ${ctx.steps.build.summary}` })),
    { max: ctx => ctx.params.rounds, until: ctx => ctx.steps.audit.deficits.length === 0 },
  )
  .exit('clean', ctx => ctx.steps.audit.deficits.length === 0)
  .exit('outOfRounds');

const bugs = H.lane('bugs', Bug)
  .supply(linear.issues({ apiKey: H.env('LINEAR_API_KEY'), team: 'PROD', labels: ['bug'] }), (issue, to) =>
    to.create({ issueId: issue.identifier, title: issue.title, body: issue.description }),
  )
  .supply(folder.files({ path: './product/bugs', glob: '*.md' }), (file, to) =>
    to.create({ issueId: `file:${file.name}`, title: file.name, body: file.body }),
  )
  .supply(H.operator)
  .store(tracker, { Backlog: 'Backlog', Building: 'In Progress', Auditing: 'In Review', Done: 'Done', Abandoned: 'Canceled', Cancelled: 'Canceled' })
  .handler(buildAudit, { exits: { clean: Done, outOfRounds: Abandoned }, during: { build: Building, audit: Auditing }, params: { rounds: 3 } })
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 300000, exhausted: Abandoned })
  .on(H.cancel, { enter: Cancelled });

const features = H.lane('features', Feature)
  .supply(linear.issues({ apiKey: H.env('LINEAR_API_KEY'), team: 'PROD', labels: ['feature'] }), (issue, to) =>
    to.create({ issueId: issue.identifier, title: issue.title, body: issue.description }),
  )
  .supply(H.operator)
  .store(tracker, { Backlog: 'Backlog', Building: 'In Progress', Auditing: 'In Review', Done: 'Done', Abandoned: 'Canceled', Cancelled: 'Canceled' })
  .handler(buildAudit, { exits: { clean: Done, outOfRounds: Abandoned }, during: { build: Building, audit: Auditing }, params: { rounds: 5 } })
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 300000, exhausted: Abandoned })
  .on(H.cancel, { enter: Cancelled });

const decompose = H.flow('decompose')
  .input(workItem)
  .step('plan', planner, ctx => ({ task: `Decompose epic ${ctx.unit.attributes.title}:\n${ctx.unit.attributes.body}` }))
  .spawn('features', features, ctx =>
    ctx.steps.plan.features.map(f => ({ issueId: `${ctx.unit.attributes.issueId}/${f.title}`, title: f.title, body: f.body })),
  )
  .exit('delivered', ctx => ctx.steps.features.every(c => c.verdict === 'success'))
  .exit('incomplete');

const epics = H.lane('epics', Epic)
  .supply(linear.issues({ apiKey: H.env('LINEAR_API_KEY'), team: 'PROD', labels: ['epic'] }), (issue, to) =>
    to.create({ issueId: issue.identifier, title: issue.title, body: issue.description }),
  )
  .store(tracker, { Backlog: 'Backlog', Planning: 'In Progress', Delivering: 'In Review', Done: 'Done', Abandoned: 'Canceled', Cancelled: 'Canceled' })
  .handler(decompose, { exits: { delivered: Done, incomplete: Abandoned }, during: { plan: Planning, features: Delivering } })
  .retry({ maxAttempts: 2, backoff: 'fixed', initialDelayMs: 600000, exhausted: Abandoned })
  .on(H.cancel, { enter: Cancelled });

const probeService = H.command('probe-service')
  .input(z.object({ service: z.string() }))
  .argv(i => ['./scripts/probe', i.service])
  .runner(productRunner)
  .acceptExitCodes(0, 1);

const heartbeatFlow = H.flow('heartbeat')
  .input(z.object({ service: z.string() }))
  .step('probe', probeService, ctx => ({ service: ctx.unit.attributes.service }), { afterCrash: 'rerun' })
  .exit('up', ctx => ctx.steps.probe.exitCode === 0)
  .exit('down');

const heartbeats = H.lane('heartbeats', Heartbeat)
  .supply(H.clock('every-five-minutes').every({ minutes: 5 }), (tick, to) =>
    ['api', 'web', 'worker'].map(service => to.create({ service, at: tick.at.toISOString() })),
  )
  .handler(heartbeatFlow, { exits: { up: Healthy, down: Unhealthy }, during: { probe: Probing } })
  .retry({ maxAttempts: 1, backoff: 'fixed', initialDelayMs: 0, exhausted: Unhealthy })
  .on(H.cancel, { enter: Skipped });

const heartbeatFilesBug = H.trigger('failed-heartbeat-files-bug')
  .on(H.when.transition(heartbeats, { to: Unhealthy }))
  .create(bugs, e => ({
    issueId: `heartbeat:${e.unit.key}`,
    title: `Service ${e.unit.attributes.service} failed its heartbeat`,
    body: `The heartbeat at ${e.unit.attributes.at} failed.`,
  }));

const productExperience = H.journal('product-experience', experience)
  .store(jsonl.memoryStore({ path: './product/.harness/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 8 })
  .readBy(builderRole, auditorRole)
  .recordedBy(auditorRole);

const productScheduler = H.scheduler('product-scheduler')
  .priority(heartbeats, bugs, features, epics)
  .wip(bugs, 2)
  .wip(epics, 1)
  .boost(features, { afterMinutes: 240 });

const productHarness = H.harness('product')
  .ledger(sqlite.ledger({ path: './product/.harness/ledger.sqlite' }))
  .lanes(heartbeats, bugs, features, epics)
  .journals(productExperience, ownerTaste.readBy(builderRole, plannerRole))
  .triggers(heartbeatFilesBug)
  .scheduler(productScheduler)
  .clients(
    owner.client('product-supervisor', {
      port: H.slot.port(1),
      grants: [
        H.ops.workRead,
        H.ops.workCreate,
        H.ops.workUpdate,
        H.ops.workCancel,
        H.ops.resolve(ownerDecision),
        H.ops.memoryRead,
        H.ops.memoryWrite,
        H.ops.telemetryRead,
        H.ops.accountsRead,
        H.ops.accountsShare,
        H.operation('production-health', productionProbe),
      ],
    }),
  )
  .observers(markdown.board({ path: './product/BOARD.md' }), markdown.telemetry({ path: './product/TELEMETRY.md' }));

const writerRole = H.role('writer').intents('read', 'edit').instructions('Write the documentation page so every link resolves.');

const docsPool = H.pool('docs-pool')
  .accounts(subscriptionA, subscriptionB, subscriptionC)
  .share(subscriptionA, 0.3)
  .share(subscriptionB, 0.3)
  .share(subscriptionC, 0.3)
  .drain(soonestExpiring)
  .fallback(apiAccount);

const docsRunner = local.runner('docs-local');
const writer = H.seat('writer').role(writerRole).model(sonnet).pool(docsPool).output(z.object({ body: z.string() }));
const linkCheck = H.command('link-check')
  .input(z.object({ path: z.string() }))
  .argv(i => ['./scripts/check-links', i.path])
  .runner(docsRunner)
  .acceptExitCodes(0, 1);

const PageQueued = H.state('PageQueued', 'pending');
const PageWriting = H.state('PageWriting', 'active');
const PageChecking = H.state('PageChecking', 'active');
const PagePublished = H.terminal('PagePublished', 'success');
const PageBroken = H.terminal('PageBroken', 'failure');

const DocPage = H.kind('DocPage')
  .attributes(z.object({ path: z.string(), body: z.string() }))
  .states(PageQueued, PageWriting, PageChecking, PagePublished, PageBroken)
  .key(a => a.path)
  .initial(PageQueued);

const docsFlow = H.flow('write-doc')
  .input(z.object({ path: z.string(), body: z.string() }))
  .step('write', writer, ctx => ({ task: `Revise ${ctx.unit.attributes.path}:\n${ctx.unit.attributes.body}` }))
  .step('checkLinks', linkCheck, ctx => ({ path: ctx.unit.attributes.path }), { afterCrash: 'rerun' })
  .exit('published', ctx => ctx.steps.checkLinks.exitCode === 0)
  .exit('broken');

const docPages = H.lane('doc-pages', DocPage)
  .supply(folder.files({ path: './docs', glob: '**/*.md' }), (file, to) => to.create({ path: file.path, body: file.body }))
  .store(folder.frontmatter({ path: './docs' }))
  .handler(docsFlow, { exits: { published: PagePublished, broken: PageBroken }, during: { write: PageWriting, checkLinks: PageChecking } })
  .retry({ maxAttempts: 2, backoff: 'fixed', initialDelayMs: 120000, exhausted: PageBroken });

const docsExperience = H.journal('docs-experience', experience)
  .store(jsonl.memoryStore({ path: './docs/.harness/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 8 })
  .readBy(writerRole)
  .recordedBy(writerRole);

const docsHarness = H.harness('docs')
  .ledger(sqlite.ledger({ path: './docs/.harness/ledger.sqlite' }))
  .lanes(docPages)
  .journals(docsExperience, ownerTaste.readBy(writerRole))
  .scheduler(H.scheduler('docs-scheduler').priority(docPages).wip(docPages, 2))
  .clients(
    owner.client('docs-supervisor', {
      port: H.slot.port(2),
      grants: [H.ops.workRead, H.ops.workCreate, H.ops.memoryRead, H.ops.memoryWrite, H.ops.telemetryRead, H.ops.accountsRead],
    }),
  )
  .observers(markdown.board({ path: './docs/BOARD.md' }));

void Promise.all([productHarness.start(), docsHarness.start()]);
