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

const Todo = H.state.pending('Todo');
const Building = H.state.active('Building');
const Planning = H.state.active('Planning');
const Stuck = H.state.waiting('Stuck');
const Done = H.state.terminal('Done', 'success');
const Abandoned = H.state.terminal('Abandoned', 'failure');

const Due = H.state.pending('Due');
const Probing = H.state.active('Probing');
const Healthy = H.state.terminal('Healthy', 'success');
const Unhealthy = H.state.terminal('Unhealthy', 'failure');

const ticketFields = { title: z.string(), description: z.string() };

export const Bug = H.work('Bug')
  .attributes({ priority: z.number(), origin: z.string() })
  .fields(ticketFields)
  .states([Todo, Building, Stuck, Done, Abandoned])
  .key(u => u.attributes.origin);

export const Feature = H.work('Feature')
  .attributes({ priority: z.number(), origin: z.string() })
  .fields(ticketFields)
  .states([Todo, Building, Stuck, Done, Abandoned])
  .key(u => u.attributes.origin);

export const Epic = H.work('Epic')
  .attributes({ origin: z.string() })
  .fields(ticketFields)
  .states([Todo, Planning, Stuck, Done, Abandoned])
  .key(u => u.attributes.origin);

export const ServiceHeartbeat = H.work('ServiceHeartbeat')
  .attributes({ service: z.string(), url: z.string() })
  .states([Due, Probing, Healthy, Unhealthy])
  .key(u => u.attributes.service);

export const max1 = claudeCode.subscription('max-1', { configDir: H.env('CLAUDE_CONFIG_DIR_1') });
export const max2 = claudeCode.subscription('max-2', { configDir: H.env('CLAUDE_CONFIG_DIR_2') });
export const max3 = claudeCode.subscription('max-3', { configDir: H.env('CLAUDE_CONFIG_DIR_3') });
export const apiAccount = anthropic.account('api-fallback', { apiKey: H.env('ANTHROPIC_API_KEY') });

const soonestExpiring = H.policy.account('soonest-expiring-window', c => {
  const ordered = [...c.eligible].sort((a, b) => a.windowEndsAt - b.windowEndsAt);
  return ordered.length > 0 ? ordered[0] : null;
});

const subscriptions = H.pool('subscriptions')
  .accounts([
    { account: max1, share: 0.5 },
    { account: max2, share: 0.3 },
    { account: max3, share: 0.2 },
  ])
  .prefer(soonestExpiring)
  .fallback(apiAccount);

const sonnet = claudeCode.model('claude-sonnet-4-5');
const opus = claudeCode.model('claude-opus-4-1');

const builderModel = H.policy.model('builder-cheap-until-below-85pct', [sonnet, opus], c => {
  const cheap = c.metrics.success({ model: sonnet, kind: c.unit ? c.unit.kind : 'Bug', window: { days: 14 } });
  return cheap.n >= 20 && cheap.rate !== null && cheap.rate < 0.85 ? opus : sonnet;
});

const trackRate = (track: { present: number; succeeded: number }) =>
  track.present === 0 ? 0 : track.succeeded / track.present;

const specificThenProven = H.policy.recall('specific-then-proven', c =>
  [...c.candidates]
    .sort((a, b) => b.specificity - a.specificity || trackRate(b.track) - trackRate(a.track))
    .slice(0, c.limit),
);

export const experience = H.memory.experience('coding-experience');
export const taste = H.memory.taste('owner-taste');

const experienceJournal = H.journal('coding-experience', experience)
  .store(jsonl.memory('memory/experience.jsonl'))
  .recall(specificThenProven);

export const tasteJournal = H.journal('owner-taste', taste)
  .store(jsonl.memory('memory/taste.jsonl'))
  .recall(specificThenProven);

const projectChecks = H.command('project-checks', ['npm', 'run', 'check']);
const probeService = H.command('probe-service', ['curl', '--fail', '--silent', '--max-time', '20']);
const productionHealth = H.command('production-health', ['./scripts/production-health.sh']);

