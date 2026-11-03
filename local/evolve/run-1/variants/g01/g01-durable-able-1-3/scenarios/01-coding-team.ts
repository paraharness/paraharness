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

const HOUR = 60 * 60 * 1000;
const STARVATION_MS = 4 * HOUR;
const linearApiKey = H.env('LINEAR_API_KEY');

const Triage = H.state('triage', 'pending');
const Building = H.state('building', 'active');
const Done = H.state('done', 'terminal', 'success');
const Unresolved = H.state('unresolved', 'terminal', 'failure');
const ticketStates = [Triage, Building, Done, Unresolved];

const EpicOpen = H.state('open', 'pending');
const Planning = H.state('planning', 'active');
const Complete = H.state('complete', 'terminal', 'success');
const Incomplete = H.state('incomplete', 'terminal', 'failure');

const Due = H.state('due', 'pending');
const Probing = H.state('probing', 'active');
const Healthy = H.state('healthy', 'terminal', 'success');
const Unhealthy = H.state('unhealthy', 'terminal', 'failure');

const ticketAttributes = { ref: z.string(), title: z.string(), priority: z.number(), origin: z.string() };
const ticketFields = { description: z.string(), url: z.string() };

const Bug = H.work('Bug')
  .attributes(ticketAttributes)
  .fields(ticketFields)
  .states(ticketStates)
  .key((unit) => unit.attributes.ref);

const Feature = H.work('Feature')
  .attributes(ticketAttributes)
  .fields(ticketFields)
  .states(ticketStates)
  .key((unit) => unit.attributes.ref);

const Epic = H.work('Epic')
  .attributes({ ref: z.string(), title: z.string() })
  .fields({ description: z.string() })
  .states([EpicOpen, Planning, Complete, Incomplete])
  .key((unit) => unit.attributes.ref);

const Heartbeat = H.work('ServiceHeartbeat')
  .attributes({ service: z.string() })
  .states([Due, Probing, Healthy, Unhealthy])
  .key((unit) => unit.attributes.service);

const ticketStatus = { triage: 'Triage', building: 'In Progress', done: 'Done', unresolved: 'Blocked' };

const ticketFromIssue = (origin: string) => (issue: linear.LinearIssue) => ({
  attributes: { ref: issue.identifier, title: issue.title, priority: issue.priority, origin },
  fields: { description: issue.description, url: issue.url },
});

const payments = H.resource('payments').paths(['src/payments/**']);

const experienceKind = H.memory.experience('coding-experience');
const tasteKind = H.memory.taste('owner-taste');

const proven = (track: { present: number; succeeded: number }): number =>
  track.present === 0 ? 0 : track.succeeded / track.present;

const specificThenProven = H.policy.recall('specific-then-proven', (c) =>
  [...c.candidates]
    .sort((a, b) => b.specificity - a.specificity || proven(b.track) - proven(a.track))
    .slice(0, c.limit),
);

const experience = H.journal('experience', experienceKind)
  .store(jsonl.memory('memory/experience.jsonl'))
  .recall(specificThenProven);

const taste = H.journal('taste', tasteKind)
  .store(jsonl.memory('memory/taste.jsonl'))
  .recall(specificThenProven);

const soonestExpiring = H.policy.account('soonest-expiring', (c) => {
  const sorted = [...c.eligible].sort((a, b) => a.windowEndsAt - b.windowEndsAt);
  return sorted.length > 0 ? sorted[0] : null;
});

