import { H } from 'harness-dsl';
import { z } from 'zod';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as linear from 'harness-dsl/linear';
import * as folder from 'harness-dsl/folder';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as markdown from 'harness-dsl/markdown';
import * as git from 'harness-dsl/git';
import * as local from 'harness-dsl/local';

const tracker = { apiKey: H.env('LINEAR_API_KEY'), team: 'PRODUCT' };

const Todo = H.state('Todo', 'pending');
const Working = H.state('Working', 'active');
const Done = H.state('Done', 'terminal', 'success');
const Abandoned = H.state('Abandoned', 'terminal', 'failure');

const EpicOpen = H.state('EpicOpen', 'pending');
const EpicDone = H.state('EpicDone', 'terminal', 'success');
const EpicIncomplete = H.state('EpicIncomplete', 'terminal', 'failure');

const HeartbeatDue = H.state('HeartbeatDue', 'pending');
const Healthy = H.state('Healthy', 'terminal', 'success');
const Down = H.state('Down', 'terminal', 'failure');

const ticketFields = { title: z.string(), description: z.string(), url: z.string() };
const ticketAttributes = { ref: z.string(), priority: z.number() };

const Bug = H.work('Bug')
  .attributes(ticketAttributes)
  .fields(ticketFields)
  .states([Todo, Working, Done, Abandoned])
  .key((u) => u.attributes.ref);

const Feature = H.work('Feature')
  .attributes(ticketAttributes)
  .fields(ticketFields)
  .states([Todo, Working, Done, Abandoned])
  .key((u) => u.attributes.ref);

const Epic = H.work('Epic')
  .attributes(ticketAttributes)
  .fields(ticketFields)
  .states([EpicOpen, EpicDone, EpicIncomplete])
  .key((u) => u.attributes.ref);

const ServiceHeartbeat = H.work('ServiceHeartbeat')
  .attributes({ service: z.string(), due: z.number() })
  .states([HeartbeatDue, Healthy, Down])
  .key((u) => `${u.attributes.service}@${u.attributes.due}`);

const experience = H.memory.experience('experience');
const taste = H.memory.taste('taste');

const specificFirst = H.policy.recall('specific-first', (c) =>
  [...c.candidates]
    .sort(
      (a, b) =>
        b.specificity - a.specificity ||
        b.track.succeeded / Math.max(1, b.track.present) - a.track.succeeded / Math.max(1, a.track.present),
    )
    .slice(0, c.limit),
);

const experienceJournal = H.journal('experience-journal', experience)
  .store(jsonl.memory('memory/experience.jsonl'))
  .recall(specificFirst);
const tasteJournal = H.journal('taste-journal', taste)
  .store(jsonl.memory('memory/taste.jsonl'))
  .recall(specificFirst);

const subscriptionA = claudeCode.subscription('claude-a', { configDir: H.env('CLAUDE_A_DIR') });
const subscriptionB = claudeCode.subscription('claude-b', { configDir: H.env('CLAUDE_B_DIR') });
const subscriptionC = claudeCode.subscription('claude-c', { configDir: H.env('CLAUDE_C_DIR') });
const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });

const soonestExpiring = H.policy.account('soonest-expiring', (c) =>
  [...c.eligible].sort((a, b) => a.windowEndsAt - b.windowEndsAt).find((a) => a.eligible) ?? null,
);

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

const builderModel = H.policy.model('builder-model', [sonnet, opus], (c) => {
  if (c.unit === null) return sonnet;
  const cheap = c.metrics.success({ model: sonnet, kind: { name: c.unit.kind }, window: { days: 14 } });
  if (cheap.n < 20 || cheap.rate === null) return sonnet;
  return cheap.rate < 0.85 ? opus : sonnet;
});

const projectChecks = H.command('project-checks', ['npm', 'run', 'check']);

const builderRole = H.role('builder')
  .intents(['read', 'write', 'execute', 'search', 'ask'])
  .instructions('Implement the task in the worktree. Address every listed deficit. Ask the owner when a product decision is needed.')
  .input({ task: z.string(), details: z.string(), deficits: z.array(z.string()) })
  .output({ summary: z.string(), filesChanged: z.array(z.string()) });

