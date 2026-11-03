import { z } from 'zod';
import { H } from 'harness-dsl';
import type { PendingUnit } from 'harness-dsl';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { linear } from 'harness-dsl/linear';
import type { LinearIssue } from 'harness-dsl/linear';
import { folder } from 'harness-dsl/folder';
import { manual, schedule } from 'harness-dsl/supply';
import { drainSoonestExpiring, byApplicability } from 'harness-dsl/policies';
import { board, telemetry } from 'harness-dsl/observers';
import { fileLeaseGuard, gitWorktreeIsolation, stopCommandHook } from 'harness-dsl/plugins';
import { local } from 'harness-dsl/local';

const ticket = z.object({
  title: z.string(),
  description: z.string(),
  files: z.array(z.string()),
});
type Ticket = z.infer<typeof ticket>;

const epic = z.object({ title: z.string(), description: z.string() });
type EpicData = z.infer<typeof epic>;

const heartbeat = z.object({ service: z.string(), url: z.string() });
type HeartbeatData = z.infer<typeof heartbeat>;

const Todo = H.state('todo').pending();
const Working = H.state('working').active();
const Done = H.state('done').succeeded();
const Abandoned = H.state('abandoned').failed();
const Cancelled = H.state('cancelled').cancelled();
const AwaitingFeatures = H.state('awaiting-features').active();
const FeaturesFinished = H.state('features-finished').pending();
const HeartbeatDue = H.state('heartbeat-due').pending();
const Healthy = H.state('healthy').succeeded();
const Unhealthy = H.state('unhealthy').failed();

const Bug = H.work('bug')
  .schema(ticket)
  .states(Todo, Working, Done, Abandoned, Cancelled)
  .resources(bug => bug.files);
const Feature = H.work('feature')
  .schema(ticket)
  .states(Todo, Working, Done, Abandoned, Cancelled)
  .resources(feature => feature.files);
const Epic = H.work('epic')
  .schema(epic)
  .states(Todo, Working, AwaitingFeatures, FeaturesFinished, Done, Abandoned, Cancelled);
const ServiceHeartbeat = H.work('service-heartbeat')
  .schema(heartbeat)
  .states(HeartbeatDue, Healthy, Unhealthy);

const Experience = H.memory('experience').content(
  z.object({ do: z.string(), when: z.string(), because: z.string() }),
);
const Taste = H.memory('taste').content(z.object({ prefer: z.string(), over: z.string() }));

const experience = H.journal('experience')
  .of(Experience)
  .store(jsonl.store('.harness/experience.jsonl'))
  .recall(byApplicability({ budgetTokens: 2000 }));
const taste = H.journal('taste')
  .of(Taste)
  .store(jsonl.store('.harness/taste.jsonl'))
  .recall(byApplicability({ budgetTokens: 1000 }));

const max1 = H.account('claude-max-1', claudeCode.driver({ configDir: '~/.claude-max-1' }));
const max2 = H.account('claude-max-2', claudeCode.driver({ configDir: '~/.claude-max-2' }));
const max3 = H.account('claude-max-3', claudeCode.driver({ configDir: '~/.claude-max-3' }));
const apiAccount = H.account('anthropic-api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') }));

const subscriptions = H.pool('subscriptions', [max1, max2, max3])
  .policy(drainSoonestExpiring())
  .maxShare(max1, 0.8)
  .maxShare(max2, 0.8)
  .maxShare(max3, 0.5)
  .fallback(apiAccount);

const sonnet = H.model('sonnet', subscriptions, 'claude-sonnet-4-5');
const opus = H.model('opus', subscriptions, 'claude-opus-4-1');

const cheaperUntilUnreliable = H.policy.choose('cheaper-until-unreliable', ctx => {
  const cheaper = ctx.metrics.outcomes({ kind: ctx.unit?.kind, model: sonnet.name, window: '14d' });
  const unreliable =
    cheaper.samples >= 20 && cheaper.successRate !== null && cheaper.successRate < 0.85;
  const preferred = unreliable ? opus.name : sonnet.name;
  return [...ctx.candidates].sort(
    (a, b) => Number(b.name === preferred) - Number(a.name === preferred),
  );
});

const builderModels = H.pool('builder-models', [sonnet, opus]).policy(cheaperUntilUnreliable);

