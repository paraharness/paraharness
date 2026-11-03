import { z } from 'zod';
import { H } from 'harness-dsl';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as claude from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as linear from 'harness-dsl/linear';
import * as folder from 'harness-dsl/folder';
import * as markdown from 'harness-dsl/markdown';
import * as git from 'harness-dsl/git';
import * as local from 'harness-dsl/local';

const Queued = H.state('queued', 'pending');
const Building = H.state('building', 'active');
const NeedsOwner = H.state('needs-owner', 'waiting');
const Done = H.state('done', 'terminal', 'success');

const Proposed = H.state('proposed', 'pending');
const Planning = H.state('planning', 'active');
const Incomplete = H.state('incomplete', 'waiting');
const Complete = H.state('complete', 'terminal', 'success');

const HeartbeatDue = H.state('due', 'pending');
const Probing = H.state('probing', 'active');
const Healthy = H.state('healthy', 'terminal', 'success');
const Unhealthy = H.state('unhealthy', 'terminal', 'failure');

const ticketAttributes = { ref: z.string(), title: z.string(), priority: z.number(), source: z.string() };
const ticketFields = { description: z.string() };

const Bug = H.work('bug')
  .attributes(ticketAttributes)
  .fields(ticketFields)
  .states([Queued, Building, NeedsOwner, Done])
  .key((u) => u.attributes.ref);

const Feature = H.work('feature')
  .attributes(ticketAttributes)
  .fields(ticketFields)
  .states([Queued, Building, NeedsOwner, Done])
  .key((u) => u.attributes.ref);

const Epic = H.work('epic')
  .attributes(ticketAttributes)
  .fields(ticketFields)
  .states([Proposed, Planning, Incomplete, Complete])
  .key((u) => u.attributes.ref);

const Heartbeat = H.work('service-heartbeat')
  .attributes({ service: z.string(), tick: z.number() })
  .states([HeartbeatDue, Probing, Healthy, Unhealthy])
  .key((u) => `${u.attributes.service}@${u.attributes.tick}`);

const Experience = H.memory.experience('experience');
const Taste = H.memory.taste('taste');

const bySpecificity = H.policy.recall('specificity-then-track-record', (c) =>
  [...c.candidates]
    .sort((a, b) => b.specificity - a.specificity || b.track.succeeded - a.track.succeeded)
    .slice(0, c.limit),
);

const experienceJournal = H.journal('team-experience', Experience)
  .store(jsonl.memory('./memory/experience.jsonl'))
  .recall(bySpecificity);

const tasteJournal = H.journal('owner-taste', Taste)
  .store(jsonl.memory('./memory/taste.jsonl'))
  .recall(bySpecificity);

const accountQuota = sqlite.quota('./.harness/accounts.db');
const max1 = claude.subscription('max-1', { configDir: H.env('CLAUDE_CONFIG_MAX_1'), quota: accountQuota });
const max2 = claude.subscription('max-2', { configDir: H.env('CLAUDE_CONFIG_MAX_2'), quota: accountQuota });
const max3 = claude.subscription('max-3', { configDir: H.env('CLAUDE_CONFIG_MAX_3'), quota: accountQuota });
const apiAccount = anthropic.account('api-fallback', { apiKey: H.env('ANTHROPIC_API_KEY'), quota: accountQuota });

const soonestExpiring = H.policy.account('soonest-expiring-first', (c) =>
  [...c.eligible].sort((a, b) => a.windowEndsAt - b.windowEndsAt)[0] ?? null,
);

const claudePool = H.pool('claude-subscriptions')
  .accounts([
    { account: max1, share: 0.4 },
    { account: max2, share: 0.3 },
    { account: max3, share: 0.3 },
  ])
  .prefer(soonestExpiring)
  .fallback(apiAccount);

const sonnet = claude.model('claude-sonnet-4-5');
const opus = claude.model('claude-opus-4-1');

const builderModel = H.policy.model('builder-model', [sonnet, opus], (c) => {
  const cheaper = c.metrics.attempts({
    model: sonnet,
    kind: c.unit ? c.unit.kind : 'bug',
    window: { days: 14 },
  });
  return cheaper.n >= 20 && cheaper.rate !== null && cheaper.rate < 0.85 ? opus : sonnet;
});

const projectChecks = H.command('project-checks', ['npm', 'run', 'check']);

