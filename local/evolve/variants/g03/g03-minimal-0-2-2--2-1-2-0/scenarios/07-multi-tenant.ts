import { z } from 'zod';
import { H } from 'harness-dsl';
import type { PendingView } from 'harness-dsl';
import * as claude from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as linear from 'harness-dsl/linear';
import * as folder from 'harness-dsl/folder';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as git from 'harness-dsl/git';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const sharedQuota = sqlite.quota('/home/owner/.harness/claude-quota.sqlite');

const max1 = claude.subscription('claude-max-1', { token: H.env('CLAUDE_MAX_1_TOKEN'), quota: sharedQuota });
const max2 = claude.subscription('claude-max-2', { token: H.env('CLAUDE_MAX_2_TOKEN'), quota: sharedQuota });
const max3 = claude.subscription('claude-max-3', { token: H.env('CLAUDE_MAX_3_TOKEN'), quota: sharedQuota });

const soonestExpiring = H.policy.account('soonest-expiring-then-metered', choice => {
  const open = choice.accounts.filter(view => view.eligible && view.account.plan === 'subscription' && view.usedShare < view.share);
  const sorted = [...open].sort(
    (a, b) => (a.windowEndsAt?.getTime() ?? Infinity) - (b.windowEndsAt?.getTime() ?? Infinity)
  );
  const first = sorted[0];
  if (first) return first.account;
  const metered = choice.accounts.find(view => view.eligible && view.account.plan === 'metered');
  return metered ? metered.account : null;
});

const ownerTaste = H.journal(
  'owner-taste',
  H.memory('taste', 'taste'),
  jsonl.memory('/home/owner/.harness/taste.jsonl'),
  H.policy.recall('broadest-taste', view => view.ranked.slice(0, 8))
);
const mostSpecific = H.policy.recall('most-specific-experience', view => view.ranked.slice(0, 8));
const experience = H.memory('experience', 'experience');

const sonnet = claude.model('claude-sonnet-4-5');
const opus = claude.model('claude-opus-4-1');

const queued = H.state('queued', 'pending');
const done = H.state('done', 'terminal', 'success');
const stuck = H.state('stuck', 'terminal', 'failure');
const decomposed = H.state('decomposed', 'waiting');
const due = H.state('due', 'pending');
const healthy = H.state('healthy', 'terminal', 'success');
const unhealthy = H.state('unhealthy', 'terminal', 'failure');

const workItem = z.object({ title: z.string(), description: z.string() });
const bug = H.kind('Bug').data(workItem).states(queued, done, stuck);
const feature = H.kind('Feature').data(workItem.extend({ epic: z.string().optional() })).states(queued, done, stuck);
const epic = H.kind('Epic').data(workItem).states(queued, decomposed, done, stuck);
const heartbeat = H.kind('ServiceHeartbeat').data(z.object({ service: z.string(), url: z.string() })).states(due, healthy, unhealthy);

const productExperience = H.journal(
  'product-experience',
  experience,
  jsonl.memory('/work/product/.harness/experience.jsonl'),
  mostSpecific
);

const worktrees = git.worktree('product-worktrees', { repo: '/work/product', slots: 4 });
const productLocal = shell.local('product-local', { slots: 4 });

const projectChecks = H.command('project-checks').argv(() => ['npm', 'run', 'check']).on(worktrees);
const probe = H.command('probe')
  .input(z.object({ url: z.string() }))
  .argv(input => ['curl', '-fsS', input.url])
  .on(productLocal);

const cheapUntilItSlips = H.policy.model('cheap-until-it-slips', [sonnet, opus], choice => {
  const cheap = choice.metrics.successRate({ kind: choice.kind, model: sonnet, days: 14 });
  return cheap.samples >= 20 && cheap.value !== null && cheap.value < 0.85 ? opus : sonnet;
});

const builderRole = H.role('builder')
  .input(z.object({ title: z.string(), description: z.string(), deficits: z.array(z.string()), ownerAnswer: z.string() }))
  .output(z.object({ summary: z.string(), question: z.string().optional() }))
  .prompt(input => `Build: ${input.title}\n${input.description}\nOpen deficits:\n${input.deficits.join('\n')}\nOwner said: ${input.ownerAnswer}`)
  .intents(['read', 'edit', 'execute']);
const auditorRole = H.role('auditor')
  .input(z.object({ title: z.string(), summary: z.string() }))
  .output(z.object({ deficits: z.array(z.string()) }))
  .prompt(input => `Audit the change for ${input.title}: ${input.summary}`)
  .intents(['read', 'execute']);