const builderRole = H.role('builder')
  .intents(['read', 'write', 'execute', 'search', 'ask'])
  .instructions('Implement the task in the worktree. Resolve every listed deficit. Ask the owner when a product decision is needed.')
  .input({ title: z.string(), description: z.string(), deficits: z.array(z.string()) })
  .output({ summary: z.string() });

const auditorRole = H.role('auditor')
  .intents(['read', 'search', 'remember'])
  .instructions('Audit the change against the task. List every deficit that blocks merging; list none if there are none.')
  .input({ title: z.string(), description: z.string(), summary: z.string() })
  .output({ deficits: z.array(z.string()) });

const plannerRole = H.role('planner')
  .intents(['read', 'search'])
  .instructions('Decompose the epic into independently shippable features.')
  .input(ticketFields)
  .output({ features: z.array(z.object(ticketFields)) });

const builder = H.agent('builder', builderRole)
  .model(builderModel)
  .pool(subscriptions)
  .recalls([experienceJournal, tasteJournal])
  .leaseWrites()
  .mustPass(projectChecks);

const auditor = H.agent('auditor', auditorRole)
  .model(opus)
  .pool(subscriptions)
  .recalls([experienceJournal])
  .records(experienceJournal);

const planner = H.agent('planner', plannerRole)
  .model(opus)
  .pool(subscriptions)
  .recalls([tasteJournal]);

const buildAndAudit = H.flow('build-and-audit')
  .requires(ticketFields)
  .params({ rounds: z.number() })
  .mark('building')
  .loop(
    'rounds',
    { carry: { deficits: z.array(z.string()) }, rounds: c => c.params.rounds },
    round =>
      round
        .step(
          'build',
          builder,
          c => ({ title: c.input.title, description: c.input.description, deficits: c.carry ? c.carry.deficits : [] }),
          { onRestart: 'reconcile' },
        )
        .step(
          'audit',
          auditor,
          c => ({ title: c.input.title, description: c.input.description, summary: c.out.build.summary }),
          { onRestart: 'reconcile' },
        ),
    last => (last.audit.deficits.length > 0 ? { deficits: last.audit.deficits } : null),
  )
  .ends(['done', 'exhausted'], c => (c.out.rounds.exhausted ? 'exhausted' : 'done'));

const decomposeEpic = H.flow('decompose-epic')
  .requires(ticketFields)
  .mark('planning')
  .step('plan', planner, c => ({ title: c.input.title, description: c.input.description }), { onRestart: 'reconcile' })
  .spawn('features', { outlet: 'feature', child: ticketFields, items: c => c.out.plan.features })
  .ends(['done', 'incomplete'], c => (c.out.features.every(f => f.verdict === 'success') ? 'done' : 'incomplete'));

const heartbeatFlow = H.flow('service-heartbeat')
  .requires({ service: z.string(), url: z.string() })
  .mark('probing')
  .step('probe', probeService, c => ({ args: [c.input.url] }), { timeoutMs: 30_000, onRestart: 'rerun' })
  .ends(['healthy', 'unhealthy'], c => (c.out.probe.exitCode === 0 ? 'healthy' : 'unhealthy'));

const linearKey = H.env('LINEAR_API_KEY');
const trackerStatus = { Todo: 'Todo', Building: 'In Progress', Planning: 'In Progress', Stuck: 'Blocked', Done: 'Done', Abandoned: 'Canceled' };

const worktrees = git.worktree({ repo: '.', base: 'main', slots: 3 });
const shell = local.shell({ slots: 4 });

const services = [
  { service: 'api', url: 'https://api.example.com/health' },
  { service: 'web', url: 'https://www.example.com/health' },
];

export const heartbeats = H.lane('heartbeats', ServiceHeartbeat)
  .supply([H.supply.schedule(ServiceHeartbeat, H.time.every({ minutes: 5 }), () => services.map(s => ({ create: { attributes: s } })))])
  .handler(heartbeatFlow, { states: { probing: Probing, healthy: Healthy, unhealthy: Unhealthy, failed: Unhealthy } })
  .runner(shell);

