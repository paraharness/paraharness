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

export const sharedQuota = sqlite.quota('claude-subscriptions', { path: '/srv/owner/shared/quota.sqlite' });

export const claudeAlpha = claudeCode.subscription('claude-alpha', { token: H.env('CLAUDE_ALPHA_TOKEN'), quota: sharedQuota });
export const claudeBeta = claudeCode.subscription('claude-beta', { token: H.env('CLAUDE_BETA_TOKEN'), quota: sharedQuota });
export const claudeGamma = claudeCode.subscription('claude-gamma', { token: H.env('CLAUDE_GAMMA_TOKEN'), quota: sharedQuota });

export const soonestExpiringFirst = H.policy.account('soonest-expiring-first', ctx =>
  ctx.candidates
    .filter(c => (c.cooldownUntil === undefined || c.cooldownUntil.getTime() <= ctx.now.getTime()) && c.shareUsed < c.shareCap)
    .sort((a, b) => a.windowResetsAt.getTime() - b.windowResetsAt.getTime())[0],
);

export const sonnet = claudeCode.model('sonnet', { id: 'claude-sonnet-4-5' });
export const opus = claudeCode.model('opus', { id: 'claude-opus-4-1' });

export const builderRole = H.role('builder')
  .intents('read', 'edit', 'run', 'search')
  .instructions('Implement the unit of work. Address every deficit and owner answer from earlier rounds. If an owner decision is needed, put it in question.');
export const auditorRole = H.role('auditor')
  .intents('read', 'run', 'search', 'record')
  .instructions('Find deficits in the change against the request. Record experience worth keeping.');
export const plannerRole = H.role('planner')
  .intents('read', 'search')
  .instructions('Decompose the epic into independent features.');
export const writerRole = H.role('writer')
  .intents('read', 'edit')
  .instructions('Write or revise the documentation page.');