const plannerRole = H.role('planner')
  .input(workItem)
  .output(z.object({ features: z.array(workItem) }))
  .prompt(input => `Decompose the epic ${input.title} into features:\n${input.description}`);

const builder = H.seat('builder', builderRole)
  .model(cheapUntilItSlips)
  .on(worktrees)
  .recalls(productExperience, ownerTaste)
  .guards(claude.fileLeases(), claude.stopCheck(projectChecks));
const auditor = H.seat('auditor', auditorRole).model(sonnet).on(worktrees).recalls(productExperience).records(productExperience);
const planner = H.seat('planner', plannerRole).model(opus).recalls(ownerTaste);

const ownerDecision = H.halt('owner-decision', z.object({ answer: z.string() })).about(z.object({ question: z.string() }));

const buildAndAudit = H.flow('build-and-audit')
  .for(bug, feature)
  .params(z.object({ rounds: z.number() }))
  .does(async ctx => {
    let deficits: string[] = [];
    let ownerAnswer = '';
    for (let round = 0; round < ctx.params.rounds; round += 1) {
      const built = await ctx.run(builder, {
        title: ctx.unit.data.title,
        description: ctx.unit.data.description,
        deficits,
        ownerAnswer,
      });
      if (!built.ok) return ctx.fail(built);
      const question = built.value.question;
      if (question !== undefined) {
        const answer = await ctx.halt(ownerDecision, question, { question });
        ownerAnswer = answer.answer;
        continue;
      }
      const audited = await ctx.run(auditor, { title: ctx.unit.data.title, summary: built.value.summary });
      if (!audited.ok) return ctx.fail(audited);
      if (audited.value.deficits.length === 0) return 'done';
      deficits = audited.value.deficits;
    }
    return 'stuck';
  });

const bugTracker = linear.tracker(bug, {
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'PROD',
  label: 'bug',
  read: issue => ({ title: issue.title, description: issue.description }),
  statuses: { queued: 'Todo', done: 'Done', stuck: 'Blocked' },
});
const bugFolder = folder.files(bug, {
  dir: '/work/product/bugs',
  read: file => ({ title: String(file.frontmatter['title'] ?? file.path), description: file.body }),
});
const featureTracker = linear.tracker(feature, {
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'PROD',
  label: 'feature',
  read: issue => ({ title: issue.title, description: issue.description, epic: issue.parentId }),
  statuses: { queued: 'Todo', done: 'Done', stuck: 'Blocked' },
});
const epicTracker = linear.tracker(epic, {
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'PROD',
  label: 'epic',
  read: issue => ({ title: issue.title, description: issue.description }),
  statuses: { queued: 'Todo', decomposed: 'In Progress', done: 'Done', stuck: 'Blocked' },
});

const bugs = H.lane('bugs', bug)
  .handler(buildAndAudit, { rounds: 3 })
  .retries(2, 'stuck', { first: { minutes: 10 }, factor: 2 })
  .suppliers(bugTracker, bugFolder, H.operator)
  .store(bugTracker)
  .wip(2);

const features = H.lane('features', feature)
  .handler(buildAndAudit, { rounds: 5 })
  .retries(2, 'stuck', { first: { minutes: 10 }, factor: 2 })
  .suppliers(featureTracker, H.operator)
  .store(featureTracker);

const decompose = H.flow('decompose').for(epic).does(async ctx => {
  const plan = await ctx.run(planner, { title: ctx.unit.data.title, description: ctx.unit.data.description });
  if (!plan.ok) return ctx.fail(plan);
  const children = await ctx.spawn(
    features,
    plan.value.features.map(item => ({ title: item.title, description: item.description, epic: ctx.unit.key }))
  );
  const finished = await ctx.suspend('decomposed', { children });
  return finished.every(child => child.state === 'done') ? 'done' : 'stuck';
});

const epics = H.lane('epics', epic)
  .handler(decompose)
  .retries(1, 'stuck')
  .suppliers(epicTracker)
  .store(epicTracker)
  .wip(1);

const beat = H.flow('beat').for(heartbeat).does(async ctx => {
  const probed = await ctx.run(probe, { url: ctx.unit.data.url });
  return probed.ok ? 'healthy' : 'unhealthy';
});

const heartbeats = H.lane('heartbeats', heartbeat)
  .handler(beat)
  .retries(0, 'unhealthy')
  .suppliers(
    H.clock('heartbeat-clock', heartbeat, { every: { minutes: 5 } }, tick => [
      tick.create({ service: 'api', url: 'https://api.example.com/health' }),
    ])
  );

