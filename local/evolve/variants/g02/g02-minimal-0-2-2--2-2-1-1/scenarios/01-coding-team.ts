import { z } from 'zod';
import { H, type PendingView } from 'harness-dsl';
import * as claude from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as linear from 'harness-dsl/linear';
import * as folder from 'harness-dsl/folder';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as git from 'harness-dsl/git';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const todo = H.state('todo', 'pending');
const done = H.state('done', 'terminal', 'success');
const abandoned = H.state('abandoned', 'terminal', 'failure');
const wontFix = H.state('wont-fix', 'terminal', 'neutral');
const due = H.state('due', 'pending');
const healthy = H.state('healthy', 'terminal', 'success');
const unhealthy = H.state('unhealthy', 'terminal', 'failure');

const workItem = z.object({
  title: z.string(),
  description: z.string(),
  parentId: z.string().optional(),
});

const epic = H.kind('epic').data(workItem).states(todo, done, abandoned);
const feature = H.kind('feature').data(workItem).states(todo, done, abandoned, wontFix);
const bug = H.kind('bug').data(workItem).states(todo, done, abandoned, wontFix);
const heartbeat = H.kind('service-heartbeat').data(z.object({ service: z.string() })).states(due, healthy, unhealthy);

const experience = H.memory('engineering-experience', 'experience');
const taste = H.memory('owner-taste', 'taste');
const experienceLibrary = H.library('experience', experience, jsonl.memory('.harness/experience.jsonl'));
const tasteLibrary = H.library('taste', taste, jsonl.memory('.harness/taste.jsonl'));

const sonnet = claude.model('claude-sonnet-4-5');
const opus = claude.model('claude-opus-4-1');

const maxA = claude.subscription('max-a', { token: H.env('CLAUDE_MAX_A_TOKEN') });
const maxB = claude.subscription('max-b', { token: H.env('CLAUDE_MAX_B_TOKEN') });
const maxC = claude.subscription('max-c', { token: H.env('CLAUDE_MAX_C_TOKEN') });
const api = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });

const soonestExpiringFirst = H.policy.account('soonest-expiring-first', choice => {
  const open = choice.accounts.filter(view => view.eligible && view.account.plan === 'subscription' && view.usedShare < view.share);
  const ordered = [...open].sort(
    (a, b) => (a.windowEndsAt?.getTime() ?? Number.POSITIVE_INFINITY) - (b.windowEndsAt?.getTime() ?? Number.POSITIVE_INFINITY)
  );
  const first = ordered[0];
  if (first !== undefined) return first.account;
  const metered = choice.accounts.find(view => view.eligible && view.account.plan === 'metered');
  return metered === undefined ? null : metered.account;
});

const claudePool = H.pool(
  'claude',
  [
    { account: maxA, share: 0.5 },
    { account: maxB, share: 0.5 },
    { account: maxC, share: 0.3 },
    { account: api, share: 1 },
  ],
  soonestExpiringFirst
);

const builderModel = H.policy.model('builder-model', [sonnet, opus], choice => {
  const cheaper = choice.metrics.successRate({ kind: choice.kind, seat: choice.seat, model: sonnet, days: 14 });
  if (cheaper.samples < 20 || cheaper.value === null) return sonnet;
  return cheaper.value < 0.85 ? opus : sonnet;
});

const worktree = git.worktree('worktree', { repo: '.', slots: 3 });
const local = shell.local('local', { slots: 4 });

const projectChecks = H.command('project-checks').argv(() => ['npm', 'run', 'check']).on(worktree).recovery('rerun');
const serviceHealth = H.command('service-health')
  .input(z.object({ service: z.string() }))
  .argv(input => ['./scripts/health.sh', input.service])
  .on(local)
  .recovery('rerun');
const productionProbe = H.command('production-probe').argv(() => ['./scripts/probe.sh', 'production']).on(local).recovery('rerun');

const builderRole = H.role('builder')
  .input(z.object({ title: z.string(), description: z.string(), feedback: z.array(z.string()) }))
  .output(z.object({ summary: z.string(), question: z.string().optional() }))
  .prompt(input => `Implement: ${input.title}\n\n${input.description}\n\nOpen deficits:\n${input.feedback.join('\n')}`)
  .intents(['read', 'edit', 'execute']);

const auditorRole = H.role('auditor')
  .input(z.object({ title: z.string(), description: z.string(), summary: z.string() }))
  .output(z.object({ deficits: z.array(z.string()) }))
  .prompt(input => `Audit the change for: ${input.title}\n\n${input.description}\n\nBuilder summary:\n${input.summary}`)
  .intents(['read', 'execute']);

const plannerRole = H.role('planner')
  .input(z.object({ title: z.string(), description: z.string() }))
  .output(z.object({ features: z.array(z.object({ title: z.string(), description: z.string() })) }))
  .prompt(input => `Decompose the epic into features: ${input.title}\n\n${input.description}`)
  .intents(['read']);

const builder = H.seat('builder', builderRole)
  .model(builderModel)
  .on(worktree)
  .recalls(experienceLibrary, tasteLibrary)
  .guards(claude.fileLeases(), claude.stopCheck(projectChecks));

const auditor = H.seat('auditor', auditorRole)
  .model(opus)
  .on(worktree)
  .recalls(experienceLibrary)
  .records(experienceLibrary);

const planner = H.seat('planner', plannerRole).model(opus).recalls(tasteLibrary);

const ownerDecision = H.halt('owner-decision', z.object({ answer: z.string() })).about(z.object({ question: z.string() }));

