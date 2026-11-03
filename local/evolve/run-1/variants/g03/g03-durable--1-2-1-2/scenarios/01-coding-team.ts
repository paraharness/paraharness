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

const Queued = H.state('Queued', 'pending');
const Building = H.state('Building', 'active');
const Done = H.state('Done', 'terminal', 'success');
const Abandoned = H.state('Abandoned', 'terminal', 'neutral');
const Failed = H.state('Failed', 'terminal', 'failure');

const Planned = H.state('Planned', 'pending');
const Decomposing = H.state('Decomposing', 'active');
const Completed = H.state('Completed', 'terminal', 'success');
const Stalled = H.state('Stalled', 'terminal', 'failure');

const Due = H.state('Due', 'pending');
const Checking = H.state('Checking', 'active');
const Healthy = H.state('Healthy', 'terminal', 'success');
const Unhealthy = H.state('Unhealthy', 'terminal', 'failure');

const ticketShape = {
  issueId: z.string(),
  title: z.string(),
  description: z.string(),
  priority: z.number(),
};

const Bug = H.work('Bug')
  .attributes(ticketShape)
  .states([Queued, Building, Done, Abandoned, Failed])
  .key(u => u.attributes.issueId);

const Feature = H.work('Feature')
  .attributes({ ...ticketShape, epicId: z.string() })
  .states([Queued, Building, Done, Abandoned, Failed])
  .key(u => u.attributes.issueId);

const Epic = H.work('Epic')
  .attributes(ticketShape)
  .states([Planned, Decomposing, Completed, Stalled])
  .failsTo(Stalled)
  .key(u => u.attributes.issueId);

const ServiceHeartbeat = H.work('ServiceHeartbeat')
  .attributes({ service: z.string(), dueAt: z.number() })
  .states([Due, Checking, Healthy, Unhealthy])
  .failsTo(Unhealthy)
  .key(u => `${u.attributes.service}@${u.attributes.dueAt}`);

const Experience = H.memory.experience('codingExperience');
const Taste = H.memory.taste('ownerTaste').curated();

const bySpecificityAndTrack = H.policy.recall('bySpecificityAndTrack', c =>
  [...c.candidates]
    .sort((a, b) =>
      b.specificity - a.specificity ||
      b.track.succeeded / Math.max(b.track.present, 1) - a.track.succeeded / Math.max(a.track.present, 1))
    .slice(0, c.limit));

const experience = H.journal('experience', Experience)
  .store(jsonl.memory('.harness/experience.jsonl'))
  .recall(bySpecificityAndTrack);
const taste = H.journal('taste', Taste)
  .store(jsonl.memory('.harness/taste.jsonl'))
  .recall(bySpecificityAndTrack);

const subscriptionA = claudeCode.subscription('claudeA', { configDir: H.env('CLAUDE_CONFIG_A') });
const subscriptionB = claudeCode.subscription('claudeB', { configDir: H.env('CLAUDE_CONFIG_B') });
const subscriptionC = claudeCode.subscription('claudeC', { configDir: H.env('CLAUDE_CONFIG_C') });
const apiAccount = anthropic.account('anthropicApi', { apiKey: H.env('ANTHROPIC_API_KEY') });

const soonestExpiring = H.policy.account('soonestExpiring', c =>
  [...c.eligible].sort((a, b) => a.windowEndsAt - b.windowEndsAt)[0] ?? null);

const subscriptions = H.pool('subscriptions')
  .accounts([
    { account: subscriptionA, share: 0.8 },
    { account: subscriptionB, share: 0.8 },
    { account: subscriptionC, share: 0.6 },
  ])
  .prefer(soonestExpiring)
  .fallback(apiAccount);

const cheap = claudeCode.model('claude-sonnet-4-5');
const strong = claudeCode.model('claude-opus-4-1');

const builderModel = H.policy.model('builderModel', [cheap, strong], c => {
  const cheapRecord = c.metrics.success({ kind: c.unit?.kind, model: cheap, window: { days: 14 } });
  return cheapRecord.n >= 20 && cheapRecord.rate !== null && cheapRecord.rate < 0.85 ? strong : cheap;
});