const auditorRole = H.role('auditor')
  .intents(['read', 'execute', 'search', 'remember'])
  .instructions('Audit the change against the task. List concrete deficits; return none when the change is complete.')
  .input({ task: z.string(), summary: z.string(), filesChanged: z.array(z.string()) })
  .output({ deficits: z.array(z.string()) });

const plannerRole = H.role('planner')
  .intents(['read', 'search'])
  .instructions('Decompose the epic into independently shippable features.')
  .input({ epic: z.string() })
  .output({ features: z.array(z.object({ title: z.string(), description: z.string() })) });

const builder = H.agent('builder', builderRole)
  .model(builderModel)
  .pool(claudePool)
  .recalls([experienceJournal, tasteJournal])
  .leaseWrites()
  .mustPass(projectChecks);

const auditor = H.agent('auditor', auditorRole)
  .model(sonnet)
  .pool(claudePool)
  .recalls([experienceJournal])
  .records(experienceJournal);

const planner = H.agent('planner', plannerRole)
  .model(opus)
  .pool(claudePool)
  .recalls([tasteJournal]);

const ticketFlow = H.flow('build-and-audit')
  .requires({ title: z.string(), description: z.string() })
  .params({ rounds: z.number() })
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
        .step('audit', auditor, (c) => ({
          task: c.input.title,
          summary: c.out.build.summary,
          filesChanged: c.out.build.filesChanged,
        })),
    (last) => (last.audit.deficits.length > 0 ? { deficits: last.audit.deficits } : null),
  )
  .ends(['shipped', 'gaveUp'], (c) => (c.out.rounds.exhausted ? 'gaveUp' : 'shipped'));

const epicFlow = H.flow('decompose-epic')
  .requires({ title: z.string(), description: z.string() })
  .step('plan', planner, (c) => ({ epic: `${c.input.title}\n\n${c.input.description}` }))
  .spawn('features', {
    outlet: 'features',
    child: { ref: z.string(), title: z.string(), description: z.string() },
    items: (c) =>
      c.out.plan.features.map((f, i) => ({ ref: `${c.unit.key}-${i + 1}`, title: f.title, description: f.description })),
  })
  .ends(['complete', 'incomplete'], (c) =>
    c.out.features.every((f) => f.verdict === 'success') ? 'complete' : 'incomplete',
  );

const healthCheck = H.command('service-health', ['./scripts/health.sh']);

const heartbeatFlow = H.flow('service-heartbeat')
  .requires({ service: z.string() })
  .step('probe', healthCheck, (c) => ({ args: [c.input.service] }), { timeoutMs: 30_000, restart: 'rerun' })
  .ends(['ok'], () => 'ok');

const services = ['api', 'web', 'worker'];

const worktrees = git.worktree({ repo: '.', base: 'main', slots: 3 });

const bugLane = H.lane('bugs', Bug)
  .supply([
    linear.issues(Bug, { ...tracker, labels: ['bug'] }, (issue) => ({
      attributes: { ref: issue.identifier, priority: issue.priority },
      fields: { title: issue.title, description: issue.description, url: issue.url },
    })),
    folder.files(Bug, 'bugs', (file) => {
      const title = file.frontmatter['title'];
      const priority = file.frontmatter['priority'];
      return {
        attributes: { ref: file.path, priority: typeof priority === 'number' ? priority : 3 },
        fields: { title: typeof title === 'string' ? title : file.path, description: file.body, url: file.path },
      };
    }),
    H.supply.operator(),
  ])
  .store(linear.store(Bug, { ...tracker, status: { Todo: 'Todo', Working: 'In Progress', Done: 'Done', Abandoned: 'Canceled' } }))
  .runner(worktrees)
  .handler(ticketFlow, { states: { shipped: Done, gaveUp: Abandoned, failed: Abandoned }, params: { rounds: 3 } })
  .wip(2);

