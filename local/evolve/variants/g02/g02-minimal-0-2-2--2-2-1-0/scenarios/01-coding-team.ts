import { z } from 'zod';
import { H, type PendingView } from 'harness-dsl';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as linear from 'harness-dsl/linear';
import * as folder from 'harness-dsl/folder';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as git from 'harness-dsl/git';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const open = H.state('open', 'pending');
const done = H.state('done', 'terminal', 'success');
const declined = H.state('declined', 'terminal', 'neutral');
const stuck = H.state('stuck', 'terminal', 'failure');
const planned = H.state('planned', 'pending');
const decomposed = H.state('decomposed', 'waiting');
const due = H.state('due', 'pending');
const healthy = H.state('healthy', 'terminal', 'success');
const unhealthy = H.state('unhealthy', 'terminal', 'failure');

const bugSchema = z.object({ title: z.string(), description: z.string() });
const featureSchema = z.object({ title: z.string(), description: z.string(), epic: z.string().optional() });
type FeatureData = z.infer<typeof featureSchema>;

const bug = H.kind('Bug').data(bugSchema).states(open, done, declined, stuck);
const feature = H.kind('Feature').data(featureSchema).states(open, done, declined, stuck);
const epic = H.kind('Epic').data(z.object({ title: z.string(), description: z.string() })).states(planned, decomposed, done, stuck);
const heartbeat = H.kind('ServiceHeartbeat').data(z.object({ service: z.string(), url: z.string() })).states(due, healthy, unhealthy);

const experience = H.memory('codingExperience', 'experience');
const taste = H.memory('ownerTaste', 'taste');
const experienceJournal = H.journal('experienceJournal', experience, jsonl.memory('memory/experience.jsonl'));
const tasteJournal = H.journal('tasteJournal', taste, jsonl.memory('memory/taste.jsonl'));

const worktree = git.worktree('worktree', { repo: '.', slots: 3 });
const local = shell.local('local', { slots: 2 });

const sonnet = claudeCode.model('claude-sonnet-4-5');
const opus = claudeCode.model('claude-opus-4-1');

const maxOne = claudeCode.subscription('maxOne', { token: H.env('CLAUDE_MAX_ONE_TOKEN') });
const maxTwo = claudeCode.subscription('maxTwo', { token: H.env('CLAUDE_MAX_TWO_TOKEN') });
const maxThree = claudeCode.subscription('maxThree', { token: H.env('CLAUDE_MAX_THREE_TOKEN') });
const apiAccount = anthropic.account('apiFallback', { apiKey: H.env('ANTHROPIC_API_KEY') });

const soonestExpiring = H.policy.account('soonestExpiringFirst', choice => {
  const subscriptions = choice.accounts
    .filter(view => view.eligible && view.account.plan === 'subscription' && view.usedShare < view.share)
    .sort((a, b) => (a.windowEndsAt?.getTime() ?? Infinity) - (b.windowEndsAt?.getTime() ?? Infinity));
  const first = subscriptions[0];
  if (first !== undefined) return first.account;
  const fallback = choice.accounts.find(view => view.eligible && view.account === apiAccount);
  return fallback === undefined ? null : fallback.account;
});

const claudePool = H.pool(
  'claudePool',
  [
    { account: maxOne, share: 0.5 },
    { account: maxTwo, share: 0.3 },
    { account: maxThree, share: 0.2 },
    { account: apiAccount, share: 1 },
  ],
  soonestExpiring
);

const builderModel = H.policy.model('cheapUntilWeak', [sonnet, opus], choice => {
  const cheap = choice.metrics.successRate({ kind: choice.kind, seat: choice.seat, model: sonnet, days: 14 });
  if (cheap.samples < 20 || cheap.value === null) return sonnet;
  return cheap.value < 0.85 ? opus : sonnet;
});

const checks = H.command('runProjectChecks').argv(() => ['npm', 'run', 'check']).on(worktree).recovery('rerun');

