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

export const sharedQuota = sqlite.quota('claude-subscriptions', { path: '/srv/harness-shared/quota.sqlite' });

export const sharedAccounts = {
  max1: claudeCode.subscription('claude-max-1', { token: H.env('CLAUDE_MAX_1_TOKEN'), quota: sharedQuota }),
  max2: claudeCode.subscription('claude-max-2', { token: H.env('CLAUDE_MAX_2_TOKEN'), quota: sharedQuota }),
  max3: claudeCode.subscription('claude-max-3', { token: H.env('CLAUDE_MAX_3_TOKEN'), quota: sharedQuota }),
};

export const sharedModels = {
  sonnet: claudeCode.model('sonnet', { id: 'claude-sonnet-4-5' }),
  opus: claudeCode.model('opus', { id: 'claude-opus-4-1' }),
};

export const sharedRoles = {
  builder: H.role('builder').intents('read', 'edit', 'run', 'search'),
  planner: H.role('planner').intents('read', 'search'),
  writer: H.role('writer').intents('read', 'edit'),
};

export const ownerTaste = H.memory('owner-taste', 'taste');

export const sharedTasteJournal = H.journal('owner-taste', ownerTaste)
  .store(jsonl.memoryStore({ path: '/srv/harness-shared/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 12 })
  .readBy(sharedRoles.builder, sharedRoles.planner, sharedRoles.writer);

export const soonestExpiringFirst = H.policy.account('soonest-expiring-first', ctx => {
  const eligible = ctx.candidates.filter(
    account =>
      account.shareUsed < account.shareCap &&
      (account.cooldownUntil === undefined || account.cooldownUntil.getTime() <= ctx.now.getTime()),
  );
  return eligible.sort((a, b) => a.windowResetsAt.getTime() - b.windowResetsAt.getTime())[0];
});

export const ownerSession = claudeCode.supervisor('owner-session');

const codingApiQuota = sqlite.quota('coding-api', { path: '/srv/coding/.harness/api-quota.sqlite' });
const codingApiAccount = anthropic.account('coding-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota: codingApiQuota });

const codingPool = H.pool('coding-pool')
  .accounts(sharedAccounts.max1, sharedAccounts.max2, sharedAccounts.max3)
  .share(sharedAccounts.max1, 0.6)
  .share(sharedAccounts.max2, 0.6)
  .share(sharedAccounts.max3, 0.6)
  .drain(soonestExpiringFirst)
  .fallback(codingApiAccount);

const cheaperUntilUnreliable = H.policy.model('cheaper-until-unreliable', ctx => {
  const [cheaper, ...stronger] = ctx.candidates;
  const record = ctx.metrics.attempts({ of: ctx.kind, seat: ctx.seat, model: cheaper, window: { lastDays: 14 } });
  return record.samples >= 20 && record.successRate < 0.85 ? stronger[0] ?? cheaper : cheaper;
});

const auditorRole = H.role('auditor').intents('read', 'run', 'search', 'record');

const codingExperience = H.journal('coding-experience', H.memory('coding-experience', 'experience'))
  .store(jsonl.memoryStore({ path: '/srv/coding/.harness/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 8 })
  .readBy(sharedRoles.builder, auditorRole)
  .recordedBy(auditorRole);

const ownerDecision = H.halt('owner-decision').decision(z.object({ choice: z.string(), note: z.string() }));

const projectChecks = H.command('project-checks').argv(['npm', 'run', 'check']).runner(local.runner('coding-local'));

const builder = H.seat('builder')
  .role(sharedRoles.builder)
  .model(cheaperUntilUnreliable, [sharedModels.sonnet, sharedModels.opus])
  .pool(codingPool)
  .workspace(git.worktree({ repo: '/srv/coding', base: 'main' }))
  .guard({ leaseFiles: true, beforeStop: projectChecks })
  .halts(ownerDecision);

const auditor = H.seat('auditor')
  .role(auditorRole)
  .model(sharedModels.sonnet)
  .pool(codingPool)
  .output(z.object({ deficits: z.array(z.string()) }));

const planner = H.seat('planner')
  .role(sharedRoles.planner)
  .model(sharedModels.opus)
  .pool(codingPool)
  .output(z.object({ features: z.array(z.object({ slug: z.string(), title: z.string(), body: z.string() })) }));

const Backlog = H.state('Backlog', 'pending');
const Done = H.terminal('Done', 'success');
const WontDo = H.terminal('WontDo', 'neutral');
const Abandoned = H.terminal('Abandoned', 'failure');
const Due = H.state('Due', 'pending');
const Healthy = H.terminal('Healthy', 'success');
const Unhealthy = H.terminal('Unhealthy', 'failure');

const issue = z.object({ key: z.string(), title: z.string(), body: z.string() });
const heartbeatAttrs = z.object({ service: z.string(), at: z.string() });

const Bug = H.kind('Bug').attributes(issue).states(Backlog, Done, WontDo, Abandoned).key(a => a.key).initial(Backlog);
const Feature = H.kind('Feature').attributes(issue).states(Backlog, Done, WontDo, Abandoned).key(a => a.key).initial(Backlog);
const Epic = H.kind('Epic').attributes(issue).states(Backlog, Done, WontDo, Abandoned).key(a => a.key).initial(Backlog);
const Heartbeat = H.kind('ServiceHeartbeat')
  .attributes(heartbeatAttrs)
  .states(Due, Healthy, Unhealthy)
  .key(a => `${a.service}@${a.at}`)
  .initial(Due);

const buildAndAudit = H.flow('build-and-audit')
  .input(issue)
  .params(z.object({ rounds: z.number().int() }))
  .loop(
    'rounds',
    round =>
      round
        .step('build', builder, ctx => ({ task: `Implement ${ctx.unit.attributes.title}\n\n${ctx.unit.attributes.body}` }))
        .step('audit', auditor, ctx => ({ task: `Audit the change for ${ctx.unit.attributes.title} and list every deficit.` })),
    { max: ctx => ctx.params.rounds, until: ctx => ctx.steps.audit.deficits.length === 0 },
  )
  .exit('clean', ctx => ctx.steps.audit.deficits.length === 0)
  .exit('deficitsRemain');

const linearKey = H.env('LINEAR_API_KEY');
const tracker = linear.store({ apiKey: linearKey, team: 'PROD', workflow: ['Todo', 'In Progress', 'Blocked', 'Done', 'Canceled'] });

const bugs = H.lane('bugs', Bug)
  .supply(linear.issues({ apiKey: linearKey, team: 'PROD', labels: ['bug'] }), (i, to) =>
    to.create({ key: i.identifier, title: i.title, body: i.description }),
  )
  .supply(folder.files({ path: '/srv/coding/bugs', glob: '*.md' }), (f, to) =>
    to.create({ key: `file:${f.name}`, title: f.name, body: f.body }),
  )
  .supply(H.operator)
  .store(tracker, {
    states: { Backlog: 'Todo', Done: 'Done', WontDo: 'Canceled', Abandoned: 'Canceled' },
    running: 'In Progress',
    blocked: 'Blocked',
  })
  .handler(buildAndAudit, {
    params: { rounds: 3 },
    ends: { clean: Done, deficitsRemain: Abandoned },
    retry: { maxAttempts: 2, backoff: 'exponential', initialDelayMs: 60_000, exhausted: Abandoned },
  });

const features = H.lane('features', Feature)
  .supply(linear.issues({ apiKey: linearKey, team: 'PROD', labels: ['feature'] }), (i, to) =>
    to.create({ key: i.identifier, title: i.title, body: i.description }),
  )
  .supply(H.operator)
  .store(tracker, {
    states: { Backlog: 'Todo', Done: 'Done', WontDo: 'Canceled', Abandoned: 'Canceled' },
    running: 'In Progress',
    blocked: 'Blocked',
  })
  .handler(buildAndAudit, {
    params: { rounds: 5 },
    ends: { clean: Done, deficitsRemain: Abandoned },
    retry: { maxAttempts: 2, backoff: 'exponential', initialDelayMs: 60_000, exhausted: Abandoned },
  });

const decomposeEpic = H.flow('decompose-epic')
  .input(issue)
  .step('plan', planner, ctx => ({ task: `Split the epic ${ctx.unit.attributes.title} into features.\n\n${ctx.unit.attributes.body}` }))
  .spawn('features', features, ctx =>
    ctx.steps.plan.features.map(f => ({ key: `${ctx.unit.key}/${f.slug}`, title: f.title, body: f.body })),
  )
  .exit('complete', ctx => ctx.steps.features.every(child => child.verdict === 'success'))
  .exit('incomplete');

const epics = H.lane('epics', Epic)
  .supply(linear.issues({ apiKey: linearKey, team: 'PROD', labels: ['epic'] }), (i, to) =>
    to.create({ key: i.identifier, title: i.title, body: i.description }),
  )
  .store(tracker, {
    states: { Backlog: 'Todo', Done: 'Done', WontDo: 'Canceled', Abandoned: 'Canceled' },
    running: 'In Progress',
    blocked: 'Blocked',
  })
  .handler(decomposeEpic, {
    ends: { complete: Done, incomplete: Abandoned },
    retry: { maxAttempts: 2, backoff: 'fixed', initialDelayMs: 600_000, exhausted: Abandoned },
  });

const services = ['api', 'worker', 'web'];

const serviceProbe = H.command('service-probe')
  .input(z.object({ service: z.string() }))
  .argv(i => ['/srv/coding/ops/probe.sh', i.service])
  .runner(local.runner('coding-local'));

const heartbeatFlow = H.flow('heartbeat')
  .input(heartbeatAttrs)
  .step('probe', serviceProbe, ctx => ({ service: ctx.unit.attributes.service }))
  .exit('healthy');

const heartbeats = H.lane('heartbeats', Heartbeat)
  .supply(H.clock('every-five-minutes').every({ minutes: 5 }), (tick, to) =>
    services.map(service => to.create({ service, at: tick.at.toISOString() })),
  )
  .handler(heartbeatFlow, {
    ends: { healthy: Healthy },
    retry: { maxAttempts: 1, backoff: 'fixed', initialDelayMs: 0, exhausted: Unhealthy },
  });

const failedHeartbeatFilesBug = H.trigger('failed-heartbeat-files-bug')
  .on(H.when.transition(heartbeats, { to: Unhealthy }))
  .create(bugs, e => ({
    key: `heartbeat:${e.unit.key}`,
    title: `Service ${e.unit.attributes.service} failed its heartbeat`,
    body: `The heartbeat at ${e.unit.attributes.at} failed.`,
  }));

const productionHealth = H.operation(
  'production-health',
  H.command('production-health-probe').argv(['/srv/coding/ops/prod-health.sh']).runner(local.runner('coding-local')),
);

const codingControl = ownerSession.client('coding-control', {
  port: H.slot.port(1),
  grants: [
    H.ops.workRead,
    H.ops.workCreate,
    H.ops.workUpdate,
    H.ops.resolve(ownerDecision),
    H.ops.memoryWrite,
    H.ops.telemetryRead,
    H.ops.accountsRead,
    H.ops.accountsShare,
    productionHealth,
  ],
});

const codingScheduler = H.scheduler('coding-scheduler')
  .priority(heartbeats, bugs, features, epics)
  .wip(bugs, 2)
  .wip(epics, 1)
  .boost(features, { afterMinutes: 240 });

export const codingHarness = H.harness('coding-team')
  .ledger(sqlite.ledger({ path: '/srv/coding/.harness/ledger.sqlite' }))
  .lanes(heartbeats, bugs, features, epics)
  .journals(sharedTasteJournal, codingExperience)
  .triggers(failedHeartbeatFilesBug)
  .scheduler(codingScheduler)
  .clients(codingControl)
  .observers(
    markdown.board({ path: '/srv/coding/.harness/board.md' }),
    markdown.telemetry({ path: '/srv/coding/.harness/telemetry.md' }),
  );

const docsPool = H.pool('docs-pool')
  .accounts(sharedAccounts.max1, sharedAccounts.max2, sharedAccounts.max3)
  .share(sharedAccounts.max1, 0.3)
  .share(sharedAccounts.max2, 0.3)
  .share(sharedAccounts.max3, 0.3)
  .drain(soonestExpiringFirst);

const docsExperience = H.journal('docs-experience', H.memory('docs-experience', 'experience'))
  .store(jsonl.memoryStore({ path: '/srv/docs/.harness/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 8 })
  .readBy(sharedRoles.writer)
  .recordedBy(sharedRoles.writer);

const Queued = H.state('Queued', 'pending');
const Published = H.terminal('Published', 'success');
const LinksBroken = H.terminal('LinksBroken', 'failure');

const docAttrs = z.object({ path: z.string(), title: z.string(), body: z.string() });

const DocPage = H.kind('DocPage').attributes(docAttrs).states(Queued, Published, LinksBroken).key(a => a.path).initial(Queued);

const writer = H.seat('writer')
  .role(sharedRoles.writer)
  .model(sharedModels.sonnet)
  .pool(docsPool)
  .workspace(git.worktree({ repo: '/srv/docs', base: 'main' }));

const linkCheck = H.command('link-check')
  .input(z.object({ path: z.string() }))
  .argv(i => ['npx', 'linkcheck', i.path])
  .runner(local.runner('docs-local'));

const writePage = H.flow('write-page')
  .input(docAttrs)
  .step('write', writer, ctx => ({ task: `Write or revise ${ctx.unit.attributes.title}.\n\n${ctx.unit.attributes.body}` }))
  .step('linkCheck', linkCheck, ctx => ({ path: ctx.unit.attributes.path }))
  .exit('published');

const docPages = H.lane('doc-pages', DocPage)
  .supply(folder.files({ path: '/srv/docs/pages', glob: '**/*.md' }), (f, to) =>
    to.create({ path: f.path, title: f.name, body: f.body }),
  )
  .store(folder.frontmatter({ path: '/srv/docs/pages' }))
  .handler(writePage, {
    ends: { published: Published },
    retry: { maxAttempts: 3, backoff: 'exponential', initialDelayMs: 30_000, exhausted: LinksBroken },
  });

const docsControl = ownerSession.client('docs-control', {
  port: H.slot.port(2),
  grants: [H.ops.workRead, H.ops.workCreate, H.ops.memoryWrite, H.ops.telemetryRead, H.ops.accountsRead, H.ops.accountsShare],
});

export const docsHarness = H.harness('documentation')
  .ledger(sqlite.ledger({ path: '/srv/docs/.harness/ledger.sqlite' }))
  .lanes(docPages)
  .journals(sharedTasteJournal, docsExperience)
  .scheduler(H.scheduler('docs-scheduler').priority(docPages).wip(docPages, 2))
  .clients(docsControl)
  .observers(markdown.board({ path: '/srv/docs/.harness/board.md' }));
