import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Candidate, RecallCandidate } from 'harness-dsl/kernel';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as linear from 'harness-dsl/linear';
import * as folder from 'harness-dsl/folder';
import * as markdown from 'harness-dsl/markdown';
import * as git from 'harness-dsl/git';
import * as local from 'harness-dsl/local';

const hourMs = 60 * 60 * 1000;

export const Triage = H.state('Triage', 'pending');
export const Building = H.state('Building', 'active');
export const Shipped = H.state('Shipped', 'terminal', 'success');
export const Abandoned = H.state('Abandoned', 'terminal', 'failure');

export const EpicProposed = H.state('EpicProposed', 'pending');
export const Decomposing = H.state('Decomposing', 'active');
export const EpicDelivered = H.state('EpicDelivered', 'terminal', 'success');
export const EpicIncomplete = H.state('EpicIncomplete', 'terminal', 'failure');

export const HeartbeatDue = H.state('HeartbeatDue', 'pending');
export const Probing = H.state('Probing', 'active');
export const Healthy = H.state('Healthy', 'terminal', 'success');
export const Unhealthy = H.state('Unhealthy', 'terminal', 'failure');

const ticketAttributes = { ref: z.string(), priority: z.number() };
const ticketFields = { title: z.string(), body: z.string() };

export const Bug = H.work('Bug')
  .attributes(ticketAttributes)
  .fields(ticketFields)
  .states([Triage, Building, Shipped, Abandoned])
  .key(u => u.attributes.ref);

export const Feature = H.work('Feature')
  .attributes(ticketAttributes)
  .fields(ticketFields)
  .states([Triage, Building, Shipped, Abandoned])
  .key(u => u.attributes.ref);

export const Epic = H.work('Epic')
  .attributes({ ref: z.string() })
  .fields(ticketFields)
  .states([EpicProposed, Decomposing, EpicDelivered, EpicIncomplete])
  .key(u => u.attributes.ref);

export const ServiceHeartbeat = H.work('ServiceHeartbeat')
  .attributes({ service: z.string(), due: z.number() })
  .states([HeartbeatDue, Probing, Healthy, Unhealthy])
  .onFailure(Unhealthy)
  .key(u => `${u.attributes.service}@${u.attributes.due}`);

export const max1 = claudeCode.subscription('claude-max-1', { configDir: H.env('CLAUDE_MAX_1_DIR') });
export const max2 = claudeCode.subscription('claude-max-2', { configDir: H.env('CLAUDE_MAX_2_DIR') });
export const max3 = claudeCode.subscription('claude-max-3', { configDir: H.env('CLAUDE_MAX_3_DIR') });
export const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });

export const sonnet = claudeCode.model('claude-sonnet-4-5');
export const opus = claudeCode.model('claude-opus-4-1');

export const soonestExpiring = H.policy.account('soonest-expiring-first', c => {
  const ordered = [...c.eligible].sort((a, b) => a.windowEndsAt - b.windowEndsAt);
  return ordered.length > 0 ? ordered[0] : null;
});

export const claudePool = H.pool('claude-subscriptions')
  .accounts([
    { account: max1, share: 0.6 },
    { account: max2, share: 0.6 },
    { account: max3, share: 0.6 },
  ])
  .prefer(soonestExpiring)
  .fallback(apiAccount);

const proven = (x: RecallCandidate) => x.track.succeeded / Math.max(1, x.track.present);

export const specificThenProven = H.policy.recall('specific-then-proven', c =>
  [...c.candidates]
    .sort((a, b) => b.specificity - a.specificity || proven(b) - proven(a))
    .slice(0, c.limit),
);

export const Experience = H.memory.experience('coding-experience');
export const Taste = H.memory.taste('owner-taste').curated();

export const experienceJournal = H.journal('coding-experience', Experience)
  .store(jsonl.memory('.harness/experience.jsonl'))
  .recall(specificThenProven);

export const tasteJournal = H.journal('owner-taste', Taste)
  .store(jsonl.memory('../shared/taste.jsonl'))
  .recall(specificThenProven);

export const builderModel = H.policy.model('builder-model', [sonnet, opus], c => {
  if (c.unit === null) return sonnet;
  const cheap = c.metrics.success({ model: sonnet, kind: c.unit.kind, window: { days: 14 } });
  return cheap.n >= 20 && cheap.rate !== null && cheap.rate < 0.85 ? opus : sonnet;
});

