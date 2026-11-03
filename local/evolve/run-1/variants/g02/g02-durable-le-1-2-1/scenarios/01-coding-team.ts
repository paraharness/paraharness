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
const Working = H.state('Working', 'active');
const Stalled = H.state('Stalled', 'waiting');
const Done = H.state('Done', 'terminal', 'success');
const Abandoned = H.state('Abandoned', 'terminal', 'neutral');

const Planned = H.state('Planned', 'pending');
const Decomposing = H.state('Decomposing', 'active');
const Delivered = H.state('Delivered', 'terminal', 'success');
const Dropped = H.state('Dropped', 'terminal', 'neutral');

const Due = H.state('Due', 'pending');
const Probing = H.state('Probing', 'active');
const Healthy = H.state('Healthy', 'terminal', 'success');
const Unhealthy = H.state('Unhealthy', 'terminal', 'failure');

const bugKind = H.work('Bug')
  .attributes({ source: z.string(), ref: z.string() })
  .fields({ title: z.string(), description: z.string() })
  .states([Todo, Working, Stalled, Done, Abandoned])
  .events({ canceledInTracker: {} })
  .key(unit => `${unit.attributes.source}:${unit.attributes.ref}`);

const featureKind = H.work('Feature')
  .attributes({ source: z.string(), ref: z.string() })
  .fields({ title: z.string(), description: z.string() })
  .states([Todo, Working, Stalled, Done, Abandoned])
  .events({ canceledInTracker: {} })
  .key(unit => `${unit.attributes.source}:${unit.attributes.ref}`);

const epicKind = H.work('Epic')
  .attributes({ ref: z.string() })
  .fields({ title: z.string(), description: z.string() })
  .states([Planned, Decomposing, Delivered, Dropped])
  .key(unit => unit.attributes.ref);

const heartbeatKind = H.work('ServiceHeartbeat')
  .attributes({ service: z.string(), tick: z.number() })
  .states([Due, Probing, Healthy, Unhealthy])
  .failsTo(Unhealthy)
  .key(unit => `${unit.attributes.service}@${unit.attributes.tick}`);

const max1 = claudeCode.subscription('claude-max-1', { configDir: H.env('CLAUDE_MAX_1_DIR') });
const max2 = claudeCode.subscription('claude-max-2', { configDir: H.env('CLAUDE_MAX_2_DIR') });
const max3 = claudeCode.subscription('claude-max-3', { configDir: H.env('CLAUDE_MAX_3_DIR') });
const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });

const soonestExpiring = H.policy.account('soonestExpiring', c => {
  const ordered = [...c.eligible].sort((a, b) => a.windowEndsAt - b.windowEndsAt);
  return ordered[0] ?? null;
});

const claudePool = H.pool('claude')
  .accounts([
    { account: max1, share: 0.5 },
    { account: max2, share: 0.3 },
    { account: max3, share: 0.2 },
  ])
  .prefer(soonestExpiring)
  .fallback(apiAccount);

const sonnet = claudeCode.model('claude-sonnet-4-5');
const opus = claudeCode.model('claude-opus-4-1');

const builderModel = H.policy.model('builderModel', [sonnet, opus], c => {
  if (c.unit === null) return sonnet;
  const record = c.metrics.success({ kind: c.unit.kind, model: sonnet, window: { days: 14 } });
  return record.n >= 20 && record.rate !== null && record.rate < 0.85 ? opus : sonnet;
});

const bySpecificityAndTrack = H.policy.recall('bySpecificityAndTrack', c =>
  [...c.candidates]
    .sort((a, b) =>
      b.specificity - a.specificity ||
      b.track.succeeded / Math.max(1, b.track.present) - a.track.succeeded / Math.max(1, a.track.present))
    .slice(0, c.limit));

const experience = H.journal('teamExperience', H.memory.experience('experience'))
  .store(jsonl.memory('.harness/memory/experience.jsonl'))
  .recall(bySpecificityAndTrack);