const heartbeatBug = H.trigger('failed-heartbeat-files-bug', H.on.enters(heartbeat, 'unhealthy'), (event, act) =>
  act.create(bugs, {
    title: `Heartbeat failed: ${event.unit.data.service}`,
    description: `The probe of ${event.unit.data.url} failed at ${event.at.toISOString()}.`,
  })
);

const productOrder = H.policy.scheduler('heartbeats-bugs-features-epics', view => {
  const rank = (unit: PendingView): number => {
    if (unit.is(heartbeat)) return 0;
    if (unit.is(bug)) return 1;
    if (unit.is(feature)) return unit.waitedMs > 4 * 3_600_000 ? 1 : 2;
    return 3;
  };
  return { start: [...view.pending].sort((a, b) => rank(a) - rank(b)) };
});

const productPool = H.pool(
  'product-claude',
  [
    { account: max1, share: 0.6 },
    { account: max2, share: 0.6 },
    { account: max3, share: 0.6 },
    { account: anthropic.account('product-api', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 },
  ],
  soonestExpiring
);

export const product = H.harness('product')
  .ledger(sqlite.ledger('/work/product/.harness/ledger.sqlite'))
  .lanes(heartbeats, bugs, features, epics)
  .pools(productPool)
  .triggers(heartbeatBug)
  .scheduler(productOrder)
  .clients(
    claude.supervisor({
      grants: [
        H.ops.readWork,
        H.ops.writeWork,
        H.ops.resolve(ownerDecision),
        H.ops.writeMemory,
        H.ops.readTelemetry,
        H.ops.readAccounts,
        H.ops.setShares,
        H.operation('production-health', probe),
      ],
    })
  )
  .observers(markdown.board('/work/product/BOARD.md'), markdown.telemetry('/work/product/TELEMETRY.md'));

const stale = H.state('stale', 'pending');
const published = H.state('published', 'terminal', 'success');
const broken = H.state('broken', 'terminal', 'failure');
const docPage = H.kind('DocPage')
  .data(z.object({ path: z.string(), title: z.string(), body: z.string() }))
  .states(stale, published, broken);

const docsExperience = H.journal('docs-experience', experience, jsonl.memory('/work/docs/.harness/experience.jsonl'), mostSpecific);
const docsWorktrees = git.worktree('docs-worktrees', { repo: '/work/docs', slots: 2 });
const docsLocal = shell.local('docs-local', { slots: 2 });

const writer = H.seat(
  'writer',
  H.role('writer')
    .input(z.object({ path: z.string(), title: z.string(), body: z.string() }))
    .output(z.object({ changed: z.boolean() }))
    .prompt(input => `Bring ${input.path} (${input.title}) up to date:\n${input.body}`)
    .intents(['read', 'edit'])
)
  .model(sonnet)
  .on(docsWorktrees)
  .recalls(ownerTaste, docsExperience);

const linkCheck = H.command('link-check')
  .input(z.object({ path: z.string() }))
  .argv(input => ['npx', 'linkinator', input.path])
  .on(docsLocal);

const writePage = H.flow('write-page').for(docPage).does(async ctx => {
  const written = await ctx.run(writer, { path: ctx.unit.data.path, title: ctx.unit.data.title, body: ctx.unit.data.body });
  if (!written.ok) return ctx.fail(written);
  const checked = await ctx.run(linkCheck, { path: ctx.unit.data.path });
  if (!checked.ok) return ctx.fail(checked);
  return 'published';
});

const docPages = folder.files(docPage, {
  dir: '/work/docs/pages',
  read: file => ({ path: file.path, title: String(file.frontmatter['title'] ?? file.path), body: file.body }),
  key: file => file.path,
});

const pages = H.lane('pages', docPage)
  .handler(writePage)
  .retries(2, 'broken', { first: { minutes: 5 } })
  .suppliers(docPages)
  .store(docPages)
  .wip(2);

const docsPool = H.pool(
  'docs-claude',
  [
    { account: max1, share: 0.3 },
    { account: max2, share: 0.3 },
    { account: max3, share: 0.3 },
  ],
  soonestExpiring
);

export const docs = H.harness('docs')
  .ledger(sqlite.ledger('/work/docs/.harness/ledger.sqlite'))
  .lanes(pages)
  .pools(docsPool)
  .scheduler(H.policy.scheduler('oldest-first', view => ({ start: [...view.pending].sort((a, b) => b.waitedMs - a.waitedMs) })))
  .clients(
    claude.supervisor({
      grants: [H.ops.readWork, H.ops.writeWork, H.ops.writeMemory, H.ops.readTelemetry, H.ops.readAccounts, H.ops.setShares],
    })
  )
  .observers(markdown.board('/work/docs/BOARD.md'));