const featureLane = H.lane('features', Feature)
  .supply([
    linear.issues(Feature, { ...tracker, labels: ['feature'] }, (issue) => ({
      attributes: { ref: issue.identifier, priority: issue.priority },
      fields: { title: issue.title, description: issue.description, url: issue.url },
    })),
    H.supply.operator(),
  ])
  .store(linear.store(Feature, { ...tracker, status: { Todo: 'Todo', Working: 'In Progress', Done: 'Done', Abandoned: 'Canceled' } }))
  .runner(worktrees)
  .handler(ticketFlow, { states: { shipped: Done, gaveUp: Abandoned, failed: Abandoned }, params: { rounds: 5 } });

const epicLane = H.lane('epics', Epic)
  .supply([
    linear.issues(Epic, { ...tracker, labels: ['epic'] }, (issue) => ({
      attributes: { ref: issue.identifier, priority: issue.priority },
      fields: { title: issue.title, description: issue.description, url: issue.url },
    })),
  ])
  .store(linear.store(Epic, { ...tracker, status: { EpicOpen: 'Todo', EpicDone: 'Done', EpicIncomplete: 'Canceled' } }))
  .runner(worktrees)
  .handler(epicFlow, {
    states: { complete: EpicDone, incomplete: EpicIncomplete, failed: EpicOpen },
    spawns: {
      features: (child) =>
        featureLane.unit({
          attributes: { ref: child.ref, priority: 2 },
          fields: { title: child.title, description: child.description, url: '' },
        }),
    },
  })
  .wip(1);

const heartbeatLane = H.lane('heartbeats', ServiceHeartbeat)
  .supply([
    H.supply.schedule(ServiceHeartbeat, H.time.every({ minutes: 5 }), (c) =>
      services.map((service) => ({ create: { attributes: { service, due: c.now } } })),
    ),
  ])
  .runner(local.shell({ slots: 2 }))
  .handler(heartbeatFlow, { states: { ok: Healthy, failed: Down } });

const heartbeatFailureFilesBug = H.trigger('heartbeat-failure-files-bug', H.on.transition(heartbeatLane, { to: [Down] }))
  .creates((e) =>
    bugLane.unit({
      attributes: { ref: `heartbeat/${e.unit.attributes.service}/${e.unit.attributes.due}`, priority: 1 },
      fields: {
        title: `Heartbeat failed for ${e.unit.attributes.service}`,
        description: `The service heartbeat for ${e.unit.attributes.service} failed at ${new Date(e.unit.updatedAt).toISOString()}.`,
        url: '',
      },
    }),
  );

const starvationMs = 2 * 60 * 60 * 1000;

const teamSchedule = H.policy.schedule('heartbeats-bugs-features-epics', (c) => ({
  start: c.candidates
    .map((x) => ({
      x,
      rank:
        x.entry.lane === heartbeatLane.name
          ? 0
          : x.entry.lane === featureLane.name && x.waitedMs > starvationMs
            ? 1
            : x.entry.lane === bugLane.name
              ? 2
              : x.entry.lane === featureLane.name
                ? 3
                : 4,
    }))
    .sort((a, b) => a.rank - b.rank || b.x.waitedMs - a.x.waitedMs)
    .map((p) => p.x),
}));

const prodProbe = H.command('production-probe', ['./scripts/probe-production.sh']);
const probeProduction = H.operation('probeProduction')
  .input({ service: z.string() })
  .invokes(prodProbe, (input) => ({ args: [input.service] }));

const supervisorAccess = H.access('supervisor').allows([
  H.ops.readWork,
  H.ops.createWork,
  H.ops.updateWork,
  H.ops.resolveBlocks,
  H.ops.writeMemory,
  H.ops.readMemory,
  H.ops.readTelemetry,
  H.ops.readAccounts,
  H.ops.setShares,
  probeProduction,
]);

export const harness = H.harness('coding-team')
  .ledger(sqlite.ledger('state/ledger.sqlite'))
  .lanes([heartbeatLane, bugLane, featureLane, epicLane])
  .triggers([heartbeatFailureFilesBug])
  .schedule(teamSchedule)
  .clients([claudeCode.supervisor('supervisor', supervisorAccess, { port: H.slot.port(0) })])
  .projections([markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md')]);