const projectChecks = H.command('projectChecks', ['npm', 'run', 'check']);
const healthCheck = H.command('healthCheck', ['./scripts/health-check.sh']);
const productionProbe = H.command('productionProbe', ['./scripts/probe-production.sh']);

const builderRole = H.role('builder')
  .intents(['read', 'write', 'execute', 'search', 'ask'])
  .instructions('Implement the task in the worktree. Resolve every listed deficit. Ask the owner when a decision is theirs.')
  .input({ task: z.string(), deficits: z.array(z.string()) })
  .output({ summary: z.string() });

const auditorRole = H.role('auditor')
  .intents(['read', 'execute', 'search', 'remember'])
  .instructions('Audit the change against the task. List every deficit; list none when the work is complete.')
  .input({ task: z.string(), summary: z.string() })
  .output({ deficits: z.array(z.string()) });

const plannerRole = H.role('planner')
  .intents(['read', 'search'])
  .instructions('Decompose the epic into independently shippable features.')
  .input({ title: z.string(), description: z.string() })
  .output({ features: z.array(z.object({ title: z.string(), description: z.string() })) });

const builder = H.agent('builder', builderRole)
  .model(builderModel)
  .pool(subscriptions)
  .recalls([experience, taste])
  .leaseWrites()
  .mustPass(projectChecks);

const auditor = H.agent('auditor', auditorRole)
  .model(strong)
  .pool(subscriptions)
  .recalls([experience])
  .records(experience);

const planner = H.agent('planner', plannerRole)
  .model(strong)
  .pool(subscriptions)
  .recalls([taste]);

const ticketFlow = H.flow('ticket')
  .requires({ title: z.string(), description: z.string() })
  .params({ maxRounds: z.number() })
  .loop(
    'rounds',
    { carry: { deficits: z.array(z.string()) }, rounds: c => c.params.maxRounds },
    round => round
      .step('build', builder, c => ({
        task: `${c.input.title}\n\n${c.input.description}`,
        deficits: c.carry ? c.carry.deficits : [],
      }))
      .step('audit', auditor, c => ({ task: c.input.title, summary: c.out.build.summary })),
    last => (last.audit.deficits.length > 0 ? { deficits: last.audit.deficits } : null),
  )
  .ends(['done', 'exhausted'], c => (c.out.rounds.exhausted ? 'exhausted' : 'done'));

const heartbeatFlow = H.flow('heartbeat')
  .requires({ service: z.string() })
  .step('probe', healthCheck, c => ({ args: [c.input.service] }), { timeoutMs: 30_000, restart: 'rerun' })
  .ends(['healthy'], () => 'healthy');

const linearKey = H.env('LINEAR_API_KEY');
const ticketStatus = { Queued: 'Todo', Building: 'In Progress', Done: 'Done', Abandoned: 'Canceled', Failed: 'Canceled' };
const worktrees = git.worktree({ repo: '.', base: 'main', slots: 3 });
const ticketRetry = H.retry.exponential({ maxRetries: 2, initialDelayMs: 300_000, maxDelayMs: 3_600_000 });

const bugs = H.lane('bugs', Bug)
  .supply([
    linear.issues(Bug, { apiKey: linearKey, team: 'ENG', labels: ['bug'] }, (issue, supply) =>
      supply.create({
        attributes: { issueId: issue.identifier, title: issue.title, description: issue.description, priority: issue.priority },
      })),
    folder.files(Bug, 'bugs', (file, supply) =>
      supply.create({
        attributes: {
          issueId: file.path,
          title: String(file.frontmatter['title'] ?? file.path),
          description: file.body,
          priority: Number(file.frontmatter['priority'] ?? 3),
        },
      })),
    H.supply.operator(),
  ])
  .store(linear.store(Bug, { apiKey: linearKey, team: 'ENG', status: ticketStatus }))
  .handler(ticketFlow, { opens: Building, params: { maxRounds: 3 }, ends: { done: Done, exhausted: Failed } })
  .runner(worktrees)
  .retry(ticketRetry, { exhausted: Failed })
  .wip(2);

