import { z } from 'zod';
import { H, AccountState } from 'harness-dsl';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { linear } from 'harness-dsl/linear';
import { folder } from 'harness-dsl/folder';
import { git } from 'harness-dsl/git';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const subscriptionQuota = sqlite.quota('claude-subscriptions', { path: '/srv/shared/subscription-quota.sqlite' });

const subscriptionOne = claudeCode.subscription('subscription-one', { token: H.env('CLAUDE_SUBSCRIPTION_ONE'), quota: subscriptionQuota });
const subscriptionTwo = claudeCode.subscription('subscription-two', { token: H.env('CLAUDE_SUBSCRIPTION_TWO'), quota: subscriptionQuota });
const subscriptionThree = claudeCode.subscription('subscription-three', { token: H.env('CLAUDE_SUBSCRIPTION_THREE'), quota: subscriptionQuota });

const sonnet = claudeCode.model('sonnet', { id: 'claude-sonnet-4-5' });
const opus = claudeCode.model('opus', { id: 'claude-opus-4-1' });

const soonestExpiringFirst = H.policy.account('soonest-expiring-first', ctx =>
  ctx.candidates
    .filter(c => c.shareUsed < c.shareCap && (c.cooldownUntil === undefined || c.cooldownUntil.getTime() <= ctx.now.getTime()))
    .reduce<AccountState | undefined>(
      (soonest, c) => (soonest === undefined || c.windowResetsAt.getTime() < soonest.windowResetsAt.getTime() ? c : soonest),
      undefined,
    ),
);

const ownerTaste = H.memory('owner-taste', 'taste');
const ownerTasteStore = jsonl.memoryStore({ path: '/srv/shared/owner-taste.jsonl' });

const teamShareOfEachSubscription = 0.6;
const docsShareOfEachSubscription = 0.3;

const workstation = local.runner('workstation');

const teamApiAccount = anthropic.account('team-api', {
  apiKey: H.env('TEAM_ANTHROPIC_API_KEY'),
  quota: sqlite.quota('team-api', { path: '/srv/team/api-quota.sqlite' }),
});

const teamPool = H.pool('team-subscriptions')
  .accounts(subscriptionOne, subscriptionTwo, subscriptionThree)
  .share(subscriptionOne, teamShareOfEachSubscription)
  .share(subscriptionTwo, teamShareOfEachSubscription)
  .share(subscriptionThree, teamShareOfEachSubscription)
  .drain(soonestExpiringFirst)
  .fallback(teamApiAccount);

const Todo = H.state('Todo', 'pending');
const NeedsOwner = H.state('NeedsOwner', 'waiting');
const Done = H.terminal('Done', 'success');
const Abandoned = H.terminal('Abandoned', 'failure');

const workItem = z.object({ title: z.string(), description: z.string() });
const featureItem = z.object({ title: z.string(), description: z.string(), epic: z.string().optional() });

const Bug = H.kind('Bug').attributes(workItem).states(Todo, NeedsOwner, Done, Abandoned).initial(Todo);
const Feature = H.kind('Feature').attributes(featureItem).states(Todo, NeedsOwner, Done, Abandoned).initial(Todo);
const Epic = H.kind('Epic').attributes(workItem).states(Todo, NeedsOwner, Done, Abandoned).initial(Todo);

const HeartbeatDue = H.state('HeartbeatDue', 'pending');
const Healthy = H.terminal('Healthy', 'success');
const Unhealthy = H.terminal('Unhealthy', 'failure');
const serviceCheck = z.object({ service: z.string() });
const Heartbeat = H.kind('Heartbeat').attributes(serviceCheck).states(HeartbeatDue, Healthy, Unhealthy).initial(HeartbeatDue);

const ownerDecision = H.halt('owner-decision').decision(z.object({ choice: z.string(), note: z.string() }));

const builderRole = H.role('builder').intents('read', 'edit', 'run', 'search', 'halt').instructions('Implement the work item in the worktree.');
const auditorRole = H.role('auditor')
  .intents('read', 'run', 'record')
  .instructions('List every deficit in the change; record lessons that will hold next time.')
  .output(z.object({ deficits: z.array(z.string()) }));
const plannerRole = H.role('planner')
  .intents('read', 'search')
  .instructions('Decompose the epic into independently shippable features.')
  .output(z.object({ features: z.array(workItem) }));

const builderModel = H.policy.model('builder-model', [sonnet, opus], ctx => {
  const cheaper = ctx.metrics.attempts({ of: ctx.kind, seat: ctx.seat, model: sonnet, window: { lastDays: 14 } });
  return cheaper.samples >= 20 && cheaper.successRate < 0.85 ? opus : sonnet;
});

