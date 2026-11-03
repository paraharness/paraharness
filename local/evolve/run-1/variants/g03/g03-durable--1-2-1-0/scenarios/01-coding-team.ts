import { H } from 'harness-dsl';
import { z } from 'zod';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as linear from 'harness-dsl/linear';
import * as folder from 'harness-dsl/folder';
import * as markdown from 'harness-dsl/markdown';
import * as git from 'harness-dsl/git';
import * as local from 'harness-dsl/local';

const Queued = H.state('Queued', 'pending');
const Building = H.state('Building', 'active');
const Stalled = H.state('Stalled', 'waiting');
const Done = H.state('Done', 'terminal', 'success');
const Abandoned = H.state('Abandoned', 'terminal', 'failure');
const ticketStates = [Queued, Building, Stalled, Done, Abandoned];

const Proposed = H.state('Proposed', 'pending');
const Planning = H.state('Planning', 'active');
const Underway = H.state('Underway', 'active');
const Delivered = H.state('Delivered', 'terminal', 'success');

const Due = H.state('Due', 'pending');
const Probing = H.state('Probing', 'active');
const Healthy = H.state('Healthy', 'terminal', 'success');
const Unhealthy = H.state('Unhealthy', 'terminal', 'failure');

const ticketAttributes = { ref: z.string(), title: z.string(), area: z.string() };
const ticketFields = { description: z.string() };

const Bug = H.work('bug')
  .attributes(ticketAttributes)
  .fields(ticketFields)
  .states(ticketStates)
  .key(u => u.attributes.ref);

const Feature = H.work('feature')
  .attributes(ticketAttributes)
  .fields(ticketFields)
  .states(ticketStates)
  .key(u => u.attributes.ref);

const Epic = H.work('epic')
  .attributes({ ref: z.string(), title: z.string() })
  .fields({ description: z.string() })
  .states([Proposed, Planning, Underway, Stalled, Delivered, Abandoned])
  .key(u => u.attributes.ref);

const Heartbeat = H.work('service-heartbeat')
  .attributes({ service: z.string(), at: z.number() })
  .states([Due, Probing, Healthy, Unhealthy])
  .failsTo(Unhealthy)
  .key(u => `${u.attributes.service}@${u.attributes.at}`);

const subscriptionA = claudeCode.subscription('claude-max-a', { configDir: H.env('CLAUDE_CONFIG_A') });
const subscriptionB = claudeCode.subscription('claude-max-b', { configDir: H.env('CLAUDE_CONFIG_B') });
const subscriptionC = claudeCode.subscription('claude-max-c', { configDir: H.env('CLAUDE_CONFIG_C') });
const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });

const soonestExpiring = H.policy.account('soonest-expiring-first', c =>
  c.eligible.slice().sort((a, b) => a.windowEndsAt - b.windowEndsAt)[0] ?? null);

const claudePool = H.pool('claude-subscriptions')
  .accounts([
    { account: subscriptionA, share: 0.5 },
    { account: subscriptionB, share: 0.3 },
    { account: subscriptionC, share: 0.2 },
  ])
  .prefer(soonestExpiring)
  .fallback(apiAccount);

const sonnet = claudeCode.model('claude-sonnet-4-5');
const opus = claudeCode.model('claude-opus-4-1');

const builderModel = H.policy.model('builder-cheap-until-it-slips', [sonnet, opus], c => {
  const cheap = c.metrics.success({ kind: c.unit?.kind, model: sonnet, window: { days: 14 } });
  if (cheap.n < 20) return sonnet;
  return cheap.rate !== null && cheap.rate < 0.85 ? opus : sonnet;
});

const trackRate = (x: { track: { present: number; succeeded: number } }) =>
  (x.track.succeeded + 1) / (x.track.present + 2);

const specificThenProven = H.policy.recall('specific-then-proven', c =>
  c.candidates
    .slice()
    .sort((a, b) => b.specificity - a.specificity || trackRate(b) - trackRate(a))
    .slice(0, c.limit));

const experience = H.playbook('coding-experience', H.memory.experience('coding-experience').curated())
  .store(jsonl.memory('.harness/memory/experience.jsonl'))
  .recall(specificThenProven);

const taste = H.playbook('owner-taste', H.memory.taste('owner-taste'))
  .store(jsonl.memory('.harness/memory/taste.jsonl'))
  .recall(specificThenProven);

const projectChecks = H.command('project-checks', ['npm', 'run', 'check']);

