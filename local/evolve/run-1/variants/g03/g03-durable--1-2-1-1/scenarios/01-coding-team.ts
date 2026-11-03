import { z } from 'zod';
import { H } from 'harness-dsl';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as linear from 'harness-dsl/linear';
import * as folder from 'harness-dsl/folder';
import * as markdown from 'harness-dsl/markdown';
import * as git from 'harness-dsl/git';
import * as local from 'harness-dsl/local';

const Todo = H.state('Todo', 'pending');
const Building = H.state('Building', 'active');
const Auditing = H.state('Auditing', 'active');
const AwaitingOwner = H.state('AwaitingOwner', 'waiting');
const Done = H.state('Done', 'terminal', 'success');
const Abandoned = H.state('Abandoned', 'terminal', 'failure');

const Proposed = H.state('Proposed', 'pending');
const Planning = H.state('Planning', 'active');
const AwaitingFeatures = H.state('AwaitingFeatures', 'waiting');
const Complete = H.state('Complete', 'terminal', 'success');
const Incomplete = H.state('Incomplete', 'terminal', 'failure');

const Due = H.state('Due', 'pending');
const Probing = H.state('Probing', 'active');
const Healthy = H.state('Healthy', 'terminal', 'success');
const Unhealthy = H.state('Unhealthy', 'terminal', 'failure');

const ticketAttributes = {
  ref: z.string(),
  title: z.string(),
  priority: z.number(),
  area: z.string(),
};
const ticketStates = [Todo, Building, Auditing, AwaitingOwner, Done, Abandoned];

const Bug = H.work('Bug')
  .attributes(ticketAttributes)
  .fields({ description: z.string() })
  .states(ticketStates)
  .failsTo(Abandoned)
  .key(u => u.attributes.ref);

const Feature = H.work('Feature')
  .attributes(ticketAttributes)
  .fields({ description: z.string() })
  .states(ticketStates)
  .failsTo(Abandoned)
  .key(u => u.attributes.ref);

const Epic = H.work('Epic')
  .attributes({ ref: z.string(), title: z.string() })
  .fields({ description: z.string() })
  .states([Proposed, Planning, AwaitingFeatures, Complete, Incomplete])
  .failsTo(Incomplete)
  .key(u => u.attributes.ref);

const ServiceHeartbeat = H.work('ServiceHeartbeat')
  .attributes({ service: z.string(), at: z.number() })
  .states([Due, Probing, Healthy, Unhealthy])
  .failsTo(Unhealthy)
  .key(u => `${u.attributes.service}@${u.attributes.at}`);

const maxA = claudeCode.subscription('max-a', { configDir: H.env('CLAUDE_MAX_A_DIR') });
const maxB = claudeCode.subscription('max-b', { configDir: H.env('CLAUDE_MAX_B_DIR') });
const maxC = claudeCode.subscription('max-c', { configDir: H.env('CLAUDE_MAX_C_DIR') });
const apiAccount = anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY') });

const sonnet = claudeCode.model('claude-sonnet-4-5');
const opus = claudeCode.model('claude-opus-4-1');

const soonestExpiring = H.policy.account('soonest-expiring', c =>
  [...c.eligible].filter(a => a.eligible).sort((a, b) => a.windowEndsAt - b.windowEndsAt)[0] ?? null,
);

const claudePool = H.pool('claude-subscriptions')
  .accounts([
    { account: maxA, share: 0.5 },
    { account: maxB, share: 0.3 },
    { account: maxC, share: 0.2 },
  ])
  .prefer(soonestExpiring)
  .fallback(apiAccount);

const builderModel = H.policy.model('builder-model', [sonnet, opus], c => {
  const kind = c.unit === null ? undefined : c.unit.kind;
  const cheap = c.metrics.success({ kind, model: sonnet, window: { days: 14 } });
  if (cheap.n < 20 || cheap.rate === null) return sonnet;
  return cheap.rate < 0.85 ? opus : sonnet;
});

const trackRate = (x: { track: { present: number; succeeded: number } }) =>
  x.track.present === 0 ? 0 : x.track.succeeded / x.track.present;

const specificThenProven = H.policy.recall('specific-then-proven', c =>
  [...c.candidates]
    .sort((a, b) => b.specificity - a.specificity || trackRate(b) - trackRate(a))
    .slice(0, c.limit),
);

const experience = H.journal('experience', H.memory.experience('experience'))
  .store(jsonl.memory('memory/experience.jsonl'))
  .recall(specificThenProven);

const taste = H.journal('taste', H.memory.taste('taste'))
  .store(jsonl.memory('memory/taste.jsonl'))
  .recall(specificThenProven);