export const bugs = H.lane('bugs', Bug)
  .supply([
    linear.issues(Bug, { apiKey: linearKey, team: 'ENG', labels: ['bug'] }, issue => ({
      attributes: { priority: issue.priority, origin: issue.url },
      fields: { title: issue.title, description: issue.description },
    })),
    folder.files(Bug, 'bugs', file => ({
      attributes: { priority: 3, origin: file.path },
      fields: { title: file.path.replace(/\.md$/, ''), description: file.body },
    })),
    H.supply.operator(),
  ])
  .store(linear.store(Bug, { apiKey: linearKey, team: 'ENG', status: trackerStatus }))
  .handler(buildAndAudit, { params: { rounds: 3 }, states: { building: Building, done: Done, exhausted: Stuck, failed: Stuck } })
  .runner(worktrees)
  .wip(2);

export const features = H.lane('features', Feature)
  .supply([
    linear.issues(Feature, { apiKey: linearKey, team: 'ENG', labels: ['feature'] }, issue => ({
      attributes: { priority: issue.priority, origin: issue.url },
      fields: { title: issue.title, description: issue.description },
    })),
    H.supply.operator(),
  ])
  .store(linear.store(Feature, { apiKey: linearKey, team: 'ENG', status: trackerStatus }))
  .handler(buildAndAudit, { params: { rounds: 5 }, states: { building: Building, done: Done, exhausted: Stuck, failed: Stuck } })
  .runner(worktrees);

export const epics = H.lane('epics', Epic)
  .supply([
    linear.issues(Epic, { apiKey: linearKey, team: 'ENG', labels: ['epic'] }, issue => ({
      attributes: { origin: issue.url },
      fields: { title: issue.title, description: issue.description },
    })),
  ])
  .store(linear.store(Epic, { apiKey: linearKey, team: 'ENG', status: trackerStatus }))
  .handler(decomposeEpic, {
    states: { planning: Planning, done: Done, incomplete: Stuck, failed: Stuck },
    spawns: {
      feature: H.child(features, (child: { title: string; description: string }) => ({
        attributes: { priority: 2, origin: `epic-feature:${child.title}` },
        fields: { title: child.title, description: child.description },
      })),
    },
  })
  .runner(shell)
  .wip(1);

const failedHeartbeatFilesBug = H.trigger('failed-heartbeat-files-bug', H.on.transition(heartbeats, { verdict: ['failure'] }))
  .creates(bugs, e => ({
    attributes: { priority: 1, origin: `heartbeat:${e.unit.attributes.service}` },
    fields: {
      title: `${e.unit.attributes.service} heartbeat failed`,
      description: `The health probe at ${e.unit.attributes.url} failed (${e.cause.by}: ${e.cause.ref}).`,
    },
  }));

const starvationAfterMs = 4 * 60 * 60 * 1000;

const heartbeatsBugsFeaturesEpics = H.policy.schedule('heartbeats-bugs-features-epics', c => {
  const rank = (x: (typeof c.candidates)[number]) => {
    if (x.is(heartbeats)) return 0;
    if (x.is(features) && x.waitedMs > starvationAfterMs) return 1;
    if (x.is(bugs)) return 2;
    if (x.is(features)) return 3;
    return 4;
  };
  return { start: [...c.candidates].sort((a, b) => rank(a) - rank(b) || b.waitedMs - a.waitedMs) };
});

const probeProduction = H.operation('probeProduction')
  .input({ endpoint: z.string() })
  .invokes(productionHealth, input => ({ args: [input.endpoint] }));

const ownerAccess = H.access('owner').allows([
  H.ops.readWork,
  H.ops.createWork,
  H.ops.updateWork,
  H.ops.resolveBlocks,
  H.ops.recoverAttempts,
  H.ops.readMemory,
  H.ops.writeMemory,
  H.ops.readTelemetry,
  H.ops.readAccounts,
  H.ops.setShares,
  probeProduction,
]);

export const codingTeam = H.harness('coding-team')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes([heartbeats, bugs, features, epics])
  .triggers([failedHeartbeatFilesBug])
  .schedule(heartbeatsBugsFeaturesEpics)
  .clients([claudeCode.supervisor('supervisor', ownerAccess, { port: H.slot.port(0) })])
  .projections([markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md')]);
