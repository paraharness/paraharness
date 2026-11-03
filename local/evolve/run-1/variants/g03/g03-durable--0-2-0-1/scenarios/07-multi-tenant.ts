import { z } from 'zod';
import { H } from 'harness-dsl';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { linear } from 'harness-dsl/linear';
import { folder } from 'harness-dsl/folder';
import { git } from 'harness-dsl/git';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const sharedQuotaPath = '/home/owner/.harness/shared-quota.sqlite';

const subscriptionOne = claudeCode.subscription('claude-subscription-one', { token: H.env('CLAUDE_SUBSCRIPTION_ONE') });
const subscriptionTwo = claudeCode.subscription('claude-subscription-two', { token: H.env('CLAUDE_SUBSCRIPTION_TWO') });
const subscriptionThree = claudeCode.subscription('claude-subscription-three', { token: H.env('CLAUDE_SUBSCRIPTION_THREE') });
const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });

const sonnet = claudeCode.model('sonnet', { id: 'claude-sonnet-4' });
const opus = claudeCode.model('opus', { id: 'claude-opus-4' });

const soonestReset = H.policy.account('soonest-reset', ctx =>
  [...ctx.candidates]
    .filter(candidate => candidate.cooldownUntil === undefined || candidate.cooldownUntil <= ctx.now)
    .filter(candidate => candidate.shareUsed < candidate.shareCap)
    .sort((left, right) => left.windowResetsAt.getTime() - right.windowResetsAt.getTime())
    .find(() => true));

const projectPool = (name: string, share: number) =>
  H.pool(name)
    .accounts(subscriptionOne, subscriptionTwo, subscriptionThree)
    .share(subscriptionOne, share)
    .share(subscriptionTwo, share)
    .share(subscriptionThree, share)
    .drain(soonestReset)
    .fallback(apiAccount);

const builderRole = H.role('builder')
  .intents('read', 'edit', 'run', 'search', 'halt')
  .instructions('Implement the work item. Halt for the owner when a product decision is needed.');
const auditorRole = H.role('auditor')
  .intents('read', 'run', 'search', 'record')
  .instructions('List every deficit against the work item. An empty list means done.');
const plannerRole = H.role('planner')
  .intents('read', 'search')
  .instructions('Decompose the epic into independently shippable features.');
const writerRole = H.role('doc-writer')
  .intents('read', 'edit', 'search')
  .instructions('Bring the page up to date with the code and the style guide.');