const taste = H.journal('ownerTaste', H.memory.taste('taste'))
  .store(jsonl.memory('.harness/memory/taste.jsonl'))
  .recall(bySpecificityAndTrack);

const projectChecks = H.command('projectChecks', ['npm', 'run', 'check']);

const builderRole = H.role('builder')
  .intents(['read', 'write', 'execute', 'search', 'ask'])
  .instructions('Implement the work item. Fix every listed deficit. Ask the owner when a decision is theirs.')
  .input({ title: z.string(), description: z.string(), deficits: z.array(z.string()) })
  .output({ summary: z.string() });

const auditorRole = H.role('auditor')
  .intents(['read', 'execute', 'search', 'remember'])
  .instructions('Audit the change against the work item. List every deficit; list none when the work is complete.')
  .input({ title: z.string(), description: z.string(), summary: z.string() })
  .output({ deficits: z.array(z.string()) });

const plannerRole = H.role('planner')
  .intents(['read', 'search'])
  .instructions('Decompose the epic into independently deliverable features.')
  .input({ title: z.string(), description: z.string() })
  .output({ features: z.array(z.object({ slug: z.string(), title: z.string(), description: z.string() })) });

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

const deliveryFlow = H.flow('delivery')
  .requires({ title: z.string(), description: z.string() })
  .params({ rounds: z.number().int() })
  .mark('building')
  .loop(
    'buildAndAudit',
    { carry: { deficits: z.array(z.string()) }, rounds: c => c.params.rounds },
    round => round
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
    last => last.audit.deficits.length === 0 ? null : { deficits: last.audit.deficits },
  )
  .ends(['delivered', 'unfinished'], c => c.out.buildAndAudit.exhausted ? 'unfinished' : 'delivered');

const decompositionFlow = H.flow('decomposition')
  .requires({ title: z.string(), description: z.string() })
  .step('plan', planner, c => ({ title: c.input.title, description: c.input.description }))
  .spawn('features', {
    outlet: 'feature',
    child: { slug: z.string(), title: z.string(), description: z.string() },
    items: c => c.out.plan.features,
  })
  .ends(['delivered', 'dropped'], c => c.out.features.every(child => child.verdict === 'success') ? 'delivered' : 'dropped');

const healthCheck = H.command('healthCheck', ['./scripts/health-check.sh']);

const probeFlow = H.flow('serviceProbe')
  .requires({ service: z.string() })
  .step('probe', healthCheck, c => ({ args: [c.input.service] }), { restart: 'rerun', timeoutMs: 60000 })
  .ends(['healthy'], () => 'healthy');

const linearConnection = { apiKey: H.env('LINEAR_API_KEY'), team: 'ENG' };
const trackerStatus = { Todo: 'Todo', Working: 'In Progress', Stalled: 'Blocked', Done: 'Done', Abandoned: 'Canceled' };
const worktrees = git.worktree({ repo: '.', base: 'main', slots: 3 });
const workRetry = H.retry.exponential({ maxRetries: 2, initialDelayMs: 300000 });

const bugs = H.lane('bugs', bugKind)
  .supply([
    linear.issues(bugKind, { ...linearConnection, labels: ['bug'] }, (issue, supply) =>
      issue.statusChanged && issue.status === 'Canceled'
        ? supply.event(`linear:${issue.identifier}`, 'canceledInTracker', {})
        : supply.create({
            attributes: { source: 'linear', ref: issue.identifier },
            fields: { title: issue.title, description: issue.description },
          })),
    folder.files(bugKind, 'bugs', (file, supply) =>
      supply.create({
        attributes: { source: 'folder', ref: file.path },
        fields: {
          title: typeof file.frontmatter.title === 'string' ? file.frontmatter.title : file.path,
          description: file.body,
        },
      })),
    H.supply.operator(),
  ])
  .store(linear.store(bugKind, { ...linearConnection, status: trackerStatus }))
  .handler(deliveryFlow, {
    states: { building: Working, delivered: Done, unfinished: Stalled },
    opens: Working,
    params: { rounds: 3 },
  })
  .runner(worktrees)
  .retry(workRetry)
  .wip(2)
  .reacts({ canceledInTracker: H.reaction(Abandoned).from([Todo, Working, Stalled]).cancels() });