const claudePool = H.pool('claude-subscriptions')
  .accounts([
    { account: claude.subscription('max-1', { configDir: H.env('CLAUDE_CONFIG_DIR_1') }), share: 0.5 },
    { account: claude.subscription('max-2', { configDir: H.env('CLAUDE_CONFIG_DIR_2') }), share: 0.3 },
    { account: claude.subscription('max-3', { configDir: H.env('CLAUDE_CONFIG_DIR_3') }), share: 0.2 },
  ])
  .prefer(soonestExpiring)
  .fallback(anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY') }));

const sonnet = claude.model('claude-sonnet-4-5');
const opus = claude.model('claude-opus-4-1');

const builderModel = H.policy.model('cheap-until-it-slips', [sonnet, opus], (c) => {
  const cheap = c.metrics.success({
    model: sonnet,
    kind: c.unit === null ? undefined : c.unit.kind,
    window: { days: 14 },
  });
  const slipping = cheap.n >= 20 && cheap.rate !== null && cheap.rate < 0.85;
  return slipping ? opus : sonnet;
});

const projectChecks = H.command('project-checks', ['npm', 'run', 'check']);

const builderRole = H.role('builder')
  .intents(['read', 'write', 'execute', 'ask'])
  .instructions('Implement the task. Resolve every listed deficit. Ask the owner when a decision is theirs.')
  .input({ task: z.string(), details: z.string(), deficits: z.array(z.string()) })
  .output({ summary: z.string() });

const auditorRole = H.role('auditor')
  .intents(['read', 'execute', 'remember'])
  .instructions('Audit the change against the task. List every deficit; list none if there are none.')
  .input({ task: z.string(), summary: z.string() })
  .output({ deficits: z.array(z.string()) });

const plannerRole = H.role('planner')
  .intents(['read', 'search'])
  .instructions('Decompose the epic into independently shippable features.')
  .input({ epic: z.string(), details: z.string() })
  .output({ features: z.array(z.object({ title: z.string(), description: z.string() })) });

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
  .mark('building')
  .loop(
    'rounds',
    { carry: { deficits: z.array(z.string()) }, rounds: (c) => c.params.rounds },
    (round) =>
      round
        .step('build', builder, (c) => ({
          task: c.input.title,
          details: c.input.description,
          deficits: c.carry === null ? [] : c.carry.deficits,
        }))
        .step('audit', auditor, (c) => ({ task: c.input.title, summary: c.out.build.summary })),
    (last) => (last.audit.deficits.length > 0 ? { deficits: last.audit.deficits } : null),
  )
  .exit('unresolved', (c) => c.out.rounds.exhausted)
  .ends(['done'], () => 'done');

const epicFlow = H.flow('epic')
  .requires({ title: z.string(), description: z.string() })
  .mark('planning')
  .step('plan', planner, (c) => ({ epic: c.input.title, details: c.input.description }))
  .spawn('features', {
    outlet: 'feature',
    child: { title: z.string(), description: z.string() },
    items: (c) => c.out.plan.features,
  })
  .ends(['complete', 'incomplete'], (c) =>
    c.out.features.every((feature) => feature.verdict === 'success') ? 'complete' : 'incomplete',
  );

const serviceProbe = H.command('service-probe', ['./scripts/probe-service.sh']);

const heartbeatFlow = H.flow('heartbeat')
  .requires({ service: z.string() })
  .mark('probing')
  .step('probe', serviceProbe, (c) => ({ args: [c.input.service] }), { timeoutMs: 30000, onRestart: 'rerun' })
  .ends(['healthy'], () => 'healthy');

const worktrees = git.worktree({ repo: '.', base: 'main', slots: 3 });
const shell = local.shell({ slots: 2 });

const bugs = H.lane('bugs', Bug)
  .supply([
    linear.issues(Bug, { apiKey: linearApiKey, team: 'ENG', labels: ['bug'] }, ticketFromIssue('tracker')),
    folder.files(Bug, 'inbox/bugs', (file) => ({
      attributes: {
        ref: file.path,
        title: String(file.frontmatter['title'] ?? file.path),
        priority: Number(file.frontmatter['priority'] ?? 3),
        origin: 'folder',
      },
      fields: { description: file.body, url: '' },
    })),
    H.supply.operator(),
  ])
  .store(linear.store(Bug, { apiKey: linearApiKey, team: 'ENG', status: ticketStatus }))
  .handler(ticketFlow, {
    states: { building: Building, unresolved: Unresolved, done: Done, failed: Unresolved },
    params: { rounds: 3 },
  })
  .runner(worktrees)
  .wip(2);

const features = H.lane('features', Feature)
  .supply([
    linear.issues(Feature, { apiKey: linearApiKey, team: 'ENG', labels: ['feature'] }, ticketFromIssue('tracker')),
    H.supply.operator(),
  ])
  .store(linear.store(Feature, { apiKey: linearApiKey, team: 'ENG', status: ticketStatus }))
  .handler(ticketFlow, {
    states: { building: Building, unresolved: Unresolved, done: Done, failed: Unresolved },
    params: { rounds: 5 },
  })
  .runner(worktrees);

const epics = H.lane('epics', Epic)
  .supply([
    linear.issues(Epic, { apiKey: linearApiKey, team: 'ENG', labels: ['epic'] }, (issue) => ({
      attributes: { ref: issue.identifier, title: issue.title },
      fields: { description: issue.description },
    })),
  ])
  .store(
    linear.store(Epic, {
      apiKey: linearApiKey,
      team: 'ENG',
      status: { open: 'Backlog', planning: 'In Progress', complete: 'Done', incomplete: 'Canceled' },
    }),
  )
  .handler(epicFlow, {
    states: { planning: Planning, complete: Complete, incomplete: Incomplete, failed: Incomplete },
    spawns: {
      feature: H.child(features, (child: { title: string; description: string }) => ({
        attributes: { ref: `epic-feature:${child.title}`, title: child.title, priority: 3, origin: 'epic' },
        fields: { description: child.description, url: '' },
      })),
    },
  })
  .runner(worktrees)
  .wip(1);

const heartbeats = H.lane('heartbeats', Heartbeat)
  .supply([
    H.supply.schedule(Heartbeat, H.time.every({ minutes: 5 }), () =>
      ['api', 'worker', 'payments'].map((service) => ({ create: { attributes: { service } } })),
    ),
  ])
  .handler(heartbeatFlow, {
    states: { probing: Probing, healthy: Healthy, failed: Unhealthy },
  })
  .runner(shell);

const outageFilesBug = H.trigger('outage-files-bug', H.on.transition(heartbeats, { verdict: ['failure'] })).creates(
  bugs,
  (event) => ({
    attributes: {
      ref: `heartbeat:${event.unit.attributes.service}`,
      title: `Service ${event.unit.attributes.service} failed its heartbeat`,
      priority: 1,
      origin: 'heartbeat',
    },
    fields: {
      description: `The heartbeat of ${event.unit.attributes.service} ended in ${event.to}. Touches ${payments.name} if the service is payments.`,
      url: '',
    },
  }),
);

const tier = (lane: string, waitedMs: number): number => {
  if (lane === heartbeats.name) return 0;
  if (lane === bugs.name) return 1;
  if (lane === features.name) return waitedMs > STARVATION_MS ? 1 : 2;
  return 3;
};

const codingSchedule = H.policy.schedule('heartbeats-bugs-features-epics', (c) => ({
  start: [...c.candidates].sort(
    (a, b) => tier(a.unit.lane, a.waitedMs) - tier(b.unit.lane, b.waitedMs) || b.waitedMs - a.waitedMs,
  ),
}));

const probeProduction = H.operation('probeProduction')
  .input({ environment: z.string() })
  .invokes(H.command('production-health', ['./scripts/production-health.sh']), (input) => ({
    args: [input.environment],
  }));

const ownerAccess = H.access('owner').allows([
  H.ops.readWork,
  H.ops.createWork,
  H.ops.updateWork,
  H.ops.signalWork,
  H.ops.resolveBlocks,
  H.ops.writeMemory,
  H.ops.readTelemetry,
  H.ops.readAccounts,
  H.ops.setShares,
  probeProduction,
]);

export default H.harness('coding-team')
  .ledger(sqlite.ledger('.harness/coding.sqlite'))
  .lanes([heartbeats, bugs, features, epics])
  .triggers([outageFilesBug])
  .schedule(codingSchedule)
  .clients([claude.supervisor('supervisor', ownerAccess, { port: H.slot.port(0) })])
  .projections([markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md')]);