const ownerTaste = H.journal('owner-taste', H.memory('taste', 'taste'))
  .store(jsonl.memoryStore({ path: '/home/owner/.harness/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 10 })
  .readBy(builderRole, plannerRole, writerRole);

const codingRunner = local.runner('coding-box');

const Todo = H.state('Todo', 'pending');
const Building = H.state('Building', 'active');
const Auditing = H.state('Auditing', 'active');
const Planning = H.state('Planning', 'active');
const Delivering = H.state('Delivering', 'waiting');
const Done = H.terminal('Done', 'success');
const Exhausted = H.terminal('Exhausted', 'failure');
const Cancelled = H.terminal('Cancelled', 'neutral');

const ticket = z.object({ issueId: z.string(), title: z.string(), description: z.string() });

const Bug = H.kind('Bug')
  .attributes(ticket)
  .states(Todo, Building, Auditing, Done, Exhausted, Cancelled)
  .key(item => item.issueId)
  .initial(Todo)
  .onCancelled(Cancelled);

const Feature = H.kind('Feature')
  .attributes(ticket)
  .states(Todo, Building, Auditing, Done, Exhausted, Cancelled)
  .key(item => item.issueId)
  .initial(Todo)
  .onCancelled(Cancelled);

const Epic = H.kind('Epic')
  .attributes(ticket)
  .states(Todo, Planning, Delivering, Done, Exhausted, Cancelled)
  .key(item => item.issueId)
  .initial(Todo)
  .onCancelled(Cancelled);

const Due = H.state('Due', 'pending');
const Probing = H.state('Probing', 'active');
const Healthy = H.terminal('Healthy', 'success');
const Unhealthy = H.terminal('Unhealthy', 'failure');

const heartbeatAttrs = z.object({ service: z.string(), tick: z.string() });

const ServiceHeartbeat = H.kind('ServiceHeartbeat')
  .attributes(heartbeatAttrs)
  .states(Due, Probing, Healthy, Unhealthy)
  .key(beat => `${beat.service}@${beat.tick}`)
  .initial(Due)
  .onAttemptFailed(Unhealthy);

const builderModel = H.policy.model('builder-model', [sonnet, opus], ctx => {
  const cheaper = ctx.metrics.attempts({ of: ctx.kind, model: sonnet, window: { lastDays: 14 } });
  return cheaper.samples >= 20 && cheaper.successRate < 0.85 ? opus : sonnet;
});

const codingPool = projectPool('coding-pool', 0.6);

const projectChecks = H.command('project-checks').argv(['make', 'check']).runner(codingRunner);

const builder = H.agent('builder')
  .role(builderRole)
  .model(builderModel)
  .pool(codingPool)
  .workspace(git.worktree({ repo: '/home/owner/code/product', base: 'main' }))
  .guard({ leaseFiles: true, beforeStop: projectChecks });

const auditor = H.agent('auditor')
  .role(auditorRole)
  .model(opus)
  .pool(codingPool)
  .output(z.object({ deficits: z.array(z.string()) }));

const planner = H.agent('planner')
  .role(plannerRole)
  .model(opus)
  .pool(codingPool)
  .output(z.object({
    features: z.array(z.object({ slug: z.string(), title: z.string(), description: z.string() })),
  }));

const buildAndAudit = H.flow('build-and-audit')
  .input(ticket)
  .params(z.object({ rounds: z.number() }))
  .loop(
    'rounds',
    flow => flow
      .step('build', builder, ctx => ({
        task: `${ctx.unit.attributes.title}\n\n${ctx.unit.attributes.description}`,
        skills: [ctx.unit.kind],
      }))
      .step('audit', auditor, ctx => ({
        task: `Audit the change for ${ctx.unit.attributes.title}. Builder report:\n${ctx.steps.build}`,
        skills: [ctx.unit.kind],
      })),
    {
      max: ctx => ctx.params.rounds,
      until: ctx => ctx.steps.audit.deficits.length === 0,
    },
  )
  .exit('clean', ctx => ctx.steps.audit.deficits.length === 0)
  .exit('roundsSpent');

const linearKey = H.env('LINEAR_API_KEY');
const tracker = linear.store({
  apiKey: linearKey,
  team: 'ENG',
  workflow: ['Backlog', 'Todo', 'In Progress', 'In Review', 'Done', 'Canceled'],
});

const ticketStates = {
  Todo: 'Todo',
  Building: 'In Progress',
  Auditing: 'In Review',
  Done: 'Done',
  Exhausted: 'Backlog',
  Cancelled: 'Canceled',
} as const satisfies Record<string, string>;

const bugs = H.lane('bugs', Bug)
  .supply(
    linear.issues({ apiKey: linearKey, team: 'ENG', labels: ['bug'] }),
    (issue, to) => to.create({ issueId: issue.identifier, title: issue.title, description: issue.description }),
  )
  .supply(
    folder.files({ path: '/home/owner/code/product/bugs', glob: '*.md' }),
    (file, to) => to.create({ issueId: `file-${file.name}`, title: file.name, description: file.body }),
  )
  .supply(H.operator)
  .store(tracker, ticketStates)
  .handler(buildAndAudit, {
    exits: { clean: Done, roundsSpent: Exhausted },
    during: { build: Building, audit: Auditing },
    params: { rounds: 3 },
  })
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 600_000, exhausted: Exhausted });

const features = H.lane('features', Feature)
  .supply(
    linear.issues({ apiKey: linearKey, team: 'ENG', labels: ['feature'] }),
    (issue, to) => to.create({ issueId: issue.identifier, title: issue.title, description: issue.description }),
  )
  .supply(H.operator)
  .store(tracker, ticketStates)
  .handler(buildAndAudit, {
    exits: { clean: Done, roundsSpent: Exhausted },
    during: { build: Building, audit: Auditing },
    params: { rounds: 5 },
  })
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 600_000, exhausted: Exhausted });

const planEpic = H.flow('plan-epic')
  .input(ticket)
  .step('decompose', planner, ctx => ({
    task: `Decompose epic ${ctx.unit.attributes.title}:\n\n${ctx.unit.attributes.description}`,
  }))
  .spawn('features', features, ctx => ctx.steps.decompose.features.map(feature => ({
    issueId: `${ctx.unit.key}-${feature.slug}`,
    title: feature.title,
    description: feature.description,
  })))
  .exit('delivered', ctx => ctx.steps.features.every(child => child.verdict === 'success'))
  .exit('incomplete');

const epics = H.lane('epics', Epic)
  .supply(
    linear.issues({ apiKey: linearKey, team: 'ENG', labels: ['epic'] }),
    (issue, to) => to.create({ issueId: issue.identifier, title: issue.title, description: issue.description }),
  )
  .store(tracker, {
    Todo: 'Todo',
    Planning: 'In Progress',
    Delivering: 'In Progress',
    Done: 'Done',
    Exhausted: 'Backlog',
    Cancelled: 'Canceled',
  })
  .handler(planEpic, {
    exits: { delivered: Done, incomplete: Exhausted },
    during: { decompose: Planning, features: Delivering },
  })
  .retry({ maxAttempts: 2, backoff: 'fixed', initialDelayMs: 3_600_000, exhausted: Exhausted });

const probeService = H.command('probe-service')
  .input(z.object({ service: z.string() }))
  .argv(input => ['./scripts/probe', input.service])
  .runner(codingRunner);

const heartbeatFlow = H.flow('heartbeat')
  .input(heartbeatAttrs)
  .step('probe', probeService, ctx => ({ service: ctx.unit.attributes.service }))
  .exit('healthy');

const monitoredServices = ['payments-api', 'web'];