const buildAndAudit = H.flow('build-and-audit')
  .for(bug, feature)
  .params(z.object({ rounds: z.number().int() }))
  .does(async ctx => {
    let feedback: string[] = [];
    for (let round = 0; round < ctx.params.rounds; round += 1) {
      const built = await ctx.run(builder, {
        title: ctx.unit.data.title,
        description: ctx.unit.data.description,
        feedback,
      });
      if (!built.ok) return ctx.fail(built.error);
      const question = built.value.question;
      if (question !== undefined) {
        const decided = await ctx.halt(ownerDecision, question, { question });
        feedback = [...feedback, `Owner decided: ${decided.answer}`];
        continue;
      }
      const audit = await ctx.run(auditor, {
        title: ctx.unit.data.title,
        description: ctx.unit.data.description,
        summary: built.value.summary,
      });
      if (!audit.ok) return ctx.fail(audit.error);
      if (audit.value.deficits.length === 0) return 'done';
      feedback = audit.value.deficits;
    }
    return ctx.fail(`deficits remain after ${ctx.params.rounds} rounds`);
  });

const readIssue = (issue: linear.Issue) => ({
  title: issue.title,
  description: issue.description,
  parentId: issue.parentId,
});

const bugTracker = linear.tracker(bug, {
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'PRODUCT',
  label: 'bug',
  read: readIssue,
  statuses: { todo: 'Todo', done: 'Done', abandoned: 'Canceled', 'wont-fix': "Won't Fix" },
});

const featureTracker = linear.tracker(feature, {
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'PRODUCT',
  label: 'feature',
  read: readIssue,
  statuses: { todo: 'Todo', done: 'Done', abandoned: 'Canceled', 'wont-fix': "Won't Fix" },
});

const epicTracker = linear.tracker(epic, {
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'PRODUCT',
  label: 'epic',
  read: readIssue,
  statuses: { todo: 'Todo', done: 'Done', abandoned: 'Canceled' },
});

const bugFolder = folder.files(bug, {
  dir: 'bugs',
  read: file => {
    const title = file.frontmatter['title'];
    return { title: typeof title === 'string' ? title : file.path, description: file.body };
  },
});

const services = ['api', 'web', 'worker'];

const heartbeatClock = H.clock('heartbeat-clock', heartbeat, { every: { minutes: 5 } }, () =>
  services.map(service => ({ create: { service }, key: `heartbeat-${service}` }))
);

const checkService = H.flow('check-service')
  .for(heartbeat)
  .does(async ctx => {
    const result = await ctx.run(serviceHealth, { service: ctx.unit.data.service });
    return result.ok ? 'healthy' : 'unhealthy';
  });

const heartbeats = H.lane('heartbeats', heartbeat)
  .handler(checkService)
  .retries(0, { exhausted: 'unhealthy' })
  .suppliers(heartbeatClock);

const bugs = H.lane('bugs', bug)
  .handler(buildAndAudit, { rounds: 3 })
  .retries(2, { backoff: { first: { minutes: 10 }, factor: 2 }, exhausted: 'abandoned' })
  .suppliers(bugTracker, bugFolder, H.operator)
  .store(bugTracker)
  .wip(2);

const features = H.lane('features', feature)
  .handler(buildAndAudit, { rounds: 5 })
  .retries(2, { backoff: { first: { minutes: 10 }, factor: 2 }, exhausted: 'abandoned' })
  .suppliers(featureTracker, H.operator)
  .store(featureTracker);

const decomposeEpic = H.flow('decompose-epic')
  .for(epic)
  .does(async ctx => {
    const plan = await ctx.run(planner, { title: ctx.unit.data.title, description: ctx.unit.data.description });
    if (!plan.ok) return ctx.fail(plan.error);
    const children = await ctx.spawn(
      features,
      plan.value.features.map(item => ({ title: item.title, description: item.description, parentId: ctx.unit.key }))
    );
    const finished = await ctx.sleep({ children });
    return finished.some(child => child.state === 'abandoned') ? ctx.fail('a feature was abandoned') : 'done';
  });

const epics = H.lane('epics', epic)
  .handler(decomposeEpic)
  .retries(1, { exhausted: 'abandoned' })
  .suppliers(epicTracker)
  .store(epicTracker)
  .wip(1);

const heartbeatFailureFilesBug = H.trigger('heartbeat-failure-files-bug', H.on.enters(heartbeat, 'unhealthy'), (event, act) =>
  act.create(
    bugs,
    {
      title: `Service ${event.unit.data.service} failed its heartbeat`,
      description: `The heartbeat at ${event.at.toISOString()} reported ${event.unit.data.service} unhealthy.`,
    },
    `heartbeat-bug-${event.unit.data.service}`
  )
);

const starvationMs = 4 * 60 * 60 * 1000;

const priority = (unit: PendingView): number => {
  if (unit.kind === heartbeat.name) return 0;
  if (unit.kind === bug.name) return 1;
  if (unit.kind === feature.name) return unit.waitedMs > starvationMs ? 0.5 : 2;
  return 3;
};

const scheduler = H.policy.scheduler('heartbeats-bugs-features-epics', view => ({
  start: [...view.pending].sort((a, b) => priority(a) - priority(b) || b.waitedMs - a.waitedMs),
}));

const supervisor = claude.supervisor('owner-supervisor', {
  grants: [
    H.ops.readWork,
    H.ops.writeWork,
    H.ops.resolveHalts,
    H.ops.writeMemory,
    H.ops.readTelemetry,
    H.ops.readAccounts,
    H.ops.setShares,
    H.operation('production-health-probe', productionProbe),
  ],
});

export const codingTeam = H.harness('coding-team')
  .ledger(sqlite.ledger('.harness/ledger.sqlite'))
  .lanes(heartbeats, bugs, features, epics)
  .pools(claudePool)
  .triggers(heartbeatFailureFilesBug)
  .scheduler(scheduler)
  .clients(supervisor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
