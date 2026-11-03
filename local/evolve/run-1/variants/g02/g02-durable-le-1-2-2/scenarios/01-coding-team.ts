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
const NeedsReview = H.state('NeedsReview', 'waiting');
const Done = H.state('Done', 'terminal', 'success');
const WontFix = H.state('WontFix', 'terminal', 'neutral');

const Planned = H.state('Planned', 'pending');
const Decomposing = H.state('Decomposing', 'active');
const Delivered = H.state('Delivered', 'terminal', 'success');
const Shortfall = H.state('Shortfall', 'terminal', 'failure');

const Due = H.state('Due', 'pending');
const Probing = H.state('Probing', 'active');
const Healthy = H.state('Healthy', 'terminal', 'success');
const Unhealthy = H.state('Unhealthy', 'terminal', 'failure');

const ticketAttributes = { ref: z.string(), priority: z.number() };
const ticketFields = { title: z.string(), description: z.string() };

const Bug = H.work('Bug')
  .attributes(ticketAttributes)
  .fields(ticketFields)
  .states([Todo, Building, NeedsReview, Done, WontFix])
  .key(u => u.attributes.ref);

const Feature = H.work('Feature')
  .attributes(ticketAttributes)
  .fields(ticketFields)
  .states([Todo, Building, NeedsReview, Done, WontFix])
  .key(u => u.attributes.ref);

const Epic = H.work('Epic')
  .attributes(ticketAttributes)
  .fields(ticketFields)
  .states([Planned, Decomposing, Delivered, Shortfall])
  .key(u => u.attributes.ref);

const ServiceHeartbeat = H.work('ServiceHeartbeat')
  .attributes({ service: z.string(), at: z.number() })
  .states([Due, Probing, Healthy, Unhealthy])
  .fails(Unhealthy)
  .key(u => `${u.attributes.service}@${u.attributes.at}`);

const experience = H.memory.experience('engineering-experience');
const taste = H.memory.taste('owner-taste');

const bySpecificityAndTrack = H.policy.recall('by-specificity-and-track-record', c =>
  [...c.candidates]
    .sort((a, b) =>
      b.specificity - a.specificity ||
      b.track.succeeded / Math.max(1, b.track.present) - a.track.succeeded / Math.max(1, a.track.present))
    .slice(0, c.limit));

const experienceJournal = H.journal('coding-experience', experience)
  .store(jsonl.memory('memory/experience.jsonl'))
  .recall(bySpecificityAndTrack);
const tasteJournal = H.journal('coding-taste', taste)
  .store(jsonl.memory('memory/taste.jsonl'))
  .recall(bySpecificityAndTrack);

const subscriptionA = claudeCode.subscription('max-a', { configDir: H.env('CLAUDE_CONFIG_A') });
const subscriptionB = claudeCode.subscription('max-b', { configDir: H.env('CLAUDE_CONFIG_B') });
const subscriptionC = claudeCode.subscription('max-c', { configDir: H.env('CLAUDE_CONFIG_C') });
const apiAccount = anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY') });

const soonestExpiringFirst = H.policy.account('soonest-expiring-first', c =>
  [...c.eligible].filter(a => a.eligible).sort((a, b) => a.windowEndsAt - b.windowEndsAt)[0] ?? null);

const claudePool = H.pool('claude-subscriptions')
  .accounts([
    { account: subscriptionA, share: 1 },
    { account: subscriptionB, share: 0.8 },
    { account: subscriptionC, share: 0.5 },
  ])
  .prefer(soonestExpiringFirst)
  .fallback(apiAccount);

const sonnet = claudeCode.model('claude-sonnet-4-5');
const opus = claudeCode.model('claude-opus-4-1');

const builderModel = H.policy.model('cheaper-until-it-slips', [sonnet, opus], c => {
  const cheaper = c.metrics.success({ kind: c.kind, agent: c.agent, model: sonnet, window: { days: 14 } });
  return cheaper.n >= 20 && cheaper.rate !== null && cheaper.rate < 0.85 ? opus : sonnet;
});

const projectChecks = H.command('project-checks', ['npm', 'run', 'check']);

const builderRole = H.role('builder')
  .intents(['read', 'write', 'execute', 'search', 'ask', 'remember'])
  .instructions('Implement the task. Resolve every listed deficit. Ask the owner when a decision is theirs.')
  .input({ task: z.string(), deficits: z.array(z.string()) })
  .output({ summary: z.string() });

const auditorRole = H.role('auditor')
  .intents(['read', 'execute', 'remember'])
  .instructions('Audit the change against the task. List every deficit; an empty list means done.')
  .input({ task: z.string(), summary: z.string() })
  .output({ deficits: z.array(z.string()) });

const plannerRole = H.role('planner')
  .intents(['read', 'search'])
  .instructions('Decompose the epic into independently shippable features.')
  .input({ title: z.string(), description: z.string() })
  .output({ features: z.array(z.object({ slug: z.string(), title: z.string(), description: z.string() })) });

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

const delivery = H.flow('build-and-audit')
  .requires({ title: z.string(), description: z.string() })
  .params({ maxRounds: z.number() })
  .loop(
    'rounds',
    { carry: { deficits: z.array(z.string()) }, rounds: c => c.params.maxRounds },
    round => round
      .step('build', builder, c => ({
        task: `${c.input.title}\n\n${c.input.description}`,
        deficits: c.carry === null ? [] : c.carry.deficits,
      }))
      .step('audit', auditor, c => ({ task: c.input.title, summary: c.out.build.summary })),
    last => last.audit.deficits.length === 0 ? null : { deficits: last.audit.deficits },
  )
  .ends(['done', 'exhausted'], c => c.out.rounds.exhausted ? 'exhausted' : 'done');