const builderRole = H.role('builder')
  .intents(['read', 'write', 'execute', 'search', 'ask'])
  .instructions('Implement the work item. Address every listed deficit. Ask the owner when a decision is theirs.')
  .input({ title: z.string(), description: z.string(), deficits: z.array(z.string()) })
  .output({ summary: z.string() });

const auditorRole = H.role('auditor')
  .intents(['read', 'execute', 'search', 'remember'])
  .instructions('Audit the change against the work item. List every deficit; list none if the work is complete.')
  .input({ title: z.string(), description: z.string(), changes: z.string() })
  .output({ deficits: z.array(z.string()) });

const plannerRole = H.role('planner')
  .intents(['read', 'search'])
  .instructions('Decompose the epic into independently shippable features.')
  .input({ title: z.string(), description: z.string() })
  .output({ features: z.array(z.object({ title: z.string(), description: z.string() })) });

const builder = H.agent('builder', builderRole)
  .model(builderModel)
  .pool(claudePool)
  .recalls([experienceJournal, tasteJournal])
  .leaseWrites()
  .mustPass(projectChecks);

const auditor = H.agent('auditor', auditorRole)
  .model(opus)
  .pool(claudePool)
  .recalls([experienceJournal])
  .records(experienceJournal);

const planner = H.agent('planner', plannerRole)
  .model(opus)
  .pool(claudePool)
  .recalls([tasteJournal]);

const ticketFlow = H.flow('ticket')
  .requires({ title: z.string(), description: z.string() })
  .params({ rounds: z.number() })
  .mark('building')
  .loop(
    'rounds',
    { carry: { deficits: z.array(z.string()) }, rounds: (c) => c.params.rounds },
    (round) =>
      round
        .step('build', builder, (c) => ({
          title: c.input.title,
          description: c.input.description,
          deficits: c.carry ? c.carry.deficits : [],
        }))
        .step('audit', auditor, (c) => ({
          title: c.input.title,
          description: c.input.description,
          changes: c.out.build.summary,
        })),
    (last) => (last.audit.deficits.length > 0 ? { deficits: last.audit.deficits } : null),
  )
  .ends(['done', 'needs-owner'], (c) => (c.out.rounds.last.audit.deficits.length === 0 ? 'done' : 'needs-owner'));

const epicFlow = H.flow('epic')
  .requires({ title: z.string(), description: z.string() })
  .mark('planning')
  .step('plan', planner, (c) => ({ title: c.input.title, description: c.input.description }))
  .spawn('features', {
    outlet: 'features',
    child: { ref: z.string(), title: z.string(), description: z.string() },
    items: (c) =>
      c.out.plan.features.map((feature, index) => ({
        ref: `${c.unit.key}/${index + 1}`,
        title: feature.title,
        description: feature.description,
      })),
  })
  .ends(['complete', 'incomplete'], (c) =>
    c.out.features.every((child) => child.verdict === 'success') ? 'complete' : 'incomplete',
  );

const heartbeatProbe = H.command('heartbeat-probe', ['./scripts/heartbeat.sh']);

const heartbeatFlow = H.flow('heartbeat')
  .requires({ service: z.string() })
  .mark('probing')
  .step('probe', heartbeatProbe, (c) => ({ args: [c.input.service] }))
  .ends(['healthy'], () => 'healthy');

const linearKey = H.env('LINEAR_API_KEY');
const worktrees = git.worktree({ repo: '.', base: 'main', slots: 3 });
const services = ['api', 'web', 'billing'];

const ticketStatus = { queued: 'Todo', building: 'In Progress', 'needs-owner': 'Blocked', done: 'Done' };

const heartbeatLane = H.lane('heartbeats', Heartbeat)
  .supply([
    H.supply.schedule(Heartbeat, H.time.every({ minutes: 5 }), (c) =>
      services.map((service) => ({ create: { attributes: { service, tick: c.now } } })),
    ),
  ])
  .runner(local.shell({ slots: 2 }))
  .handler(heartbeatFlow, { states: { probing: Probing, healthy: Healthy, failed: Unhealthy } });