const builder = H.seat('builder').role(builderRole).model(builderModel).pool(teamPool).halts(ownerDecision);
const auditor = H.seat('auditor').role(auditorRole).model(sonnet).pool(teamPool);
const planner = H.seat('planner').role(plannerRole).model(opus).pool(teamPool);

const projectChecks = H.command('project-checks').argv(['npm', 'run', 'check']).runner(workstation);
const worktree = git.worktree({ repo: '.', base: 'main' });

const deliver = H.flow('deliver')
  .input(workItem)
  .params(z.object({ rounds: z.number() }))
  .loop(
    'rounds',
    z.object({ deficits: z.array(z.string()) }),
    body =>
      body
        .step(
          'build',
          builder,
          ctx => ({
            task: [
              `Build: ${ctx.unit.attributes.title}`,
              ctx.unit.attributes.description,
              ...(ctx.steps.rounds?.deficits ?? []).map(deficit => `Fix deficit: ${deficit}`),
            ].join('\n'),
          }),
          { workspace: worktree, guard: { leaseFiles: true, beforeStop: projectChecks } },
        )
        .step('audit', auditor, ctx => ({ task: `Audit the change for: ${ctx.unit.attributes.title}` })),
    {
      max: ctx => ctx.params.rounds,
      until: ctx => ctx.steps.audit.deficits.length === 0,
      carry: ctx => ({ deficits: ctx.steps.audit.deficits }),
    },
  )
  .exit('delivered', ctx => ctx.steps.audit.deficits.length === 0)
  .exit('unfinished');

const linearKey = H.env('LINEAR_API_KEY');
const tracker = linear.store({ apiKey: linearKey, team: 'PRD', workflow: ['Todo', 'In Progress', 'Blocked', 'Done', 'Canceled'] });

const bugs = H.lane('bugs', Bug)
  .supply(linear.issues({ apiKey: linearKey, team: 'PRD', labels: ['bug'] }), (issue, to) =>
    to.create({ title: issue.title, description: issue.description }),
  )
  .supply(folder.files({ path: 'inbox/bugs', glob: '*.md' }), (file, to) => to.create({ title: file.name, description: file.body }))
  .supply(H.operator)
  .handler(deliver, { exits: { delivered: Done, unfinished: NeedsOwner }, params: { rounds: 3 } })
  .store(tracker, { states: { Todo: 'Todo', NeedsOwner: 'Blocked', Done: 'Done', Abandoned: 'Canceled' }, inFlight: 'In Progress' })
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 300_000, exhausted: Abandoned });

const features = H.lane('features', Feature)
  .supply(linear.issues({ apiKey: linearKey, team: 'PRD', labels: ['feature'] }), (issue, to) =>
    to.create({ title: issue.title, description: issue.description }),
  )
  .supply(H.operator)
  .handler(deliver, { exits: { delivered: Done, unfinished: NeedsOwner }, params: { rounds: 5 } })
  .store(tracker, { states: { Todo: 'Todo', NeedsOwner: 'Blocked', Done: 'Done', Abandoned: 'Canceled' }, inFlight: 'In Progress' })
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 300_000, exhausted: Abandoned });

const decompose = H.flow('decompose')
  .input(workItem)
  .step('plan', planner, ctx => ({ task: `Split this epic into features: ${ctx.unit.attributes.title}\n${ctx.unit.attributes.description}` }))
  .spawn('features', features, ctx =>
    ctx.steps.plan.features.map(feature => ({ title: feature.title, description: feature.description, epic: ctx.unit.key })),
  )
  .exit('incomplete', ctx => ctx.steps.features.some(child => child.verdict !== 'success'))
  .exit('completed');

const epics = H.lane('epics', Epic)
  .supply(linear.issues({ apiKey: linearKey, team: 'PRD', labels: ['epic'] }), (issue, to) =>
    to.create({ title: issue.title, description: issue.description }),
  )
  .handler(decompose, { exits: { completed: Done, incomplete: NeedsOwner } })
  .store(tracker, { states: { Todo: 'Todo', NeedsOwner: 'Blocked', Done: 'Done', Abandoned: 'Canceled' }, inFlight: 'In Progress' })
  .retry({ maxAttempts: 2, exhausted: Abandoned });

const probeService = H.command('probe-service')
  .input(serviceCheck)
  .argv(check => ['./scripts/probe.sh', check.service])
  .runner(workstation);

const heartbeatFlow = H.flow('heartbeat')
  .input(serviceCheck)
  .step('probe', probeService, ctx => ({ service: ctx.unit.attributes.service }))
  .exit('healthy');

const heartbeats = H.lane('heartbeats', Heartbeat)
  .supply(H.clock('every-five-minutes').every({ minutes: 5 }), (tick, to) => [to.create({ service: 'api' }), to.create({ service: 'worker' })])
  .handler(heartbeatFlow, { exits: { healthy: Healthy } })
  .retry({ maxAttempts: 1, exhausted: Unhealthy });