export const taste = H.memory('owner-taste', 'taste');
export const sharedTasteJournal = H.journal('owner-taste', taste)
  .store(jsonl.memoryStore({ path: '/srv/owner/shared/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 12 })
  .readBy(builderRole, plannerRole, writerRole);

const workstation = local.runner('workstation').slots(4);

const Open = H.state('Open', 'pending');
const NeedsReview = H.state('NeedsReview', 'waiting');
const Done = H.terminal('Done', 'success');
const Abandoned = H.terminal('Abandoned', 'failure');

const workAttrs = z.object({ title: z.string(), body: z.string(), externalId: z.string() });

const bug = H.kind('Bug').attributes(workAttrs).states(Open, NeedsReview, Done, Abandoned).key(a => a.externalId);
const feature = H.kind('Feature').attributes(workAttrs).states(Open, NeedsReview, Done, Abandoned).key(a => a.externalId);
const epic = H.kind('Epic').attributes(workAttrs).states(Open, NeedsReview, Done, Abandoned).key(a => a.externalId);

const Due = H.state('Due', 'pending');
const Healthy = H.terminal('Healthy', 'success');
const Unhealthy = H.terminal('Unhealthy', 'failure');
const heartbeat = H.kind('ServiceHeartbeat')
  .attributes(z.object({ service: z.string(), at: z.string() }))
  .states(Due, Healthy, Unhealthy)
  .key(a => `${a.service}@${a.at}`);

const codingApi = anthropic.account('coding-api', {
  apiKey: H.env('ANTHROPIC_API_KEY'),
  quota: sqlite.quota('coding-api-quota', { path: './.harness/api-quota.sqlite' }),
});

const codingPool = H.pool('coding-subscriptions')
  .accounts(claudeAlpha, claudeBeta, claudeGamma)
  .share(claudeAlpha, 0.6)
  .share(claudeBeta, 0.6)
  .share(claudeGamma, 0.6)
  .drain(soonestExpiringFirst)
  .fallback(codingApi);

const builderModel = H.policy.model('builder-model', [sonnet, opus], ctx => {
  const cheap = ctx.metrics.attempts({ of: ctx.kind, seat: ctx.seat, model: sonnet, window: { lastDays: 14 } });
  return cheap.samples < 20 || cheap.successRate >= 0.85 ? sonnet : opus;
});

const projectChecks = H.command('project-checks').argv(['npm', 'run', 'check']).runner(workstation);

const builder = H.seat('builder')
  .role(builderRole)
  .model(builderModel)
  .pool(codingPool)
  .output(z.object({ summary: z.string(), question: z.string().optional() }))
  .workspace(git.worktree({ repo: '/srv/product', base: 'main' }), { leaseFiles: true, beforeStop: projectChecks });

const auditor = H.seat('auditor')
  .role(auditorRole)
  .model(opus)
  .pool(codingPool)
  .output(z.object({ deficits: z.array(z.string()) }));

const planner = H.seat('planner')
  .role(plannerRole)
  .model(opus)
  .pool(codingPool)
  .output(z.object({ features: z.array(z.object({ title: z.string(), body: z.string() })) }));

const ownerDecision = H.halt('owner-decision').decision(z.object({ answer: z.string() }));

const experience = H.memory('coding-experience', 'experience');
const codingExperience = H.journal('coding-experience', experience)
  .store(jsonl.memoryStore({ path: './.harness/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 8 })
  .readBy(builderRole, auditorRole)
  .recordedBy(auditorRole);

const roundFeedback = z.object({ deficits: z.array(z.string()), answer: z.string().optional() });

const buildAndAudit = H.flow('build-and-audit')
  .input(workAttrs)
  .params(z.object({ rounds: z.number() }))
  .loop('rounds', roundFeedback, round => round
    .step('build', builder, ctx => ({
      task: [
        `${ctx.unit.attributes.title}\n\n${ctx.unit.attributes.body}`,
        ...ctx.steps.rounds.map((r, i) => `Round ${i + 1} deficits: ${r.deficits.join('; ')}${r.answer === undefined ? '' : `\nOwner answered: ${r.answer}`}`),
      ].join('\n\n'),
    }))
    .halt('ask-owner', ownerDecision, {
      when: ctx => ctx.steps.build.question !== undefined,
      ask: ctx => ctx.steps.build.question ?? '',
    })
    .step('audit', auditor, ctx => ({
      task: `Audit the change for "${ctx.unit.attributes.title}". Builder summary: ${ctx.steps.build.summary}`,
    })),
  {
    max: ctx => ctx.params.rounds,
    until: ctx => ctx.steps.audit.deficits.length === 0,
    feed: ctx => ({ deficits: ctx.steps.audit.deficits, answer: ctx.steps['ask-owner']?.answer }),
  })
  .exit('clean', ctx => ctx.steps.audit.deficits.length === 0)
  .exit('roundsExhausted');

const linearKey = H.env('LINEAR_API_KEY');
const trackerStore = linear.store({ apiKey: linearKey, team: 'CORE', workflow: ['Todo', 'In Progress', 'In Review', 'Done', 'Canceled'] });
const trackerMap = {
  states: { Open: 'Todo', NeedsReview: 'In Review', Done: 'Done', Abandoned: 'Canceled' },
  inFlight: 'In Progress',
} as const;

const bugs = H.lane('bugs', bug)
  .supply(linear.issues({ apiKey: linearKey, team: 'CORE', labels: ['bug'] }), (issue, to) =>
    to.create({ title: issue.title, body: issue.description, externalId: issue.identifier }))
  .supply(folder.files({ path: './bugs', glob: '*.md' }), (file, to) =>
    to.create({ title: file.name, body: file.body, externalId: `file:${file.name}` }))
  .supply(H.operator)
  .store(trackerStore, trackerMap)
  .handler(buildAndAudit, { exits: { clean: Done, roundsExhausted: NeedsReview }, params: { rounds: 3 } })
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 60000, exhausted: Abandoned });

const features = H.lane('features', feature)
  .supply(linear.issues({ apiKey: linearKey, team: 'CORE', labels: ['feature'] }), (issue, to) =>
    to.create({ title: issue.title, body: issue.description, externalId: issue.identifier }))
  .supply(H.operator)
  .store(trackerStore, trackerMap)
  .handler(buildAndAudit, { exits: { clean: Done, roundsExhausted: NeedsReview }, params: { rounds: 5 } })
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 60000, exhausted: Abandoned });

const decompose = H.flow('decompose-epic')
  .input(workAttrs)
  .step('plan', planner, ctx => ({ task: `${ctx.unit.attributes.title}\n\n${ctx.unit.attributes.body}` }))
  .spawn('features', features, ctx => ctx.steps.plan.features.map((f, i) => ({
    title: f.title,
    body: f.body,
    externalId: `${ctx.unit.attributes.externalId}/${i + 1}`,
  })))
  .exit('allDelivered', ctx => ctx.steps.features.every(c => c.verdict === 'success'))
  .exit('partlyDelivered');

const epics = H.lane('epics', epic)
  .supply(linear.issues({ apiKey: linearKey, team: 'CORE', labels: ['epic'] }), (issue, to) =>
    to.create({ title: issue.title, body: issue.description, externalId: issue.identifier }))
  .store(trackerStore, trackerMap)
  .handler(decompose, { exits: { allDelivered: Done, partlyDelivered: NeedsReview } })
  .retry({ maxAttempts: 2, exhausted: Abandoned });

const probeService = H.command('probe-service')
  .argv(['./scripts/probe.sh', 'api'])
  .output(z.object({ ok: z.boolean(), detail: z.string() }))
  .runner(workstation);

const heartbeatFlow = H.flow('heartbeat')
  .step('probe', probeService)
  .exit('healthy', ctx => ctx.steps.probe.ok)
  .exit('unhealthy');

const heartbeats = H.lane('heartbeats', heartbeat)
  .supply(H.clock('every-five-minutes').every({ minutes: 5 }), (tick, to) =>
    to.create({ service: 'api', at: tick.at.toISOString() }))
  .handler(heartbeatFlow, { exits: { healthy: Healthy, unhealthy: Unhealthy } })
  .retry({ maxAttempts: 1, exhausted: Unhealthy });

const heartbeatFailureFilesBug = H.trigger('heartbeat-failure-files-bug')
  .on(H.when.transition(heartbeats, { to: Unhealthy }))
  .create(bugs, e => ({
    title: `Heartbeat failed for ${e.unit.attributes.service}`,
    body: `The heartbeat at ${e.unit.attributes.at} reported unhealthy.`,
    externalId: `heartbeat:${e.unit.key}`,
  }));

const productionHealth = H.command('production-health')
  .argv(['./scripts/prod-health.sh'])
  .output(z.object({ healthy: z.boolean(), detail: z.string() }))
  .runner(workstation);

export const codingSupervisor = claudeCode.supervisor('coding-supervisor', {
  port: H.slot.port(0),
  grants: [
    H.ops.workRead,
    H.ops.workCreate,
    H.ops.workUpdate,
    H.ops.workCancel,
    H.ops.resolve(ownerDecision),
    H.ops.attemptsRecover,
    H.ops.memoryWrite,
    H.ops.telemetryRead,
    H.ops.accountsShare,
    H.operation('production-health', productionHealth),
  ],
});

export const codingHarness = H.harness('coding-team')
  .ledger(sqlite.ledger({ path: './.harness/coding-ledger.sqlite' }))
  .lanes(heartbeats, bugs, features, epics)
  .journals(codingExperience, sharedTasteJournal)
  .triggers(heartbeatFailureFilesBug)
  .scheduler(H.scheduler('coding-scheduler')
    .standard(heartbeats, bugs, features, epics)
    .wip(bugs, 2)
    .wip(epics, 1)
    .aging(features, { afterMinutes: 240 }))
  .clients(codingSupervisor)
  .observers(
    markdown.board({ path: './.harness/BOARD.md' }),
    markdown.telemetry({ path: './.harness/TELEMETRY.md' }),
  );

const Unwritten = H.state('Unwritten', 'pending');
const BrokenLinks = H.state('BrokenLinks', 'waiting');
const Published = H.terminal('Published', 'success');
const Unpublishable = H.terminal('Unpublishable', 'failure');

const docAttrs = z.object({ path: z.string(), title: z.string(), body: z.string() });
const docPage = H.kind('DocPage').attributes(docAttrs).states(Unwritten, BrokenLinks, Published, Unpublishable).key(a => a.path);

const docsPool = H.pool('docs-subscriptions')
  .accounts(claudeAlpha, claudeBeta, claudeGamma)
  .share(claudeAlpha, 0.3)
  .share(claudeBeta, 0.3)
  .share(claudeGamma, 0.3)
  .drain(soonestExpiringFirst);

const writer = H.seat('writer')
  .role(writerRole)
  .model(sonnet)
  .pool(docsPool)
  .output(z.object({ path: z.string() }))
  .workspace(git.worktree({ repo: '/srv/docs', base: 'main' }));

const linkCheck = H.command('link-check')
  .input(z.object({ path: z.string() }))
  .argv(i => ['lychee', '--offline', i.path])
  .output(z.object({ broken: z.array(z.string()) }))
  .runner(workstation);

const writePage = H.flow('write-page')
  .input(docAttrs)
  .step('write', writer, ctx => ({ task: `Write ${ctx.unit.attributes.title} at ${ctx.unit.attributes.path}.\n\n${ctx.unit.attributes.body}` }))
  .step('links', linkCheck, ctx => ({ path: ctx.steps.write.path }))
  .exit('published', ctx => ctx.steps.links.broken.length === 0)
  .exit('broken');

const docPages = H.lane('doc-pages', docPage)
  .supply(folder.files({ path: '/srv/docs/pages', glob: '*.md' }), (file, to) =>
    to.create({ path: file.path, title: file.name, body: file.body }))
  .store(folder.frontmatter({ path: '/srv/docs/pages' }))
  .handler(writePage, { exits: { published: Published, broken: BrokenLinks } })
  .retry({ maxAttempts: 2, exhausted: Unpublishable });

const docsExperience = H.journal('docs-experience', H.memory('docs-experience', 'experience'))
  .store(jsonl.memoryStore({ path: '/srv/docs/.harness/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 8 })
  .readBy(writerRole)
  .recordedBy(writerRole);

export const docsSupervisor = claudeCode.supervisor('docs-supervisor', {
  port: H.slot.port(1),
  grants: [H.ops.workRead, H.ops.workCreate, H.ops.workUpdate, H.ops.attemptsRecover, H.ops.memoryWrite, H.ops.telemetryRead, H.ops.accountsShare],
});

export const docsHarness = H.harness('documentation')
  .ledger(sqlite.ledger({ path: '/srv/docs/.harness/ledger.sqlite' }))
  .lanes(docPages)
  .journals(docsExperience, sharedTasteJournal)
  .scheduler(H.scheduler('docs-scheduler').standard(docPages).wip(docPages, 2))
  .clients(docsSupervisor)
  .observers(markdown.board({ path: '/srv/docs/.harness/BOARD.md' }));

export const ownerSession = claudeCode.session('owner-session', { endpoints: [codingSupervisor, docsSupervisor] });