const buildRole = H.role('build')
  .input(z.object({ title: z.string(), description: z.string(), feedback: z.array(z.string()) }))
  .output(z.object({ summary: z.string(), question: z.string().optional() }))
  .prompt(input => `Implement: ${input.title}\n\n${input.description}\n\nOpen deficits:\n${input.feedback.join('\n')}`)
  .intents(['read', 'edit', 'execute']);

const auditRole = H.role('audit')
  .input(z.object({ title: z.string(), description: z.string(), summary: z.string() }))
  .output(z.object({ deficits: z.array(z.string()) }))
  .prompt(input => `Audit the change for "${input.title}" against:\n${input.description}\n\nBuilder summary:\n${input.summary}`)
  .intents(['read', 'execute']);

const planRole = H.role('plan')
  .input(z.object({ title: z.string(), description: z.string() }))
  .output(z.object({ features: z.array(z.object({ title: z.string(), description: z.string() })) }))
  .prompt(input => `Decompose the epic "${input.title}" into features:\n${input.description}`)
  .intents(['read']);

const builder = H.seat('builder', buildRole)
  .model(builderModel)
  .on(worktree)
  .recalls(experienceJournal, tasteJournal)
  .guards(claudeCode.fileLeases(), claudeCode.stopCheck(checks));

const auditor = H.seat('auditor', auditRole)
  .model(sonnet)
  .on(worktree)
  .recalls(experienceJournal)
  .records(experienceJournal);

const planner = H.seat('planner', planRole).model(opus).recalls(tasteJournal);

const ownerDecision = H.halt('ownerDecision', z.object({ proceed: z.boolean(), guidance: z.string() }));

const buildAndAudit = H.flow('buildAndAudit')
  .for(bug, feature)
  .params(z.object({ rounds: z.number() }))
  .does(async ctx => {
    const { title, description } = ctx.unit.data;
    let feedback: string[] = [];
    for (let round = 1; round <= ctx.params.rounds; round++) {
      const built = await ctx.run(builder, { title, description, feedback });
      if (!built.ok) return ctx.fail(built.error);
      if (built.value.question !== undefined) {
        const answer = await ctx.halt(ownerDecision, built.value.question);
        if (!answer.proceed) return 'declined';
        feedback = [...feedback, answer.guidance];
        continue;
      }
      const audit = await ctx.run(auditor, { title, description, summary: built.value.summary });
      if (!audit.ok) return ctx.fail(audit.error);
      if (audit.value.deficits.length === 0) return 'done';
      feedback = audit.value.deficits;
    }
    return ctx.fail('rounds ran out with deficits remaining');
  });

const probe = H.command('probeService')
  .input(z.object({ url: z.string() }))
  .argv(input => ['curl', '-fsS', input.url])
  .on(local)
  .recovery('rerun');

const heartbeatFlow = H.flow('heartbeatCheck')
  .for(heartbeat)
  .does(async ctx => {
    const result = await ctx.run(probe, { url: ctx.unit.data.url });
    return result.ok ? 'healthy' : 'unhealthy';
  });

const linearKey = H.env('LINEAR_API_KEY');

const bugTracker = linear.tracker(bug, {
  apiKey: linearKey,
  team: 'PRODUCT',
  label: 'bug',
  read: issue => ({ title: issue.title, description: issue.description }),
  statuses: { open: 'Todo', done: 'Done', declined: 'Canceled', stuck: 'Blocked' },
});

const featureTracker = linear.tracker(feature, {
  apiKey: linearKey,
  team: 'PRODUCT',
  label: 'feature',
  read: issue => ({ title: issue.title, description: issue.description, epic: issue.parentId }),
  statuses: { open: 'Todo', done: 'Done', declined: 'Canceled', stuck: 'Blocked' },
});

const epicTracker = linear.tracker(epic, {
  apiKey: linearKey,
  team: 'PRODUCT',
  label: 'epic',
  read: issue => ({ title: issue.title, description: issue.description }),
  statuses: { planned: 'Todo', decomposed: 'In Progress', done: 'Done', stuck: 'Blocked' },
});

