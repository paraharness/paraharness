import { z } from 'zod';
import { H } from 'harness-dsl';
import type { PendingView, PoolMember } from 'harness-dsl';
import * as claude from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as linear from 'harness-dsl/linear';
import * as folder from 'harness-dsl/folder';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as git from 'harness-dsl/git';
import * as shell from 'harness-dsl/shell';
import * as http from 'harness-dsl/http';
import * as markdown from 'harness-dsl/markdown';

const sharedQuota = sqlite.quota('/srv/owner/.harness/claude-quota.sqlite');

const sharedAccounts = {
  first: claude.subscription('claude-max-1', { token: H.env('CLAUDE_MAX_1_TOKEN'), quota: sharedQuota }),
  second: claude.subscription('claude-max-2', { token: H.env('CLAUDE_MAX_2_TOKEN'), quota: sharedQuota }),
  third: claude.subscription('claude-max-3', { token: H.env('CLAUDE_MAX_3_TOKEN'), quota: sharedQuota }),
};

const sharedModels = {
  sonnet: claude.model('claude-sonnet-4-5'),
  opus: claude.model('claude-opus-4-1'),
};

const ownerTaste = H.journal('owner-taste', H.memory('taste', 'taste'), jsonl.memory('/srv/owner/.harness/taste.jsonl'));

const soonestExpiring = H.policy.account('soonest-expiring-first', (choice) => {
  const open = choice.accounts.filter((view) => view.eligible && view.usedShare < view.share);
  const ordered = [...open].sort(
    (a, b) => (a.windowEndsAt ? a.windowEndsAt.getTime() : Infinity) - (b.windowEndsAt ? b.windowEndsAt.getTime() : Infinity)
  );
  const first = ordered[0];
  return first === undefined ? null : first.account;
});

const subscriptionPool = (name: string, share: number, fallback: readonly PoolMember[]) =>
  H.pool(
    name,
    [
      { account: sharedAccounts.first, share },
      { account: sharedAccounts.second, share },
      { account: sharedAccounts.third, share },
      ...fallback,
    ],
    soonestExpiring
  );

const open = H.state('open', 'pending');
const done = H.state('done', 'terminal', 'success');
const wontFix = H.state('wont-fix', 'terminal', 'neutral');
const abandoned = H.state('abandoned', 'terminal', 'failure');

const workSchema = z.object({ title: z.string(), description: z.string() });
const bug = H.kind('bug').data(workSchema).states(open, done, wontFix, abandoned);
const feature = H.kind('feature').data(workSchema).states(open, done, wontFix, abandoned);
const heartbeat = H.kind('service-heartbeat')
  .data(z.object({ service: z.string() }))
  .states(H.state('due', 'pending'), H.state('healthy', 'terminal', 'success'), H.state('unhealthy', 'terminal', 'failure'));

const codingExperience = H.journal(
  'coding-experience',
  H.memory('experience', 'experience'),
  jsonl.memory('/srv/repos/app/.harness/experience.jsonl')
);

const appWorktrees = git.worktree('app-worktrees', { repo: '/srv/repos/app', slots: 3 });
const appLocal = shell.local('app-local', { slots: 2 });

const projectChecks = H.command('project-checks').argv(() => ['npm', 'run', 'check']).on(appLocal);

const builderRole = H.role('builder')
  .input(z.object({ title: z.string(), description: z.string(), deficits: z.array(z.string()), ownerAnswer: z.string() }))
  .output(z.object({ summary: z.string(), question: z.string().optional() }))
  .prompt((input) => `Build: ${input.title}\n${input.description}\nOpen deficits: ${input.deficits.join('; ')}\nOwner said: ${input.ownerAnswer}`)
  .intents(['read', 'edit', 'execute']);

const auditorRole = H.role('auditor')
  .input(z.object({ title: z.string(), summary: z.string() }))
  .output(z.object({ deficits: z.array(z.string()) }))
  .prompt((input) => `Audit the change for "${input.title}": ${input.summary}. List every deficit.`)
  .intents(['read', 'execute']);