const heartbeats = H.lane('heartbeats', ServiceHeartbeat)
  .supply(
    H.clock('every-five-minutes').every({ minutes: 5 }),
    (tick, to) => monitoredServices.map(service => to.create({ service, tick: tick.at.toISOString() })),
  )
  .handler(heartbeatFlow, { exits: { healthy: Healthy }, during: { probe: Probing } });

const heartbeatFailureFilesBug = H.trigger('heartbeat-failure-files-bug')
  .on(H.when.transition(heartbeats, { to: Unhealthy }))
  .create(bugs, event => ({
    issueId: `heartbeat-${event.unit.attributes.service}-${event.unit.attributes.tick}`,
    title: `${event.unit.attributes.service} heartbeat failed`,
    description: `The heartbeat probe for ${event.unit.attributes.service} failed at ${event.unit.attributes.tick}.`,
  }));

const codingExperience = H.journal('coding-experience', H.memory('coding-lesson', 'experience'))
  .store(jsonl.memoryStore({ path: '/home/owner/code/product/.harness/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 8 })
  .readBy(builderRole, auditorRole)
  .recordedBy(auditorRole);

const productionHealth = H.operation(
  'production-health',
  H.command('production-health-probe').argv(['./scripts/prod-health']).runner(codingRunner),
);

export const coding = H.harness('coding')
  .ledger(sqlite.ledger({ path: '/home/owner/code/product/.harness/ledger.sqlite', quotaPath: sharedQuotaPath }))
  .lanes(heartbeats, bugs, features, epics)
  .journals(ownerTaste, codingExperience)
  .triggers(heartbeatFailureFilesBug)
  .scheduler(
    H.scheduler('coding-scheduler')
      .priority(heartbeats, bugs, features, epics)
      .wip(bugs, 2)
      .wip(epics, 1)
      .boost(features, { afterMinutes: 120 }),
  )
  .clients(claudeCode.supervisor('coding-supervisor', {
    port: H.slot.port(1),
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
      productionHealth,
    ],
  }))
  .observers(
    markdown.board({ path: '/home/owner/code/product/BOARD.md' }),
    markdown.telemetry({ path: '/home/owner/code/product/TELEMETRY.md' }),
  );

const docsRunner = local.runner('docs-box');
const docsPool = projectPool('docs-pool', 0.3);

const Stale = H.state('Stale', 'pending');
const Writing = H.state('Writing', 'active');
const Checking = H.state('Checking', 'active');
const Published = H.terminal('Published', 'success');
const Unfixable = H.terminal('Unfixable', 'failure');

const pageAttrs = z.object({ path: z.string(), title: z.string(), body: z.string() });

const DocPage = H.kind('DocPage')
  .attributes(pageAttrs)
  .states(Stale, Writing, Checking, Published, Unfixable)
  .key(page => page.path)
  .initial(Stale);

const docWriter = H.agent('doc-writer')
  .role(writerRole)
  .model(sonnet)
  .pool(docsPool)
  .workspace(git.worktree({ repo: '/home/owner/code/docs', base: 'main' }));

const linkCheck = H.command('link-check')
  .input(z.object({ path: z.string() }))
  .argv(input => ['link-check', input.path])
  .runner(docsRunner);

const writePage = H.flow('write-page')
  .input(pageAttrs)
  .step('write', docWriter, ctx => ({
    task: `Update ${ctx.unit.attributes.title} (${ctx.unit.attributes.path}).\n\n${ctx.unit.attributes.body}`,
    resources: [ctx.unit.attributes.path],
  }))
  .step('linkCheck', linkCheck, ctx => ({ path: ctx.unit.attributes.path }))
  .exit('published');

const docPages = H.lane('doc-pages', DocPage)
  .supply(
    folder.files({ path: '/home/owner/code/docs/pages', glob: '**/*.md' }),
    (file, to) => to.create({ path: file.path, title: file.name, body: file.body }),
  )
  .store(folder.frontmatter({ path: '/home/owner/code/docs/pages' }))
  .handler(writePage, { exits: { published: Published }, during: { write: Writing, linkCheck: Checking } })
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 300_000, exhausted: Unfixable });

const docsExperience = H.journal('docs-experience', H.memory('docs-lesson', 'experience'))
  .store(jsonl.memoryStore({ path: '/home/owner/code/docs/.harness/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 8 })
  .readBy(writerRole)
  .recordedBy(writerRole);

export const docs = H.harness('docs')
  .ledger(sqlite.ledger({ path: '/home/owner/code/docs/.harness/ledger.sqlite', quotaPath: sharedQuotaPath }))
  .lanes(docPages)
  .journals(ownerTaste, docsExperience)
  .scheduler(H.scheduler('docs-scheduler').priority(docPages))
  .clients(claudeCode.supervisor('docs-supervisor', {
    port: H.slot.port(2),
    grants: [
      H.ops.workRead,
      H.ops.workCreate,
      H.ops.blockersResolve,
      H.ops.memoryWrite,
      H.ops.telemetryRead,
      H.ops.accountsRead,
      H.ops.accountsShare,
    ],
  }))
  .observers(markdown.board({ path: '/home/owner/code/docs/BOARD.md' }));