const bugLane = H.lane('bugs', Bug)
  .supply([
    linear.issues(Bug, { apiKey: linearKey, team: 'ENG', labels: ['bug'] }, (issue) => ({
      attributes: { ref: issue.identifier, title: issue.title, priority: issue.priority, source: 'tracker' },
      fields: { description: issue.description },
    })),
    folder.files(Bug, './bugs', (file) => ({
      attributes: { ref: file.path, title: file.path, priority: 3, source: 'folder' },
      fields: { description: file.body },
    })),
    H.supply.operator(),
  ])
  .store(linear.store(Bug, { apiKey: linearKey, team: 'ENG', status: ticketStatus }))
  .runner(worktrees)
  .wip(2)
  .handler(ticketFlow, {
    params: { rounds: 3 },
    states: { building: Building, done: Done, 'needs-owner': NeedsOwner, failed: NeedsOwner },
  });

const featureLane = H.lane('features', Feature)
  .supply([
    linear.issues(Feature, { apiKey: linearKey, team: 'ENG', labels: ['feature'] }, (issue) => ({
      attributes: { ref: issue.identifier, title: issue.title, priority: issue.priority, source: 'tracker' },
      fields: { description: issue.description },
    })),
    H.supply.operator(),
  ])
  .store(linear.store(Feature, { apiKey: linearKey, team: 'ENG', status: ticketStatus }))
  .runner(worktrees)
  .handler(ticketFlow, {
    params: { rounds: 5 },
    states: { building: Building, done: Done, 'needs-owner': NeedsOwner, failed: NeedsOwner },
  });

const epicLane = H.lane('epics', Epic)
  .supply([
    linear.issues(Epic, { apiKey: linearKey, team: 'ENG', labels: ['epic'] }, (issue) => ({
      attributes: { ref: issue.identifier, title: issue.title, priority: issue.priority, source: 'tracker' },
      fields: { description: issue.description },
    })),
  ])
  .store(
    linear.store(Epic, {
      apiKey: linearKey,
      team: 'ENG',
      status: { proposed: 'Backlog', planning: 'In Progress', incomplete: 'Blocked', complete: 'Done' },
    }),
  )
  .wip(1)
  .handler(epicFlow, {
    states: { planning: Planning, complete: Complete, incomplete: Incomplete, failed: Incomplete },
    spawns: {
      features: H.child(featureLane, (child: { ref: string; title: string; description: string }) => ({
        attributes: { ref: child.ref, title: child.title, priority: 2, source: 'epic' },
        fields: { description: child.description },
      })),
    },
  });

const heartbeatFailureFilesBug = H.trigger(
  'heartbeat-failure-files-bug',
  H.on.transition(heartbeatLane, { to: [Unhealthy] }),
).creates(bugLane, (e) => ({
  attributes: {
    ref: `heartbeat/${e.unit.attributes.service}/${e.unit.attributes.tick}`,
    title: `${e.unit.attributes.service} heartbeat failed`,
    priority: 1,
    source: 'heartbeat',
  },
  fields: {
    description: `The ${e.unit.attributes.service} heartbeat failed at ${new Date(e.unit.attributes.tick).toISOString()}.`,
  },
}));

const featureStarvationMs = 4 * 60 * 60 * 1000;

const teamSchedule = H.policy.schedule('heartbeats-bugs-features-epics', (c) => {
  const rank = (x: (typeof c.candidates)[number]): number =>
    x.is(heartbeatLane)
      ? 0
      : x.is(bugLane)
        ? 1
        : x.is(featureLane)
          ? x.waitedMs > featureStarvationMs
            ? 1
            : 2
          : 3;
  return { start: [...c.candidates].sort((a, b) => rank(a) - rank(b) || b.waitedMs - a.waitedMs) };
});

const productionProbe = H.command('production-health-probe', ['./scripts/probe-production.sh']);

const probeOperation = H.operation('production-health-probe')
  .input({ environment: z.string() })
  .invokes(productionProbe, (input) => ({ args: [input.environment] }));

const ownerAccess = H.access('owner').allows([
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
  probeOperation,
]);

const supervisor = claude.supervisor('supervisor', ownerAccess, { port: H.slot.port(0) });

export const codingTeam = H.harness('coding-team')
  .ledger(sqlite.ledger('./.harness/ledger.db'))
  .lanes([heartbeatLane, bugLane, featureLane, epicLane])
  .triggers([heartbeatFailureFilesBug])
  .schedule(teamSchedule)
  .clients([supervisor])
  .projections([markdown.board('./BOARD.md'), markdown.telemetry('./TELEMETRY.md')]);

export const running = codingTeam.start();