const features = H.lane('features', Feature)
  .supply([
    linear.issues(Feature, { apiKey: linearKey, team: 'ENG', labels: ['feature'] }, (issue, supply) =>
      issue.parentId === null
        ? supply.create({
            attributes: {
              issueId: issue.identifier,
              title: issue.title,
              description: issue.description,
              priority: issue.priority,
              epicId: '',
            },
          })
        : null),
    H.supply.operator(),
  ])
  .store(linear.store(Feature, { apiKey: linearKey, team: 'ENG', status: ticketStatus }))
  .handler(ticketFlow, { opens: Building, params: { maxRounds: 5 }, ends: { done: Done, exhausted: Failed } })
  .runner(worktrees)
  .retry(ticketRetry, { exhausted: Failed });

const epicFlow = H.flow('epic')
  .requires({ issueId: z.string(), title: z.string(), description: z.string() })
  .step('plan', planner, c => ({ title: c.input.title, description: c.input.description }))
  .spawn('features', {
    child: { epicId: z.string(), title: z.string(), description: z.string() },
    items: c => c.out.plan.features.map(f => ({ epicId: c.input.issueId, title: f.title, description: f.description })),
  })
  .ends(['completed', 'stalled'], c =>
    c.out.features.every(child => child.state.verdict === 'success') ? 'completed' : 'stalled');

const epics = H.lane('epics', Epic)
  .supply([
    linear.issues(Epic, { apiKey: linearKey, team: 'ENG', labels: ['epic'] }, (issue, supply) =>
      supply.create({
        attributes: { issueId: issue.identifier, title: issue.title, description: issue.description, priority: issue.priority },
      })),
  ])
  .store(linear.store(Epic, {
    apiKey: linearKey,
    team: 'ENG',
    status: { Planned: 'Todo', Decomposing: 'In Progress', Completed: 'Done', Stalled: 'Canceled' },
  }))
  .handler(epicFlow, {
    opens: Decomposing,
    ends: { completed: Completed, stalled: Stalled },
    spawns: {
      features: child => features.unit({
        attributes: {
          issueId: `${child.epicId}/${child.title}`,
          title: child.title,
          description: child.description,
          priority: 2,
          epicId: child.epicId,
        },
      }),
    },
  })
  .wip(1);

const services = ['api', 'web', 'worker'];

const heartbeats = H.lane('heartbeats', ServiceHeartbeat)
  .supply([
    H.supply.schedule(ServiceHeartbeat, H.time.every({ minutes: 5 }), (c, supply) =>
      services.map(service => supply.create({ attributes: { service, dueAt: c.now } }))),
  ])
  .handler(heartbeatFlow, { opens: Checking, ends: { healthy: Healthy } })
  .runner(local.shell({ slots: 3 }));

const heartbeatFailed = H.trigger('heartbeatFailed', H.on.transition(heartbeats, { to: [Unhealthy] }))
  .creates(e => bugs.unit({
    attributes: {
      issueId: `heartbeat/${e.unit.key}`,
      title: `Service ${e.unit.attributes.service} failed its heartbeat`,
      description: `The heartbeat due at ${new Date(e.unit.attributes.dueAt).toISOString()} failed.`,
      priority: 1,
    },
  }));

const starvationMs = 6 * 3_600_000;

const teamSchedule = H.policy.schedule('teamPriority', c => ({
  start: c.order(
    k => (k.is(heartbeats) ? 0 : k.is(bugs) ? 1 : k.is(features) ? (k.waitedMs > starvationMs ? 1 : 2) : 3),
    k => k.enqueuedAt,
  ),
}));

const probeProduction = H.operation('probeProduction')
  .input({ endpoint: z.string() })
  .invokes(productionProbe, input => ({ args: [input.endpoint] }));

const supervisorAccess = H.access('supervisor').allows([
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

export const codingTeam = H.harness('codingTeam')
  .ledger(sqlite.ledger('.harness/coding.db'))
  .lanes([heartbeats, bugs, features, epics])
  .triggers([heartbeatFailed])
  .schedule(teamSchedule)
  .clients([claudeCode.supervisor('supervisor', supervisorAccess, { port: H.slot.port(0) })])
  .projections([markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md')]);