const cheapUntilItSlips = H.policy.model('cheap-until-it-slips', [sharedModels.sonnet, sharedModels.opus], (choice) => {
  const cheap = choice.metrics.successRate({ kind: choice.kind, seat: choice.seat, model: sharedModels.sonnet, days: 14 });
  return cheap.samples >= 20 && cheap.value !== null && cheap.value < 0.85 ? sharedModels.opus : sharedModels.sonnet;
});

const builder = H.seat('builder', builderRole)
  .model(cheapUntilItSlips)
  .on(appWorktrees)
  .recalls(codingExperience, ownerTaste)
  .guards(claude.fileLeases(), claude.stopCheck(projectChecks));

const auditor = H.seat('auditor', auditorRole)
  .model(sharedModels.opus)
  .on(appWorktrees)
  .recalls(codingExperience)
  .records(codingExperience);

const ownerDecision = H.halt('owner-decision', z.object({ answer: z.string() }));

const buildAndAudit = H.flow('build-and-audit')
  .for(bug, feature)
  .params(z.object({ rounds: z.number() }))
  .does(async (ctx) => {
    let deficits: string[] = [];
    let ownerAnswer = '';
    for (let round = 0; round < ctx.params.rounds; round += 1) {
      const built = await ctx.run(builder, {
        title: ctx.unit.data.title,
        description: ctx.unit.data.description,
        deficits,
        ownerAnswer,
      });
      if (!built.ok) return ctx.fail(built.error);
      if (built.value.question !== undefined) {
        const decision = await ctx.halt(ownerDecision, built.value.question);
        ownerAnswer = decision.answer;
        continue;
      }
      const audit = await ctx.run(auditor, { title: ctx.unit.data.title, summary: built.value.summary });
      if (!audit.ok) return ctx.fail(audit.error);
      if (audit.value.deficits.length === 0) return 'done';
      deficits = audit.value.deficits;
    }
    return ctx.fail('deficits remain after the last round');
  });

const healthProbe = H.command('service-health-probe')
  .input(z.object({ service: z.string() }))
  .argv((input) => ['curl', '--fail', '--silent', `https://${input.service}.internal/health`])
  .on(appLocal);

const heartbeatFlow = H.flow('heartbeat').for(heartbeat).does(async (ctx) => {
  const probe = await ctx.run(healthProbe, { service: ctx.unit.data.service });
  return probe.ok ? 'healthy' : 'unhealthy';
});

const bugTracker = linear.tracker(bug, {
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'APP',
  label: 'bug',
  read: (issue) => ({ title: issue.title, description: issue.description }),
  statuses: { open: 'Todo', done: 'Done', 'wont-fix': 'Won’t Fix', abandoned: 'Canceled' },
});

const featureTracker = linear.tracker(feature, {
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'APP',
  label: 'feature',
  read: (issue) => ({ title: issue.title, description: issue.description }),
  statuses: { open: 'Todo', done: 'Done', 'wont-fix': 'Won’t Fix', abandoned: 'Canceled' },
});

const bugFolder = folder.files(bug, {
  dir: '/srv/repos/app/bugs',
  read: (file) => ({ title: String(file.frontmatter['title'] ?? file.path), description: file.body }),
  key: (file) => file.path,
});

const bugLane = H.lane('bugs', bug)
  .handler(buildAndAudit, { retries: 1, exhausted: 'abandoned', params: { rounds: 3 } })
  .suppliers(bugTracker, bugFolder, H.operator)
  .store(bugTracker)
  .wip(2);

const featureLane = H.lane('features', feature)
  .handler(buildAndAudit, { retries: 1, exhausted: 'abandoned', params: { rounds: 5 } })
  .suppliers(featureTracker, H.operator)
  .store(featureTracker);

const heartbeatLane = H.lane('heartbeats', heartbeat)
  .handler(heartbeatFlow, { exhausted: 'unhealthy' })
  .suppliers(H.clock('every-five-minutes', heartbeat, { every: { minutes: 5 } }, () => [{ create: { service: 'api' } }]));

const unhealthyFilesBug = H.trigger('unhealthy-heartbeat-files-bug', H.on.enters(heartbeat, 'unhealthy'), (event, act) =>
  act.create(
    bugLane,
    {
      title: `${event.unit.data.service} heartbeat failed`,
      description: `The heartbeat for ${event.unit.data.service} failed at ${event.at.toISOString()}.`,
    },
    `heartbeat-${event.unit.data.service}`
  )
);