const projectChecks = H.command('project-checks', ['make', 'check']);

const builderRole = H.role('builder')
  .intents(['read', 'write', 'execute', 'search', 'ask'])
  .instructions('Implement the ticket and resolve every listed deficit.')
  .input({ title: z.string(), description: z.string(), deficits: z.array(z.string()) })
  .output({ summary: z.string() });

const auditorRole = H.role('auditor')
  .intents(['read', 'execute', 'search', 'remember'])
  .instructions('Find deficits in the change against the ticket. Return none when the work is complete.')
  .input({ title: z.string(), description: z.string(), summary: z.string() })
  .output({ deficits: z.array(z.string()) });

const plannerRole = H.role('planner')
  .intents(['read', 'search'])
  .instructions('Decompose the epic into independently shippable features.')
  .input({ title: z.string(), description: z.string() })
  .output({
    features: z.array(z.object({ slug: z.string(), title: z.string(), description: z.string() })),
  });

const builder = H.agent('builder', builderRole)
  .model(builderModel)
  .pool(claudePool)
  .recalls([experience, taste])
  .leaseWrites()
  .mustPass(projectChecks);

const auditor = H.agent('auditor', auditorRole)
  .model(opus)
  .pool(claudePool)
  .recalls([experience])
  .records(experience);

const planner = H.agent('planner', plannerRole)
  .model(opus)
  .pool(claudePool)
  .recalls([taste]);

const ticketFlow = H.flow('ticket')
  .requires({ title: z.string(), description: z.string() })
  .params({ rounds: z.number() })
  .loop(
    'rounds',
    { carry: { deficits: z.array(z.string()) }, rounds: c => c.params.rounds },
    round =>
      round
        .step('build', builder, c => ({
          title: c.input.title,
          description: c.input.description,
          deficits: c.carry === null ? [] : c.carry.deficits,
        }))
        .step('audit', auditor, c => ({
          title: c.input.title,
          description: c.input.description,
          summary: c.out.build.summary,
        })),
    last => (last.audit.deficits.length === 0 ? null : { deficits: last.audit.deficits }),
  )
  .ends(['done', 'unfinished'], c => (c.out.rounds.exhausted ? 'unfinished' : 'done'));

const epicFlow = H.flow('epic')
  .requires({ title: z.string(), description: z.string() })
  .step('plan', planner, c => ({ title: c.input.title, description: c.input.description }))
  .spawn('decompose', {
    outlet: 'feature',
    child: { ref: z.string(), title: z.string(), description: z.string() },
    items: c =>
      c.out.plan.features.map(f => ({
        ref: `${c.unit.key}/${f.slug}`,
        title: f.title,
        description: f.description,
      })),
  })
  .ends(['complete', 'incomplete'], c =>
    c.out.decompose.every(child => child.verdict === 'success') ? 'complete' : 'incomplete',
  );

const productionProbe = H.command('production-probe', ['scripts/probe-production.sh']);
const serviceProbe = H.command('service-probe', ['scripts/probe-service.sh']);

const heartbeatFlow = H.flow('heartbeat')
  .requires({ service: z.string() })
  .step('probe', serviceProbe, c => ({ args: [c.input.service] }))
  .ends(['healthy'], () => 'healthy');

const linearKey = H.env('LINEAR_API_KEY');
const ticketStatus = {
  Todo: 'Todo',
  Building: 'In Progress',
  Auditing: 'In Review',
  AwaitingOwner: 'Blocked',
  Done: 'Done',
  Abandoned: 'Canceled',
};

const worktrees = git.worktree({ repo: '.', base: 'main', slots: 3 });
const shell = local.shell({ slots: 2 });

const bugs = H.lane('bugs', Bug)
  .supply([
    linear.issues(Bug, { apiKey: linearKey, team: 'ENG', labels: ['bug'] }, (issue, supply) =>
      supply.create({
        attributes: {
          ref: issue.identifier,
          title: issue.title,
          priority: issue.priority,
          area: issue.labels[0] ?? 'general',
        },
        fields: { description: issue.description },
      }),
    ),
    folder.files(Bug, 'bugs', (file, supply) =>
      supply.create({
        attributes: {
          ref: file.path,
          title: String(file.frontmatter['title'] ?? file.path),
          priority: Number(file.frontmatter['priority'] ?? 2),
          area: String(file.frontmatter['area'] ?? 'general'),
        },
        fields: { description: file.body },
      }),
    ),
    H.supply.operator(),
  ])
  .store(linear.store(Bug, { apiKey: linearKey, team: 'ENG', status: ticketStatus }))
  .runner(worktrees)
  .wip(2)
  .retry(H.retry.exponential({ maxRetries: 2, initialDelayMs: 60_000, maxDelayMs: 600_000 }))
  .handler(ticketFlow, {
    states: { done: Done, unfinished: Abandoned, build: Building, audit: Auditing },
    opens: Building,
    blocked: AwaitingOwner,
    params: { rounds: 3 },
  });