const bugFolder = folder.files(bug, {
  dir: 'bugs',
  read: file => ({
    title: typeof file.frontmatter.title === 'string' ? file.frontmatter.title : file.path,
    description: file.body,
  }),
});

const services = [
  { service: 'api', url: 'https://api.example.com/health' },
  { service: 'web', url: 'https://www.example.com/health' },
];

const heartbeatSchedule = H.schedule('heartbeatEveryFiveMinutes', heartbeat, { every: { minutes: 5 } }, () =>
  services.map(service => ({ create: service }))
);

const retryBackoff = { first: { minutes: 10 }, factor: 2, max: { hours: 2 } };

const heartbeats = H.lane('heartbeats', heartbeat)
  .handler(heartbeatFlow)
  .retries(0, { exhausted: 'unhealthy' })
  .suppliers(heartbeatSchedule);

const bugs = H.lane('bugs', bug)
  .handler(buildAndAudit, { rounds: 3 })
  .retries(2, { backoff: retryBackoff, exhausted: 'stuck' })
  .suppliers(bugTracker, bugFolder, H.operator)
  .store(bugTracker)
  .wip(2);

const features = H.lane('features', feature)
  .handler(buildAndAudit, { rounds: 5 })
  .retries(2, { backoff: retryBackoff, exhausted: 'stuck' })
  .suppliers(featureTracker, H.operator)
  .store(featureTracker);

const decomposeEpic = H.flow('decomposeEpic')
  .for(epic)
  .does(async ctx => {
    const plan = await ctx.run(planner, { title: ctx.unit.data.title, description: ctx.unit.data.description });
    if (!plan.ok) return ctx.fail(plan.error);
    const children = await ctx.spawn(
      features,
      plan.value.features.map((item): FeatureData => ({ title: item.title, description: item.description, epic: ctx.unit.key }))
    );
    const finished = await ctx.suspend('decomposed', { children });
    return finished.every(child => child.state === 'done') ? 'done' : 'stuck';
  });

const epics = H.lane('epics', epic)
  .handler(decomposeEpic)
  .retries(1, { backoff: retryBackoff, exhausted: 'stuck' })
  .suppliers(epicTracker)
  .store(epicTracker)
  .wip(1);

const heartbeatBug = H.trigger('failedHeartbeatOpensBug', H.on.enters(heartbeat, 'unhealthy'), (event, act) =>
  act.create(
    bugs,
    {
      title: `Service ${event.unit.data.service} failed its heartbeat`,
      description: `The health probe at ${event.unit.data.url} failed at ${event.at.toISOString()}.`,
    },
    `heartbeat-${event.unit.data.service}`
  )
);

const featureStarvationMs = 2 * 60 * 60 * 1000;

const rank = (unit: PendingView): number => {
  if (unit.is(heartbeat)) return 0;
  if (unit.is(feature) && unit.waitedMs > featureStarvationMs) return 1;
  if (unit.is(bug)) return 2;
  if (unit.is(feature)) return 3;
  return 4;
};

const codingOrder = H.policy.scheduler('heartbeatsBugsFeaturesEpics', view => ({
  start: [...view.pending].sort((a, b) => rank(a) - rank(b) || b.waitedMs - a.waitedMs),
}));

const productionHealth = H.operation(
  'productionHealthProbe',
  H.command('probeProduction').argv(() => ['curl', '-fsS', 'https://www.example.com/health']).on(local)
);

const supervisor = claudeCode.supervisor({
  grants: [
    H.ops.readWork,
    H.ops.writeWork,
    H.ops.resolveHalts,
    H.ops.writeMemory,
    H.ops.readTelemetry,
    H.ops.readAccounts,
    H.ops.setShares,
    productionHealth,
  ],
});

export const coding = H.harness('codingTeam')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(heartbeats, bugs, features, epics)
  .pools(claudePool)
  .triggers(heartbeatBug)
  .scheduler(codingOrder)
  .clients(supervisor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));

export const running = coding.start();