export const projectChecks = H.command('project-checks', ['npm', 'run', 'check']);
export const heartbeatProbe = H.command('service-heartbeat', ['./bin/heartbeat']);
export const productionHealth = H.command('production-health', ['./bin/probe-production']);

export const builderRole = H.role('builder')
  .intents(['read', 'write', 'execute', 'search', 'ask'])
  .instructions('Implement the task in this worktree. Fix every listed deficit. Ask the owner when a decision is theirs to make.')
  .input({ task: z.string(), detail: z.string(), deficits: z.array(z.string()) })
  .output({ summary: z.string() });

export const auditorRole = H.role('auditor')
  .intents(['read', 'execute', 'search', 'remember'])
  .instructions('Audit the change against the task. List every deficit that remains. Record lessons as forward-phrased experience.')
  .input({ task: z.string(), detail: z.string(), summary: z.string() })
  .output({ deficits: z.array(z.string()) });

export const plannerRole = H.role('planner')
  .intents(['read', 'search'])
  .instructions('Decompose the epic into independently shippable features.')
  .input({ title: z.string(), body: z.string() })
  .output({ features: z.array(z.object({ title: z.string(), body: z.string() })) });

export const builder = H.agent('builder', builderRole)
  .model(builderModel)
  .pool(claudePool)
  .recalls([experienceJournal, tasteJournal])
  .leaseWrites()
  .mustPass(projectChecks);

export const auditor = H.agent('auditor', auditorRole)
  .model(opus)
  .pool(claudePool)
  .recalls([experienceJournal])
  .records(experienceJournal);

export const planner = H.agent('planner', plannerRole)
  .model(opus)
  .pool(claudePool)
  .recalls([tasteJournal]);

export const ticketFlow = H.flow('ticket')
  .requires(ticketFields)
  .params({ rounds: z.number() })
  .loop(
    'rounds',
    { carry: { deficits: z.array(z.string()) }, rounds: c => c.params.rounds },
    round =>
      round
        .step('build', builder, c => ({
          task: c.input.title,
          detail: c.input.body,
          deficits: c.carry === null ? [] : c.carry.deficits,
        }))
        .step('audit', auditor, c => ({
          task: c.input.title,
          detail: c.input.body,
          summary: c.out.build.summary,
        })),
    last => (last.audit.deficits.length > 0 ? { deficits: last.audit.deficits } : null),
  )
  .ends(['shipped', 'abandoned'], c => (c.out.rounds.exhausted ? 'abandoned' : 'shipped'));

export const epicFlow = H.flow('epic')
  .requires(ticketFields)
  .step('plan', planner, c => ({ title: c.input.title, body: c.input.body }))
  .spawn('deliver', {
    outlet: 'features',
    child: { title: z.string(), body: z.string() },
    items: c => c.out.plan.features,
  })
  .ends(['delivered', 'incomplete'], c =>
    c.out.deliver.every(child => child.verdict === 'success') ? 'delivered' : 'incomplete',
  );

export const heartbeatFlow = H.flow('heartbeat')
  .requires({ service: z.string() })
  .step('probe', heartbeatProbe, c => ({ args: [c.input.service] }), { timeoutMs: 30000, restart: 'rerun' })
  .ends(['healthy'], () => 'healthy');

const linearConnection = { apiKey: H.env('LINEAR_API_KEY'), team: 'ENG' };
const ticketStatus = { Triage: 'Triage', Building: 'In Progress', Shipped: 'Done', Abandoned: 'Canceled' };
const services = ['api', 'worker', 'web'];

export const worktrees = git.worktree({ repo: '.', base: 'main', slots: 3 });
export const shell = local.shell({ slots: 2 });

export const bugs = H.lane('bugs', Bug)
  .supply([
    linear.issues(Bug, { ...linearConnection, labels: ['bug'] }, issue => ({
      create: {
        attributes: { ref: issue.identifier, priority: issue.priority },
        fields: { title: issue.title, body: issue.description },
      },
    })),
    folder.files(Bug, 'inbox/bugs', file => ({
      create: {
        attributes: { ref: `folder:${file.path}`, priority: Number(file.frontmatter.priority ?? 3) },
        fields: { title: String(file.frontmatter.title ?? file.path), body: file.body },
      },
    })),
    H.supply.operator(),
  ])
  .store(linear.store(Bug, { ...linearConnection, status: ticketStatus }))
  .handler(ticketFlow, { outcomes: { shipped: Shipped, abandoned: Abandoned }, params: { rounds: 3 } })
  .runner(worktrees)
  .wip(2)
  .retry(H.retry.exponential({ maxRetries: 2, initialDelayMs: 300000 }));

