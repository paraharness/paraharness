import { z } from 'zod';
import { H } from 'harness-dsl';
import * as claudeCode from 'harness-dsl/claude-code';
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
const stuck = H.state('stuck', 'terminal', 'failure');

const workItem = { title: z.string(), description: z.string() };

const bug = H.kind('bug')
  .data(z.object({ ...workItem, reporter: z.string().optional() }))
  .states(todo, done, stuck, H.state('duplicate', 'terminal', 'neutral'));

const feature = H.kind('feature')
  .data(z.object({ ...workItem, epic: z.string().optional() }))
  .states(todo, done, stuck);

const epic = H.kind('epic')
  .data(z.object(workItem))
  .states(
    H.state('proposed', 'pending'),
    H.state('decomposed', 'waiting'),
    done,
    H.state('abandoned', 'terminal', 'failure')
  );

const heartbeat = H.kind('service-heartbeat')
  .data(z.object({ service: z.string() }))
  .states(H.state('due', 'pending'), H.state('healthy', 'terminal', 'success'), H.state('down', 'terminal', 'failure'));

const experienceKind = H.memory('experience', 'experience');
const tasteKind = H.memory('taste', 'taste');
const experience = H.journal('team-experience', experienceKind, jsonl.memory('.harness/experience.jsonl'));
const taste = H.journal('owner-taste', tasteKind, jsonl.memory('.harness/taste.jsonl'));

const sonnet = anthropic.model('claude-sonnet-4-5');
const opus = anthropic.model('claude-opus-4-1');

const soonestExpiringFirst = H.policy.account('soonest-expiring-first', choice => {
  const open = choice.accounts
    .filter(view => view.eligible && view.account.plan === 'subscription' && view.usedShare < view.share)
    .sort((a, b) => (a.windowEndsAt?.getTime() ?? Number.MAX_SAFE_INTEGER) - (b.windowEndsAt?.getTime() ?? Number.MAX_SAFE_INTEGER));
  const first = open.find(view => view.eligible);
  if (first) return first.account;
  const metered = choice.accounts.find(view => view.eligible && view.account.plan === 'metered');
  return metered ? metered.account : null;
});