const builderRole = H.role('builder')
  .intents(['read', 'write', 'execute', 'search', 'ask'])
  .instructions('Implement the task in the worktree. Address every listed deficit. Ask the owner when a decision is theirs.')
  .input({ task: z.string(), deficits: z.array(z.string()) })
  .output({ summary: z.string() });

const auditorRole = H.role('auditor')
  .intents(['read', 'execute', 'remember'])
  .instructions('Audit the change against the task. List every deficit that remains. Record lessons worth keeping.')
  .input({ task: z.string(), summary: z.string() })
  .output({ deficits: z.array(z.string()) });

const plannerRole = H.role('planner')
  .intents(['read', 'search'])
  .instructions('Decompose the epic into independently shippable features.')
  .input({ title: z.string(), description: z.string() })
  .output({ features: z.array(z.object({ title: z.string(), description: z.string() })) });

const builder = H.agent('builder', builderRole)
  .model(builderModel)
  .pool(claudePool)
  .recalls([experience, taste])
  .leaseWrites()
  .mustPass(projectChecks);

const auditor = H.agent('auditor', auditorRole)
  .model(sonnet)
  .pool(claudePool)
  .recalls([experience])
  .records(experience);

const planner = H.agent('planner', plannerRole)
  .model(opus)
  .pool(claudePool)
  .recalls([taste]);

const ticketFlow = H.flow('build-and-audit')
  .requires({ title: z.string(), description: z.string() })
  .params({ rounds: z.number() })
  .loop(
    'rounds',
    { carry: { deficits: z.array(z.string()) }, rounds: c => c.params.rounds },
    round => round
      .step('build', builder, c => ({
        task: `${c.input.title}\n\n${c.input.description}`,
        deficits: c.carry ? c.carry.deficits : [],
      }))
      .step('audit', auditor, c => ({
        task: `${c.input.title}\n\n${c.input.description}`,
        summary: c.out.build.summary,
      })),
    last => last.audit.deficits.length === 0 ? null : { deficits: last.audit.deficits },
  )
  .ends(['done', 'unfinished'], c => c.out.rounds.exhausted ? 'unfinished' : 'done');

const epicFlow = H.flow('decompose-epic')
  .requires({ ref: z.string(), title: z.string(), description: z.string() })
  .step('plan', planner, c => ({ title: c.input.title, description: c.input.description }))
  .spawn('features', {
    child: { epic: z.string(), title: z.string(), description: z.string() },
    items: c => c.out.plan.features.map(f => ({ epic: c.input.ref, title: f.title, description: f.description })),
  })
  .ends(['delivered', 'incomplete'], c =>
    c.out.features.every(f => f.verdict === 'success') ? 'delivered' : 'incomplete');

const probe = H.command('service-probe', ['scripts/probe-service'])
  .parses({ healthy: z.boolean(), detail: z.string() });

const heartbeatFlow = H.flow('heartbeat')
  .requires({ service: z.string() })
  .step('probe', probe, c => ({ args: [c.input.service] }), { timeoutMs: 30_000, restart: 'rerun' })
  .ends(['healthy', 'unhealthy'], c => c.out.probe.data.healthy ? 'healthy' : 'unhealthy');

const linearAuth = { apiKey: H.env('LINEAR_API_KEY'), team: 'ENG' };
const ticketStatus = {
  Queued: 'Todo',
  Building: 'In Progress',
  Stalled: 'Blocked',
  Done: 'Done',
  Abandoned: 'Canceled',
};

const worktrees = git.worktree({ repo: '.', base: 'main', slots: 3 });

const featureLane = H.lane('features', Feature)
  .supply([
    linear.issues(Feature, { ...linearAuth, labels: ['feature'] }, (issue, s) => s.create({
      attributes: { ref: issue.identifier, title: issue.title, area: issue.labels[0] ?? 'general' },
      fields: { description: issue.description },
    })),
    H.supply.operator(),
  ])
  .store(linear.store(Feature, { ...linearAuth, status: ticketStatus }))
  .runner(worktrees)
  .retry(H.retry.exponential({ maxRetries: 2, initialDelayMs: 60_000, maxDelayMs: 900_000 }))
  .handler(ticketFlow, {
    opens: Building,
    ends: { done: Done, unfinished: Stalled },
    exhausted: Stalled,
    params: { rounds: 5 },
  });