const builderRole = H.role('builder')
  .prompt('Implement the work item completely. Halt for an owner decision when the item is ambiguous.')
  .tools('read-files', 'edit-files', 'run-commands', 'halt-for-decision')
  .recall(Experience, Taste)
  .use(
    gitWorktreeIsolation({ root: '.worktrees', baseBranch: 'main' }),
    fileLeaseGuard(),
    stopCommandHook('npm run check', { timeoutMs: 600000 }),
  );
const auditorRole = H.role('auditor')
  .prompt('List every deficit between the work item and the change. Record lessons future builders need.')
  .tools('read-files', 'run-commands', 'record-memory')
  .recall(Experience)
  .record(Experience);
const plannerRole = H.role('planner')
  .prompt('Decompose the epic into independently shippable features.')
  .tools('read-files')
  .recall(Taste);

const builder = H.agent('builder').role(builderRole).model(builderModels);
const auditor = H.agent('auditor').role(auditorRole).model(opus);
const planner = H.agent('planner').role(plannerRole).model(opus);

const build = H.skill('build')
  .input(z.object({ title: z.string(), description: z.string(), deficits: z.array(z.string()) }))
  .prompt(
    work => `${work.title}\n\n${work.description}\n\nOpen deficits:\n${work.deficits.join('\n')}`,
  );
const audit = H.skill('audit')
  .input(z.object({ title: z.string(), description: z.string(), buildReport: z.string() }))
  .output(z.object({ deficits: z.array(z.string()) }))
  .prompt(work => `${work.title}\n\n${work.description}\n\nBuilder report:\n${work.buildReport}`);
const planFeatures = H.skill('plan-features')
  .input(epic)
  .output(z.object({ features: z.array(ticket) }))
  .prompt(work => `${work.title}\n\n${work.description}`);

type Review = { readonly deficits: readonly string[] };
const noDeficits: Review = { deficits: [] };

const buildAndAudit = H.flow('build-and-audit')
  .for(Bug, Feature)
  .settings(z.object({ maxRounds: z.number().int().positive() }))
  .transition(Working)
  .map((): Review => noDeficits)
  .loop({
    maxIterations: ctx => ctx.settings.maxRounds,
    body: round =>
      round
        .step('build', build.by(builder), {
          input: (review, ctx) => ({
            title: ctx.unit.data.title,
            description: ctx.unit.data.description,
            deficits: [...review.deficits],
          }),
        })
        .step('audit', audit.by(auditor), {
          input: (buildReport, ctx) => ({
            title: ctx.unit.data.title,
            description: ctx.unit.data.description,
            buildReport,
          }),
        })
        .map((found): Review => found),
    until: review => review.deficits.length === 0,
  })
  .transition(review => (review.deficits.length === 0 ? Done : Abandoned))
  .onError(Abandoned);

const linearKey = H.env('LINEAR_API_KEY');
const trackerStates = {
  todo: 'Todo',
  working: 'In Progress',
  'awaiting-features': 'In Progress',
  'features-finished': 'In Progress',
  done: 'Done',
  abandoned: 'Canceled',
  cancelled: 'Canceled',
};
const ticketFromIssue = (issue: LinearIssue): Ticket => ({
  title: issue.title,
  description: issue.description,
  files: [],
});
const epicFromIssue = (issue: LinearIssue): EpicData => ({
  title: issue.title,
  description: issue.description,
});

const bugs = H.lane('bugs')
  .of(Bug)
  .from(
    linear.supply<Ticket>({ apiKey: linearKey, team: 'ENG', labels: ['bug'], map: ticketFromIssue }),
    folder.supply<Ticket>({
      path: 'inbox/bugs',
      map: file => ({ title: file.name, description: file.body, files: [] }),
    }),
    manual<Ticket>(),
  )
  .store(linear.store<Ticket>({ apiKey: linearKey, team: 'ENG', map: ticketFromIssue, states: trackerStates }))
  .handle(buildAndAudit, { maxRounds: 3 })
  .wip(2);

const features = H.lane('features')
  .of(Feature)
  .from(
    linear.supply<Ticket>({ apiKey: linearKey, team: 'ENG', labels: ['feature'], map: ticketFromIssue }),
    manual<Ticket>(),
  )
  .store(linear.store<Ticket>({ apiKey: linearKey, team: 'ENG', map: ticketFromIssue, states: trackerStates }))
  .handle(buildAndAudit, { maxRounds: 5 });