const claude = H.pool(
  'claude',
  [
    { account: claudeCode.subscription('max-1', { token: H.env('CLAUDE_MAX_1_TOKEN') }), share: 0.8 },
    { account: claudeCode.subscription('max-2', { token: H.env('CLAUDE_MAX_2_TOKEN') }), share: 0.8 },
    { account: claudeCode.subscription('max-3', { token: H.env('CLAUDE_MAX_3_TOKEN') }), share: 0.5 },
    { account: anthropic.account('api-fallback', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 },
  ],
  soonestExpiringFirst
).serves(sonnet, opus);

const builderModel = H.policy.model('cheaper-until-it-slips', [sonnet, opus], choice => {
  const cheaper = choice.metrics.successRate({ kind: choice.kind, seat: choice.seat, model: sonnet, days: 14 });
  if (cheaper.samples < 20) return sonnet;
  return (cheaper.value ?? 0) < 0.85 ? opus : sonnet;
});

const worktree = git.worktree('attempt-worktree', { repo: '.', slots: 3 });
const local = shell.local('local', { slots: 4 });

const projectChecks = H.command('project-checks').argv(() => ['npm', 'run', 'check']).on(worktree).recovery('rerun');

const builderRole = H.role('builder')
  .input(z.object({ title: z.string(), description: z.string(), deficits: z.array(z.string()) }))
  .output(z.object({ summary: z.string(), question: z.string().optional() }))
  .prompt(input =>
    `Implement: ${input.title}\n\n${input.description}\n\nOpen deficits:\n${input.deficits.join('\n')}\n\nIf an owner decision is needed, set question.`
  )
  .intents(['read', 'edit', 'execute']);

const auditorRole = H.role('auditor')
  .input(z.object({ title: z.string(), summary: z.string() }))
  .output(z.object({ deficits: z.array(z.string()) }))
  .prompt(input => `Audit the change for "${input.title}". Builder summary: ${input.summary}. List every deficit.`)
  .intents(['read', 'execute']);

const plannerRole = H.role('planner')
  .input(z.object({ title: z.string(), description: z.string() }))
  .output(z.object({ features: z.array(z.object({ title: z.string(), description: z.string() })) }))
  .prompt(input => `Decompose the epic "${input.title}" into features.\n\n${input.description}`)
  .intents(['read']);

const builder = H.seat('builder', builderRole)
  .model(builderModel)
  .on(worktree)
  .guards(claudeCode.fileLeases(), claudeCode.stopCheck(projectChecks))
  .recalls(experience, taste);

const auditor = H.seat('auditor', auditorRole).model(opus).on(worktree).recalls(experience).records(experience);

const planner = H.seat('planner', plannerRole).model(opus).recalls(taste);

const ownerDecision = H.halt(
  'owner-decision',
  z.object({ choice: z.enum(['continue', 'stop']), note: z.string().optional() })
);

const buildAndAudit = H.flow('build-and-audit')
  .for(bug, feature)
  .params(z.object({ rounds: z.number() }))
  .does(async ctx => {
    let deficits: string[] = [];
    for (let round = 1; round <= ctx.params.rounds; round += 1) {
      const built = await ctx.run(builder, {
        title: ctx.unit.data.title,
        description: ctx.unit.data.description,
        deficits,
      });
      if (!built.ok) return ctx.fail(built.error);
      if (built.value.question !== undefined) {
        const decision = await ctx.halt(ownerDecision, built.value.question);
        if (decision.choice === 'stop') return 'stuck';
      }
      const audited = await ctx.run(auditor, { title: ctx.unit.data.title, summary: built.value.summary });
      if (!audited.ok) return ctx.fail(audited.error);
      if (audited.value.deficits.length === 0) return 'done';
      deficits = audited.value.deficits;
    }
    return ctx.fail('deficits remain after the last round');
  });

const probe = H.command('service-probe')
  .input(z.object({ service: z.string() }))
  .argv(input => ['curl', '-fsS', `https://${input.service}.internal/health`])
  .on(local)
  .recovery('rerun');

const checkService = H.flow('check-service')
  .for(heartbeat)
  .does(async ctx => {
    const probed = await ctx.run(probe, { service: ctx.unit.data.service });
    return probed.ok ? 'healthy' : 'down';
  });

const linearKey = H.env('LINEAR_API_KEY');

const bugTracker = linear.tracker(bug, {
  apiKey: linearKey,
  team: 'PRODUCT',
  label: 'bug',
  read: issue => ({ title: issue.title, description: issue.description }),
  statuses: { todo: 'Todo', done: 'Done', stuck: 'Blocked', duplicate: 'Duplicate' },
});

const bugFolder = folder.files(bug, {
  dir: 'bugs',
  frontmatter: z.object({ title: z.string(), reporter: z.string().optional() }),
  read: file => ({ title: file.frontmatter.title, description: file.body, reporter: file.frontmatter.reporter }),
});

const featureTracker = linear.tracker(feature, {
  apiKey: linearKey,
  team: 'PRODUCT',
  label: 'feature',
  read: issue => ({ title: issue.title, description: issue.description, epic: issue.parentId }),
  statuses: { todo: 'Todo', done: 'Done', stuck: 'Blocked' },
});

const epicTracker = linear.tracker(epic, {
  apiKey: linearKey,
  team: 'PRODUCT',
  label: 'epic',
  read: issue => ({ title: issue.title, description: issue.description }),
  statuses: { proposed: 'Backlog', decomposed: 'In Progress', done: 'Done', abandoned: 'Canceled' },
});

const bugs = H.lane('bugs', bug)
  .handler(buildAndAudit, { rounds: 3 })
  .retries(2, { backoff: { first: { minutes: 10 }, factor: 2 }, exhausted: 'stuck' })
  .suppliers(bugTracker, bugFolder, H.operator)
  .store(bugTracker)
  .wip(2);

const features = H.lane('features', feature)
  .handler(buildAndAudit, { rounds: 5 })
  .retries(2, { backoff: { first: { minutes: 10 }, factor: 2 }, exhausted: 'stuck' })
  .suppliers(featureTracker, H.operator)
  .store(featureTracker);

const decompose = H.flow('decompose-epic')
  .for(epic)
  .does(async ctx => {
    const planned = await ctx.run(planner, { title: ctx.unit.data.title, description: ctx.unit.data.description });
    if (!planned.ok) return ctx.fail(planned.error);
    const children = await ctx.spawn(
      features,
      planned.value.features.map(item => ({ ...item, epic: ctx.unit.key }))
    );
    const finished = await ctx.suspend('decomposed', { children });
    return finished.every(child => child.state === 'done') ? 'done' : 'abandoned';
  });

const epics = H.lane('epics', epic)
  .handler(decompose)
  .retries(1, { exhausted: 'abandoned' })
  .suppliers(epicTracker)
  .store(epicTracker)
  .wip(1);

const heartbeats = H.lane('heartbeats', heartbeat)
  .handler(checkService)
  .retries(0, { exhausted: 'down' })
  .suppliers(
    H.schedule('every-five-minutes', heartbeat, { every: { minutes: 5 } }, (tick, supply) =>
      ['api', 'web', 'worker'].map(service => supply.create({ service }))
    )
  );

const heartbeatFilesBug = H.trigger('down-heartbeat-files-bug', H.on.enters(heartbeat, 'down'), (event, act) =>
  act.create(bugs, {
    title: `Service ${event.unit.data.service} failed its heartbeat`,
    description: `The heartbeat for ${event.unit.data.service} failed at ${event.at.toISOString()}.`,
    reporter: 'heartbeat',
  })
);

const starvationMs = 4 * 60 * 60 * 1000;

const priority = H.policy.scheduler('heartbeats-bugs-features-epics', view => ({
  start: view.sorted(unit => {
    if (unit.is(heartbeat)) return 0;
    if (unit.is(bug)) return 1;
    if (unit.is(feature)) return unit.waitedMs > starvationMs ? 0.5 : 2;
    return 3;
  }),
}));

const productionHealth = H.operation(
  'production-health',
  H.command('production-health-probe').argv(() => ['curl', '-fsS', 'https://api.example.com/health']).on(local).recovery('rerun')
);

export const codingTeam = H.harness('coding-team')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(heartbeats, bugs, features, epics)
  .pools(claude)
  .triggers(heartbeatFilesBug)
  .scheduler(priority)
  .clients(
    claudeCode.supervisor({
      grants: [
        H.ops.readWork,
        H.ops.writeWork,
        H.ops.resolveHalts,
        H.ops.readMemory,
        H.ops.writeMemory,
        H.ops.readTelemetry,
        H.ops.readAccounts,
        H.ops.setShares,
        productionHealth,
      ],
    })
  )
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