const bugLane = H.lane('bugs', Bug)
  .supply([
    linear.issues(Bug, { ...linearAuth, labels: ['bug'] }, (issue, s) => s.create({
      attributes: { ref: issue.identifier, title: issue.title, area: issue.labels[0] ?? 'general' },
      fields: { description: issue.description },
    })),
    folder.files(Bug, 'bugs', (file, s) => s.create({
      attributes: {
        ref: file.path,
        title: String(file.frontmatter.title ?? file.path),
        area: String(file.frontmatter.area ?? 'general'),
      },
      fields: { description: file.body },
    })),
    H.supply.operator(),
  ])
  .store(linear.store(Bug, { ...linearAuth, status: ticketStatus }))
  .runner(worktrees)
  .wip(2)
  .retry(H.retry.exponential({ maxRetries: 2, initialDelayMs: 60_000, maxDelayMs: 900_000 }))
  .handler(ticketFlow, {
    opens: Building,
    ends: { done: Done, unfinished: Stalled },
    exhausted: Stalled,
    params: { rounds: 3 },
  });

const epicLane = H.lane('epics', Epic)
  .supply([
    linear.issues(Epic, { ...linearAuth, labels: ['epic'] }, (issue, s) => s.create({
      attributes: { ref: issue.identifier, title: issue.title },
      fields: { description: issue.description },
    })),
  ])
  .store(linear.store(Epic, {
    ...linearAuth,
    status: { Proposed: 'Todo', Planning: 'In Progress', Underway: 'In Progress', Stalled: 'Blocked', Delivered: 'Done', Abandoned: 'Canceled' },
  }))
  .wip(1)
  .handler(epicFlow, {
    opens: Planning,
    during: { features: Underway },
    ends: { delivered: Delivered, incomplete: Stalled },
    exhausted: Stalled,
    spawns: {
      features: child => featureLane.unit({
        attributes: { ref: `${child.epic}/${child.title}`, title: child.title, area: 'epic' },
        fields: { description: child.description },
      }),
    },
  });

const services = ['api', 'worker', 'payments'];

const heartbeatLane = H.lane('heartbeats', Heartbeat)
  .supply([
    H.supply.schedule(Heartbeat, H.time.every({ minutes: 5 }), (c, s) =>
      services.map(service => s.create({ attributes: { service, at: c.now } }))),
  ])
  .runner(local.shell({ slots: 3 }))
  .handler(heartbeatFlow, {
    opens: Probing,
    ends: { healthy: Healthy, unhealthy: Unhealthy },
  });

const heartbeatFailureFilesBug = H.trigger('heartbeat-failure-files-bug', H.on.transition(heartbeatLane, { to: [Unhealthy] }))
  .creates(e => bugLane.unit({
    attributes: {
      ref: `heartbeat/${e.unit.attributes.service}/${e.unit.attributes.at}`,
      title: `Service ${e.unit.attributes.service} failed its heartbeat`,
      area: 'operations',
    },
    fields: {
      description: `The heartbeat for ${e.unit.attributes.service} ended ${e.to} at ${new Date(e.unit.attributes.at).toISOString()}.`,
    },
  }));

const starvationMs = 2 * 60 * 60 * 1000;

const schedule = H.policy.schedule('heartbeats-bugs-features-epics', c => ({
  start: c.order(
    x => x.is(heartbeatLane) ? 0
      : x.is(featureLane) && x.waitedMs > starvationMs ? 1
      : x.is(bugLane) ? 2
      : x.is(featureLane) ? 3
      : 4,
    x => x.enqueuedAt,
  ),
}));

const productionProbe = H.command('production-health-probe', ['scripts/prod-health']);

const probeProduction = H.operation('probe-production')
  .input({ endpoint: z.string() })
  .invokes(productionProbe, input => ({ args: [input.endpoint] }));

const supervisorAccess = H.access('owner-supervisor').allows([
  H.ops.readWork,
  H.ops.createWork,
  H.ops.updateWork,
  H.ops.sendEvents,
  H.ops.resolveBlocks,
  H.ops.readMemory,
  H.ops.writeMemory,
  H.ops.readTelemetry,
  H.ops.readAccounts,
  H.ops.setShares,
  probeProduction,
]);

export const harness = H.harness('coding-team')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes([heartbeatLane, bugLane, featureLane, epicLane])
  .triggers([heartbeatFailureFilesBug])
  .schedule(schedule)
  .clients([claudeCode.supervisor('supervisor', supervisorAccess, { port: H.slot.port(0) })])
  .projections([markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md')]);