export const features = H.lane('features', Feature)
  .supply([
    linear.issues(Feature, { ...linearConnection, labels: ['feature'] }, issue => ({
      create: {
        attributes: { ref: issue.identifier, priority: issue.priority },
        fields: { title: issue.title, body: issue.description },
      },
    })),
    H.supply.operator(),
  ])
  .store(linear.store(Feature, { ...linearConnection, status: ticketStatus }))
  .handler(ticketFlow, { outcomes: { shipped: Shipped, abandoned: Abandoned }, params: { rounds: 5 } })
  .runner(worktrees)
  .retry(H.retry.exponential({ maxRetries: 2, initialDelayMs: 300000 }));

export const epics = H.lane('epics', Epic)
  .supply([
    linear.issues(Epic, { ...linearConnection, labels: ['epic'] }, issue => ({
      create: { attributes: { ref: issue.identifier }, fields: { title: issue.title, body: issue.description } },
    })),
  ])
  .store(
    linear.store(Epic, {
      ...linearConnection,
      status: { EpicProposed: 'Backlog', Decomposing: 'In Progress', EpicDelivered: 'Done', EpicIncomplete: 'Canceled' },
    }),
  )
  .handler(epicFlow, {
    outcomes: { delivered: EpicDelivered, incomplete: EpicIncomplete },
    spawns: {
      features: child =>
        features.unit({
          attributes: { ref: `epic-feature:${child.title}`, priority: 2 },
          fields: { title: child.title, body: child.body },
        }),
    },
  })
  .wip(1);

export const heartbeats = H.lane('heartbeats', ServiceHeartbeat)
  .supply([
    H.supply.schedule(ServiceHeartbeat, H.time.every({ minutes: 5 }), c =>
      services.map(service => ({ create: { attributes: { service, due: c.now } } })),
    ),
  ])
  .handler(heartbeatFlow, { outcomes: { healthy: Healthy } })
  .runner(shell);

export const unhealthyServiceFilesBug = H.trigger(
  'unhealthy-service-files-bug',
  H.on.transition(heartbeats, { to: [Unhealthy] }),
).creates(e =>
  bugs.unit({
    attributes: { ref: `heartbeat:${e.unit.attributes.service}@${e.unit.attributes.due}`, priority: 1 },
    fields: {
      title: `Service ${e.unit.attributes.service} failed its heartbeat`,
      body: `The heartbeat due at ${new Date(e.unit.attributes.due).toISOString()} failed.`,
    },
  }),
);

const rank = (x: Candidate) =>
  x.unit.is(heartbeats)
    ? 0
    : x.unit.is(bugs)
      ? 2
      : x.unit.is(features)
        ? x.waitedMs > 4 * hourMs
          ? 1
          : 3
        : 4;

export const codingOrder = H.policy.schedule('heartbeats-bugs-features-epics', c => ({
  start: [...c.candidates].sort((a, b) => rank(a) - rank(b) || a.entry.enqueuedAt - b.entry.enqueuedAt),
}));

export const probeProduction = H.operation('probe-production').invokes(productionHealth, () => ({}));

export const ownerAccess = H.access('owner').allows([
  H.ops.readWork,
  H.ops.createWork,
  H.ops.updateWork,
  H.ops.sendEvents,
  H.ops.resolveBlocks,
  H.ops.writeMemory,
  H.ops.readMemory,
  H.ops.readTelemetry,
  H.ops.readAccounts,
  H.ops.setShares,
  probeProduction,
]);

export const supervisor = claudeCode.supervisor('coding-supervisor', ownerAccess, { port: H.slot.port(0) });

export const harness = H.harness('coding-team')
  .ledger(sqlite.ledger('.harness/coding-team.db', { quota: sqlite.quota('../shared/quota.db') }))
  .lanes([heartbeats, bugs, features, epics])
  .triggers([unhealthyServiceFilesBug])
  .schedule(codingOrder)
  .projections([markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md')]);

export const control = H.control('coding-team-control', harness).clients([supervisor]);