const codingScheduler = H.policy.scheduler('heartbeats-bugs-features', (view) => {
  const rank = (unit: PendingView): number => {
    if (unit.is(heartbeat)) return 0;
    if (unit.is(feature) && unit.waitedMs > 14_400_000) return 1;
    if (unit.is(bug)) return 2;
    if (unit.is(feature)) return 3;
    return 4;
  };
  return { start: [...view.pending].sort((a, b) => rank(a) - rank(b) || b.waitedMs - a.waitedMs) };
});

const ownerGrants = [
  H.ops.readWork,
  H.ops.writeWork,
  H.ops.readMemory,
  H.ops.writeMemory,
  H.ops.readTelemetry,
  H.ops.readAccounts,
  H.ops.setShares,
];

const apiFallback = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });

export const codingHarness = H.harness('coding-team')
  .ledger(sqlite.ledger('/srv/repos/app/.harness/ledger.sqlite'))
  .lanes(heartbeatLane, bugLane, featureLane)
  .pools(subscriptionPool('coding-subscriptions', 0.6, [{ account: apiFallback, share: 1 }]))
  .triggers(unhealthyFilesBug)
  .scheduler(codingScheduler)
  .clients(
    http.control({
      port: 7701,
      token: H.env('CODING_CONTROL_TOKEN'),
      grants: [...ownerGrants, H.ops.resolve(ownerDecision)],
    })
  )
  .observers(markdown.board('/srv/repos/app/.harness/board.md'), markdown.telemetry('/srv/repos/app/.harness/telemetry.md'));

const docPage = H.kind('doc-page')
  .data(z.object({ path: z.string(), title: z.string(), body: z.string() }))
  .states(H.state('stale', 'pending'), H.state('current', 'terminal', 'success'), H.state('needs-attention', 'terminal', 'failure'));

const docsExperience = H.journal(
  'docs-experience',
  H.memory('experience', 'experience'),
  jsonl.memory('/srv/repos/docs/.harness/experience.jsonl')
);

const docsWorktrees = git.worktree('docs-worktrees', { repo: '/srv/repos/docs', slots: 2 });
const docsLocal = shell.local('docs-local', { slots: 2 });

const writerRole = H.role('writer')
  .input(z.object({ path: z.string(), title: z.string(), body: z.string() }))
  .output(z.object({ summary: z.string() }))
  .prompt((input) => `Bring the page "${input.title}" at ${input.path} up to date.\n${input.body}`)
  .intents(['read', 'edit']);

const writer = H.seat('writer', writerRole)
  .model(sharedModels.sonnet)
  .on(docsWorktrees)
  .recalls(docsExperience, ownerTaste)
  .records(docsExperience);

const linkCheck = H.command('link-check')
  .input(z.object({ path: z.string() }))
  .argv((input) => ['npx', 'linkinator', input.path])
  .on(docsLocal);

const docFlow = H.flow('write-and-link-check').for(docPage).does(async (ctx) => {
  const written = await ctx.run(writer, ctx.unit.data);
  if (!written.ok) return ctx.fail(written.error);
  const links = await ctx.run(linkCheck, { path: ctx.unit.data.path });
  if (!links.ok) return ctx.fail(links.error);
  return 'current';
});

const docFolder = folder.files(docPage, {
  dir: '/srv/repos/docs/pages',
  read: (file) => ({ path: file.path, title: String(file.frontmatter['title'] ?? file.path), body: file.body }),
  key: (file) => file.path,
});

const docLane = H.lane('doc-pages', docPage)
  .handler(docFlow, { retries: 2, exhausted: 'needs-attention' })
  .suppliers(docFolder)
  .store(docFolder)
  .wip(2);

export const docsHarness = H.harness('documentation')
  .ledger(sqlite.ledger('/srv/repos/docs/.harness/ledger.sqlite'))
  .lanes(docLane)
  .pools(subscriptionPool('docs-subscriptions', 0.3, []))
  .clients(http.control({ port: 7702, token: H.env('DOCS_CONTROL_TOKEN'), grants: ownerGrants }))
  .observers(markdown.board('/srv/repos/docs/.harness/board.md'));