const features = H.lane('features', Feature)
  .supply([
    linear.issues(Feature, { apiKey: linearKey, team: 'ENG', labels: ['feature'] }, (issue, supply) =>
      supply.create({
        attributes: {
          ref: issue.identifier,
          title: issue.title,
          priority: issue.priority,
          area: issue.labels[0] ?? 'general',
        },
        fields: { description: issue.description },
      }),
    ),
    H.supply.operator(),
  ])
  .store(linear.store(Feature, { apiKey: linearKey, team: 'ENG', status: ticketStatus }))
  .runner(worktrees)
  .retry(H.retry.exponential({ maxRetries: 2, initialDelayMs: 60_000, maxDelayMs: 600_000 }))
  .handler(ticketFlow, {
    states: { done: Done, unfinished: Abandoned, build: Building, audit: Auditing },
    opens: Building,
    blocked: AwaitingOwner,
    params: { rounds: 5 },
  });

const epics = H.lane('epics', Epic)
  .supply([
    linear.issues(Epic, { apiKey: linearKey, team: 'ENG', labels: ['epic'] }, (issue, supply) =>
      supply.create({
        attributes: { ref: issue.identifier, title: issue.title },
        fields: { description: issue.description },
      }),
    ),
  ])
  .store(
    linear.store(Epic, {
      apiKey: linearKey,
      team: 'ENG',
      status: {
        Proposed: 'Todo',
        Planning: 'In Progress',
        AwaitingFeatures: 'In Progress',
        Complete: 'Done',
        Incomplete: 'Canceled',
      },
    }),
  )
  .runner(shell)
  .wip(1)
  .retry(H.retry.exponential({ maxRetries: 2, initialDelayMs: 60_000 }))
  .handler(epicFlow, {
    states: { plan: Planning, decompose: AwaitingFeatures, complete: Complete, incomplete: Incomplete },
    opens: Planning,
    spawns: {
      feature: child =>
        features.unit({
          attributes: { ref: child.ref, title: child.title, priority: 2, area: 'feature' },
          fields: { description: child.description },
        }),
    },
  });

const services = ['api', 'web', 'worker'];

const heartbeats = H.lane('heartbeats', ServiceHeartbeat)
  .supply([
    H.supply.schedule(ServiceHeartbeat, H.time.every({ minutes: 5 }), (c, supply) =>
      services.map(service => supply.create({ attributes: { service, at: c.now } })),
    ),
  ])
  .runner(shell)
  .handler(heartbeatFlow, {
    states: { healthy: Healthy, probe: Probing },
    opens: Probing,
  });

const heartbeatFailureFilesBug = H.trigger(
  'heartbeat-failure-files-bug',
  H.on.transition(heartbeats, { to: [Unhealthy] }),
).creates(e =>
  bugs.unit({
    attributes: {
      ref: `heartbeat/${e.unit.attributes.service}/${e.unit.attributes.at}`,
      title: `Service ${e.unit.attributes.service} failed its heartbeat`,
      priority: 1,
      area: e.unit.attributes.service,
    },
    fields: { description: `Heartbeat ${e.unit.key} ended unhealthy.` },
  }),
);

const starvationMs = 2 * 60 * 60 * 1000;

const teamSchedule = H.policy.schedule('heartbeats-bugs-features-epics', c => ({
  start: c.order(
    x =>
      x.is(heartbeats)
        ? 0
        : x.is(bugs)
          ? 1
          : x.is(features)
            ? x.waitedMs > starvationMs
              ? 0.5
              : 2
            : 3,
    x => x.enqueuedAt,
  ),
}));

const probeProductionHealth = H.operation('probe-production-health')
  .input({ url: z.string() })
  .invokes(productionProbe, input => ({ args: [input.url] }));

const supervisorAccess = H.access('supervisor').allows([
  H.ops.readWork,
  H.ops.createWork,
  H.ops.updateWork,
  H.ops.resolveBlocks,
  H.ops.writeMemory,
  H.ops.readTelemetry,
  H.ops.readAccounts,
  H.ops.setShares,
  probeProductionHealth,
]);

export const harness = H.harness('coding-team')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes([heartbeats, bugs, features, epics])
  .triggers([heartbeatFailureFilesBug])
  .schedule(teamSchedule)
  .clients([claudeCode.supervisor('supervisor', supervisorAccess, { port: H.slot.port(0) })])
  .projections([markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md')]);