const unhealthyServiceFilesBug = H.trigger('unhealthy-service-files-bug')
  .on(H.when.transition(heartbeats, { to: Unhealthy }))
  .create(bugs, event => ({
    title: `Service ${event.unit.attributes.service} failed its heartbeat`,
    description: `The heartbeat for ${event.unit.attributes.service} failed at ${event.at.toISOString()}.`,
  }));

const teamTaste = H.journal('owner-taste', ownerTaste)
  .store(ownerTasteStore)
  .recall({ by: 'specificity', limit: 10 })
  .readBy(builderRole, plannerRole);

const teamExperience = H.journal('team-experience', H.memory('team-experience', 'experience'))
  .store(jsonl.memoryStore({ path: '/srv/team/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 8 })
  .readBy(builderRole, auditorRole)
  .recordedBy(auditorRole);

const teamScheduler = H.scheduler('team')
  .standard(heartbeats, bugs, features, epics)
  .wip(bugs, 2)
  .wip(epics, 1)
  .aging(features, { afterMinutes: 240 });

const productionHealth = H.operation(
  'production-health',
  H.command('probe-production').argv(['./scripts/probe-production.sh']).runner(workstation),
);

const teamSupervisor = claudeCode.supervisor('team-supervisor', {
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

export const team = H.harness('team')
  .ledger(sqlite.ledger({ path: '/srv/team/ledger.sqlite' }))
  .lanes(heartbeats, bugs, features, epics)
  .journals(teamTaste, teamExperience)
  .triggers(unhealthyServiceFilesBug)
  .scheduler(teamScheduler)
  .clients(teamSupervisor)
  .observers(markdown.board({ path: '/srv/team/BOARD.md' }), markdown.telemetry({ path: '/srv/team/TELEMETRY.md' }));

const docsPool = H.pool('docs-subscriptions')
  .accounts(subscriptionOne, subscriptionTwo, subscriptionThree)
  .share(subscriptionOne, docsShareOfEachSubscription)
  .share(subscriptionTwo, docsShareOfEachSubscription)
  .share(subscriptionThree, docsShareOfEachSubscription)
  .drain(soonestExpiringFirst);

const PageQueued = H.state('PageQueued', 'pending');
const Published = H.terminal('Published', 'success');
const Broken = H.terminal('Broken', 'failure');
const page = z.object({ path: z.string(), title: z.string() });
const DocPage = H.kind('DocPage').attributes(page).states(PageQueued, Published, Broken).key(attrs => attrs.path).initial(PageQueued);

const writerRole = H.role('writer').intents('read', 'edit', 'search', 'record').instructions('Bring the page up to date and keep links valid.');
const writer = H.seat('writer').role(writerRole).model(sonnet).pool(docsPool);

const linkCheck = H.command('link-check')
  .input(page)
  .argv(target => ['npx', 'linkinator', target.path])
  .runner(local.runner('docs-workstation'));

const writePage = H.flow('write-page')
  .input(page)
  .step('write', writer, ctx => ({ task: `Update ${ctx.unit.attributes.title} at ${ctx.unit.attributes.path}` }))
  .step('linkCheck', linkCheck, ctx => ctx.unit.attributes)
  .exit('published');

const docPages = H.lane('doc-pages', DocPage)
  .supply(folder.files({ path: 'docs', glob: '**/*.md' }), (file, to) => to.create({ path: file.path, title: file.name }))
  .handler(writePage, { exits: { published: Published } })
  .store(folder.frontmatter({ path: 'docs' }))
  .retry({ maxAttempts: 2, exhausted: Broken });

const docsTaste = H.journal('owner-taste', ownerTaste).store(ownerTasteStore).recall({ by: 'specificity', limit: 10 }).readBy(writerRole);

const docsExperience = H.journal('docs-experience', H.memory('docs-experience', 'experience'))
  .store(jsonl.memoryStore({ path: '/srv/docs/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 8 })
  .readBy(writerRole)
  .recordedBy(writerRole);

const docsSupervisor = claudeCode.supervisor('docs-supervisor', {
  port: H.slot.port(2),
  grants: [H.ops.workRead, H.ops.workCreate, H.ops.memoryWrite, H.ops.telemetryRead, H.ops.accountsRead, H.ops.accountsShare],
});

export const docs = H.harness('docs')
  .ledger(sqlite.ledger({ path: '/srv/docs/ledger.sqlite' }))
  .lanes(docPages)
  .journals(docsTaste, docsExperience)
  .scheduler(H.scheduler('docs').standard(docPages))
  .clients(docsSupervisor)
  .observers(markdown.board({ path: '/srv/docs/BOARD.md' }));

export const ownerSession = claudeCode.session('owner', { endpoints: [teamSupervisor, docsSupervisor] });

void Promise.all([team.start(), docs.start()]);