const decomposition = H.flow('decompose-epic')
  .requires({ title: z.string(), description: z.string() })
  .step('plan', planner, c => ({ title: c.input.title, description: c.input.description }))
  .spawn('features', {
    outlet: 'feature',
    child: { slug: z.string(), title: z.string(), description: z.string() },
    items: c => c.out.plan.features,
  })
  .ends(['delivered', 'shortfall'], c =>
    c.out.features.every(feature => feature.verdict === 'success') ? 'delivered' : 'shortfall');

const heartbeat = H.flow('service-heartbeat')
  .requires({ service: z.string() })
  .step('probe', H.command('probe-service', ['./scripts/heartbeat.sh']), c => ({ args: [c.input.service] }), { timeoutMs: 30000 })
  .ends(['healthy'], () => 'healthy');

const linearKey = H.env('LINEAR_API_KEY');
const worktrees = git.worktree({ repo: '.', base: 'main', slots: 3 });
const ticketStatus = { Todo: 'Todo', Building: 'In Progress', NeedsReview: 'In Review', Done: 'Done', WontFix: 'Canceled' };

const bugLane = H.lane('bugs', Bug)
  .supply([
    linear.issues(Bug, { apiKey: linearKey, team: 'ENG', labels: ['bug'] }, (issue, to) =>
      to.create({
        attributes: { ref: issue.identifier, priority: issue.priority },
        fields: { title: issue.title, description: issue.description },
      })),
    folder.files(Bug, 'bugs', (file, to) => {
      const title = file.frontmatter.title;
      const priority = file.frontmatter.priority;
      return to.create({
        attributes: { ref: file.path, priority: typeof priority === 'number' ? priority : 3 },
        fields: { title: typeof title === 'string' ? title : file.path, description: file.body },
      });
    }),
    H.supply.operator(),
  ])
  .store(linear.store(Bug, { apiKey: linearKey, team: 'ENG', status: ticketStatus }))
  .runner(worktrees)
  .wip(2)
  .handler(delivery, { ends: { done: Done, exhausted: NeedsReview }, params: { maxRounds: 3 } });

const featureLane = H.lane('features', Feature)
  .supply([
    linear.issues(Feature, { apiKey: linearKey, team: 'ENG', labels: ['feature'] }, (issue, to) =>
      to.create({
        attributes: { ref: issue.identifier, priority: issue.priority },
        fields: { title: issue.title, description: issue.description },
      })),
    H.supply.operator(),
  ])
  .store(linear.store(Feature, { apiKey: linearKey, team: 'ENG', status: ticketStatus }))
  .runner(worktrees)
  .handler(delivery, { ends: { done: Done, exhausted: NeedsReview }, params: { maxRounds: 5 } });

const epicLane = H.lane('epics', Epic)
  .supply([
    linear.issues(Epic, { apiKey: linearKey, team: 'ENG', labels: ['epic'] }, (issue, to) =>
      to.create({
        attributes: { ref: issue.identifier, priority: issue.priority },
        fields: { title: issue.title, description: issue.description },
      })),
  ])
  .store(linear.store(Epic, {
    apiKey: linearKey,
    team: 'ENG',
    status: { Planned: 'Todo', Decomposing: 'In Progress', Delivered: 'Done', Shortfall: 'Canceled' },
  }))
  .wip(1)
  .handler(decomposition, {
    ends: { delivered: Delivered, shortfall: Shortfall },
    spawns: {
      feature: child => featureLane.unit({
        attributes: { ref: child.slug, priority: 2 },
        fields: { title: child.title, description: child.description },
      }),
    },
  });

const heartbeatLane = H.lane('heartbeats', ServiceHeartbeat)
  .supply([
    H.supply.schedule(ServiceHeartbeat, H.time.every({ minutes: 5 }), (c, to) =>
      ['api', 'web', 'worker'].map(service => to.create({ attributes: { service, at: c.now } }))),
  ])
  .runner(local.shell({ slots: 2 }))
  .handler(heartbeat, { ends: { healthy: Healthy } });

const unhealthyServiceFilesBug = H.trigger('unhealthy-service-files-bug', H.on.transition(heartbeatLane, { to: [Unhealthy] }))
  .creates(e => bugLane.unit({
    attributes: { ref: `heartbeat-${e.unit.attributes.service}-${e.unit.attributes.at}`, priority: 1 },
    fields: {
      title: `Service ${e.unit.attributes.service} failed its heartbeat`,
      description: `Heartbeat ${e.unit.key} ended ${e.to}. Investigate and restore the service.`,
    },
  }));

const workOrder = H.policy.schedule('heartbeats-bugs-features-epics', c => ({
  start: c.candidates
    .map(candidate => ({
      candidate,
      rank: candidate.is(heartbeatLane) ? 0
        : candidate.is(featureLane) && candidate.waitedMs > 2 * 3600000 ? 1
        : candidate.is(bugLane) ? 2
        : candidate.is(featureLane) ? 3
        : 4,
    }))
    .sort((a, b) => a.rank - b.rank || b.candidate.waitedMs - a.candidate.waitedMs)
    .map(ranked => ranked.candidate),
}));

const probeProduction = H.operation('probe-production-health')
  .input({ url: z.string() })
  .invokes(H.command('production-health', ['./scripts/prod-health.sh']), input => ({ args: [input.url] }));

const ownerAccess = H.access('owner')
  .allows([
    H.ops.readWork,
    H.ops.createWork,
    H.ops.updateWork,
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
  .lanes([bugLane, featureLane, epicLane, heartbeatLane])
  .triggers([unhealthyServiceFilesBug])
  .schedule(workOrder)
  .clients([claudeCode.supervisor('supervisor', ownerAccess, { port: H.slot.port(0) })])
  .projections([markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md')]);