const features = H.lane('features', featureKind)
  .supply([
    linear.issues(featureKind, { ...linearConnection, labels: ['feature'] }, (issue, supply) =>
      issue.statusChanged && issue.status === 'Canceled'
        ? supply.event(`linear:${issue.identifier}`, 'canceledInTracker', {})
        : supply.create({
            attributes: { source: 'linear', ref: issue.identifier },
            fields: { title: issue.title, description: issue.description },
          })),
    H.supply.operator(),
  ])
  .store(linear.store(featureKind, { ...linearConnection, status: trackerStatus }))
  .handler(deliveryFlow, {
    states: { building: Working, delivered: Done, unfinished: Stalled },
    opens: Working,
    params: { rounds: 5 },
  })
  .runner(worktrees)
  .retry(workRetry)
  .reacts({ canceledInTracker: H.reaction(Abandoned).from([Todo, Working, Stalled]).cancels() });

const epics = H.lane('epics', epicKind)
  .supply([
    linear.issues(epicKind, { ...linearConnection, labels: ['epic'] }, (issue, supply) =>
      supply.create({
        attributes: { ref: issue.identifier },
        fields: { title: issue.title, description: issue.description },
      })),
  ])
  .store(linear.store(epicKind, {
    ...linearConnection,
    status: { Planned: 'Todo', Decomposing: 'In Progress', Delivered: 'Done', Dropped: 'Canceled' },
  }))
  .handler(decompositionFlow, {
    states: { delivered: Delivered, dropped: Dropped },
    opens: Decomposing,
    spawns: {
      feature: child => features.unit({
        attributes: { source: 'epic', ref: child.slug },
        fields: { title: child.title, description: child.description },
      }),
    },
  })
  .wip(1);

const services = ['api', 'web', 'worker'];

const heartbeats = H.lane('heartbeats', heartbeatKind)
  .supply([
    H.supply.schedule(heartbeatKind, H.time.every({ minutes: 5 }), (c, supply) =>
      services.map(service => supply.create({ attributes: { service, tick: c.now } }))),
  ])
  .handler(probeFlow, { states: { healthy: Healthy }, opens: Probing })
  .runner(local.shell({ slots: 2 }));

const heartbeatFailureFilesBug = H.trigger('heartbeatFailureFilesBug', H.on.transition(heartbeats, { to: [Unhealthy] }))
  .creates(e => bugs.unit({
    attributes: { source: 'heartbeat', ref: e.unit.key },
    fields: {
      title: `Service heartbeat failed: ${e.unit.attributes.service}`,
      description: `The health check for ${e.unit.attributes.service} failed at ${new Date(e.unit.updatedAt).toISOString()}.`,
    },
  }));

const fourHoursMs = 4 * 60 * 60 * 1000;

const teamPriority = H.policy.schedule('teamPriority', c => ({
  start: c.order(
    candidate =>
      candidate.is(heartbeats) ? 0
        : candidate.is(bugs) ? 1
        : candidate.is(features) ? (candidate.waitedMs > fourHoursMs ? 1 : 2)
        : 3,
    candidate => candidate.enqueuedAt,
  ),
}));

const productionProbe = H.operation('probeProduction')
  .input({ endpoint: z.string() })
  .invokes(H.command('probeProduction', ['./scripts/probe-production.sh']), input => ({ args: [input.endpoint] }));

const ownerAccess = H.access('owner').allows([
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
  productionProbe,
]);

export const codingTeam = H.harness('coding-team')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes([heartbeats, bugs, features, epics])
  .triggers([heartbeatFailureFilesBug])
  .schedule(teamPriority)
  .clients([claudeCode.supervisor('supervisor', ownerAccess, { port: H.slot.port(0) })])
  .projections([markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md')]);