const decomposeEpic = H.flow('decompose-epic')
  .for(Epic)
  .when(
    (_, ctx) => ctx.children.length > 0,
    finished =>
      finished.transition((_, ctx) =>
        ctx.children.every(child => child.state.outcome === 'succeeded') ? Done : Abandoned,
      ),
  )
  .transition(Working)
  .step('plan', planFeatures.by(planner), { input: (_, ctx) => ctx.unit.data })
  .spawn('features', features, planned => planned.features, {
    waitIn: AwaitingFeatures,
    resumeIn: FeaturesFinished,
  });

const epics = H.lane('epics')
  .of(Epic)
  .from(linear.supply<EpicData>({ apiKey: linearKey, team: 'ENG', labels: ['epic'], map: epicFromIssue }))
  .store(linear.store<EpicData>({ apiKey: linearKey, team: 'ENG', map: epicFromIssue, states: trackerStates }))
  .handle(decomposeEpic)
  .wip(1);

const localRunner = H.runner('local', local()).slots(4);

const probeService = H.command('probe-service')
  .input(heartbeat)
  .output(z.object({ healthy: z.boolean(), detail: z.string() }))
  .runner(localRunner)
  .run(async ({ input, exec }) => {
    const result = await exec(`curl -fsS --max-time 10 ${input.url}`);
    return { healthy: result.exitCode === 0, detail: result.stderr };
  });

const heartbeatFlow = H.flow('heartbeat')
  .for(ServiceHeartbeat)
  .step('probe', probeService)
  .transition(probe => (probe.healthy ? Healthy : Unhealthy))
  .onError(Unhealthy);

const services: readonly HeartbeatData[] = [
  { service: 'api', url: 'https://api.example.com/health' },
  { service: 'web', url: 'https://www.example.com/health' },
];

const heartbeats = H.lane('heartbeats')
  .of(ServiceHeartbeat)
  .from(
    schedule<HeartbeatData>({ every: '5m' }, tick =>
      services.map(service => ({
        key: `${service.service}@${tick.now.toISOString()}`,
        data: service,
      })),
    ),
  )
  .handle(heartbeatFlow);

const unhealthyServiceFilesBug = H.trigger('unhealthy-service-files-bug')
  .on(heartbeats.enters(Unhealthy))
  .add(bugs, failure => ({
    title: `Service ${failure.unit.data.service} failed its heartbeat`,
    description: `Heartbeat at ${failure.at.toISOString()} found ${failure.unit.data.url} unhealthy.`,
    files: [],
  }));

const lanePriority = [heartbeats.name, bugs.name, features.name, epics.name];
const featureStarvationMs = 6 * 60 * 60 * 1000;
const rank = (unit: PendingUnit, now: Date): number => {
  if (unit.lane === features.name && now.getTime() - unit.enqueuedAt.getTime() > featureStarvationMs) {
    return 0.5;
  }
  const index = lanePriority.indexOf(unit.lane);
  return index === -1 ? lanePriority.length : index;
};

const scheduler = H.scheduler('team')
  .concurrency(4)
  .policy(
    H.policy.schedule('heartbeats-bugs-features-epics', ctx => ({
      start: [...ctx.pending].sort(
        (a, b) =>
          rank(a, ctx.now) - rank(b, ctx.now) || a.enqueuedAt.getTime() - b.enqueuedAt.getTime(),
      ),
    })),
  );

const probeProduction = H.command('probe-production')
  .output(z.object({ healthy: z.boolean(), status: z.number() }))
  .runner(localRunner)
  .run(async ({ exec }) => {
    const result = await exec('curl -s -o /dev/null -w "%{http_code}" https://www.example.com/health');
    const status = Number(result.stdout.trim());
    return { healthy: status === 200, status };
  });

const supervisor = H.supervisor('owner')
  .client(claudeCode.client({ port: 7400 }))
  .grant(
    H.ops.work.read,
    H.ops.work.write,
    H.ops.blockers.resolve,
    H.ops.memory.write,
    H.ops.telemetry.read,
    H.ops.accounts.manage,
    H.operation('production-health', probeProduction),
  );

export const codingTeam = H.harness('coding-team')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(heartbeats, bugs, features, epics)
  .journals(experience, taste)
  .triggers(unhealthyServiceFilesBug)
  .scheduler(scheduler)
  .supervisor(supervisor)
  .observe(board('BOARD.md'), telemetry('TELEMETRY.md'));

export const running = codingTeam.start();
