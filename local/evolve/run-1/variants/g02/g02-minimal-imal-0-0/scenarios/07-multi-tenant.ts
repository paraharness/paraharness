import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Account, AccountPolicy, PendingView } from 'harness-dsl';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as linear from 'harness-dsl/linear';
import * as folder from 'harness-dsl/folder';
import * as git from 'harness-dsl/git';
import * as http from 'harness-dsl/http';

const HOUR = 60 * 60 * 1000;

const sharedQuota = sqlite.quota('/home/owner/.harness/shared-quota.db');

const subscriptions: readonly Account[] = [1, 2, 3].map(n =>
  claudeCode.subscription(`claude-subscription-${n}`, {
    token: H.env(`CLAUDE_SUBSCRIPTION_${n}_TOKEN`),
    quota: sharedQuota,
  }));

const soonestExpiring: AccountPolicy = H.policy.account('soonest-expiring', ({ accounts }) => {
  const eligible = accounts.filter(view => view.eligible && view.usedShare < view.share);
  const ordered = [...eligible].sort((x, y) =>
    (x.windowEndsAt?.getTime() ?? Number.MAX_SAFE_INTEGER) - (y.windowEndsAt?.getTime() ?? Number.MAX_SAFE_INTEGER));
  return ordered[0]?.account ?? null;
});

const taste = H.memory('taste', 'owner');
const experience = H.memory('experience', 'fallible');

const specificFirst = H.policy.recall('specific-first', view =>
  [...view.items]
    .sort((x, y) => y.specificity - x.specificity || (y.trackRecord.value ?? 0) - (x.trackRecord.value ?? 0))
    .slice(0, 10));

const sharedTaste = H.library('owner-taste', taste, jsonl.memory('/home/owner/.harness/taste.jsonl')).recall(specificFirst);

const sonnet = claudeCode.model('sonnet');
const opus = claudeCode.model('opus');

const controlGrants = [
  H.ops.readWork,
  H.ops.writeWork,
  H.ops.resolveHalts,
  H.ops.readMemory,
  H.ops.writeMemory,
  H.ops.readTelemetry,
  H.ops.readAccounts,
  H.ops.setShares,
];

const ticket = H.lifecycle({
  queued: 'pending',
  done: 'success',
  abandoned: 'failure',
  declined: 'neutral',
});

const ticketData = z.object({ title: z.string(), body: z.string(), epic: z.string().optional() });

const Bug = H.kind('bug').data(ticketData).states(ticket, 'queued');
const Feature = H.kind('feature').data(ticketData).states(ticket, 'queued');
const Epic = H.kind('epic')
  .data(z.object({ title: z.string(), body: z.string() }))
  .states({ open: 'pending', decomposed: 'waiting', closing: 'pending', done: 'success', dropped: 'neutral' }, 'open');

const ticketStatuses = { queued: 'Todo', done: 'Done', abandoned: 'Canceled', declined: "Won't Do" };
const linearKey = H.env('LINEAR_API_KEY');

const bugTracker = linear.tracker(Bug, {
  apiKey: linearKey,
  team: 'APP',
  label: 'bug',
  read: issue => ({ title: issue.title, body: issue.description }),
  statuses: ticketStatuses,
});
const featureTracker = linear.tracker(Feature, {
  apiKey: linearKey,
  team: 'APP',
  label: 'feature',
  read: issue => ({ title: issue.title, body: issue.description, epic: issue.parentId }),
  statuses: ticketStatuses,
});
const epicTracker = linear.tracker(Epic, {
  apiKey: linearKey,
  team: 'APP',
  label: 'epic',
  read: issue => ({ title: issue.title, body: issue.description }),
  statuses: { open: 'Todo', decomposed: 'In Progress', closing: 'In Review', done: 'Done', dropped: 'Canceled' },
});
const bugFolder = folder.files(Bug, {
  dir: 'bugs',
  read: file => ({ title: String(file.frontmatter['title'] ?? file.path), body: file.body }),
});

const appWorktree = git.worktree('app-worktree', { repo: '/home/owner/code/app', slots: 3 });

const projectChecks = H.command('project-checks')
  .argv(() => ['npm', 'run', 'check'])
  .on(appWorktree)
  .restart('rerun');

const experienceA = H.library('app-experience', experience, jsonl.memory('/home/owner/code/app/.harness/experience.jsonl')).recall(specificFirst);

const builderRole = H.role('builder')
  .input(z.object({
    title: z.string(),
    body: z.string(),
    round: z.number(),
    deficits: z.array(z.string()),
    ownerAnswer: z.string(),
  }))
  .output(z.object({ summary: z.string(), question: z.string().optional() }))
  .prompt(input => [
    `Round ${input.round}: ${input.title}`,
    input.body,
    input.deficits.length > 0 ? `Fix these deficits:\n${input.deficits.join('\n')}` : '',
    input.ownerAnswer ? `Owner decided: ${input.ownerAnswer}` : '',
  ].join('\n\n'))
  .intents(['read', 'edit', 'execute']);

const auditorRole = H.role('auditor')
  .input(z.object({ title: z.string(), body: z.string(), summary: z.string() }))
  .output(z.object({ deficits: z.array(z.string()) }))
  .prompt(input => `Audit the change for "${input.title}".\n\n${input.body}\n\nBuilder says: ${input.summary}`)
  .intents(['read', 'execute']);

const plannerRole = H.role('planner')
  .input(z.object({ title: z.string(), body: z.string() }))
  .output(z.object({ features: z.array(z.object({ title: z.string(), body: z.string() })) }))
  .prompt(input => `Decompose this epic into features.\n\n${input.title}\n\n${input.body}`)
  .intents(['read']);

const builderModel = H.policy.model('builder-model', ({ kind, metrics }) => {
  const cheap = metrics.successRate({ kind, model: sonnet.name, days: 14 });
  return cheap.samples >= 20 && cheap.value !== null && cheap.value < 0.85 ? opus : sonnet;
});

const builder = H.agent('builder', builderRole)
  .model(builderModel)
  .on(appWorktree)
  .recalls(experienceA, sharedTaste)
  .guards(claudeCode.fileLeases(), claudeCode.stopCheck(projectChecks));

const auditor = H.agent('auditor', auditorRole)
  .model(sonnet)
  .on(appWorktree)
  .recalls(experienceA)
  .records(experienceA);

const planner = H.agent('planner', plannerRole).model(opus).recalls(sharedTaste);

const ticketFlow = H.flow('ticket')
  .for(Bug, Feature)
  .params(z.object({ rounds: z.number() }))
  .does(async ctx => {
    const { title, body } = ctx.unit.data;
    let deficits: string[] = [];
    let ownerAnswer = '';
    for (let round = 1; round <= ctx.params.rounds; round++) {
      const built = await ctx.run(builder, { title, body, round, deficits, ownerAnswer });
      if (!built.ok) return ctx.fail(built.error);
      if (built.value.question) {
        const decision = await ctx.halt({
          name: 'owner-decision',
          show: built.value.question,
          decision: z.object({ answer: z.string() }),
        });
        ownerAnswer = decision.answer;
        continue;
      }
      const audit = await ctx.run(auditor, { title, body, summary: built.value.summary });
      if (!audit.ok) return ctx.fail(audit.error);
      if (audit.value.deficits.length === 0) return 'done';
      deficits = audit.value.deficits;
    }
    return 'abandoned';
  });

const bugs = H.lane('bugs', Bug)
  .handler(ticketFlow, { rounds: 3 })
  .suppliers(bugTracker, bugFolder, H.operator)
  .store(bugTracker)
  .wip(2);

const features = H.lane('features', Feature)
  .handler(ticketFlow, { rounds: 5 })
  .suppliers(featureTracker, H.operator)
  .store(featureTracker);

const epicFlow = H.flow('epic').for(Epic).does(async ctx => {
  if (ctx.unit.state === 'closing') {
    const children = await ctx.children();
    return children.every(child => child.verdict === 'success') ? 'done' : 'dropped';
  }
  const plan = await ctx.run(planner, { title: ctx.unit.data.title, body: ctx.unit.data.body });
  if (!plan.ok) return ctx.fail(plan.error);
  await ctx.spawn(features, plan.value.features.map(feature => ({ title: feature.title, body: feature.body, epic: ctx.unit.key })));
  return ctx.until('decomposed', { children: true, then: 'closing' });
});

const epics = H.lane('epics', Epic)
  .handler(epicFlow)
  .suppliers(epicTracker)
  .store(epicTracker)
  .wip(1);

const apiFallback = anthropic.account('app-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota: sharedQuota });

const poolA = H.pool('app-subscriptions', [
  ...subscriptions.map(account => ({ account, share: 0.6 })),
  { account: apiFallback, share: 1 },
], soonestExpiring);

const codingOrder = ['bugs', 'features', 'epics'];
const codingRank = (unit: PendingView) =>
  unit.lane === 'features' && unit.waitedMs > 4 * HOUR ? -1 : codingOrder.indexOf(unit.lane);

export const projectA = H.harness('app')
  .ledger(sqlite.ledger('/home/owner/code/app/.harness/ledger.db'))
  .lanes(bugs, features, epics)
  .pools(poolA)
  .scheduler(H.policy.scheduler('coding-priority', ({ pending }) => ({
    start: [...pending].sort((x, y) => codingRank(x) - codingRank(y)),
  })))
  .clients(http.control({ port: 7101, token: H.env('APP_CONTROL_TOKEN'), grants: controlGrants }));

const DocPage = H.kind('doc-page')
  .data(z.object({ path: z.string(), title: z.string(), brief: z.string() }))
  .states({ stale: 'pending', current: 'success', stuck: 'failure' }, 'stale');

const docFolder = folder.files(DocPage, {
  dir: '/home/owner/code/docs/pages',
  read: file => ({ path: file.path, title: String(file.frontmatter['title'] ?? file.path), brief: file.body }),
  write: (data, state) => ({ title: data.title, status: state }),
});

const docsWorktree = git.worktree('docs-worktree', { repo: '/home/owner/code/docs', slots: 2 });

const linkCheck = H.command('link-check')
  .input(z.object({ path: z.string() }))
  .output(z.object({ broken: z.array(z.string()) }))
  .argv(input => ['link-check', '--json', input.path])
  .on(docsWorktree)
  .restart('rerun');

const experienceB = H.library('docs-experience', experience, jsonl.memory('/home/owner/code/docs/.harness/experience.jsonl')).recall(specificFirst);

const writerRole = H.role('writer')
  .input(z.object({ path: z.string(), title: z.string(), brief: z.string(), brokenLinks: z.array(z.string()) }))
  .output(z.object({ summary: z.string() }))
  .prompt(input => [
    `Write or refresh ${input.path}: ${input.title}`,
    input.brief,
    input.brokenLinks.length > 0 ? `Fix these broken links:\n${input.brokenLinks.join('\n')}` : '',
  ].join('\n\n'))
  .intents(['read', 'edit']);

const writer = H.agent('writer', writerRole)
  .model(sonnet)
  .on(docsWorktree)
  .recalls(sharedTaste, experienceB)
  .records(experienceB);

const docFlow = H.flow('doc-page').for(DocPage).does(async ctx => {
  const { path, title, brief } = ctx.unit.data;
  let brokenLinks: string[] = [];
  for (let round = 1; round <= 2; round++) {
    const written = await ctx.run(writer, { path, title, brief, brokenLinks });
    if (!written.ok) return ctx.fail(written.error);
    const checked = await ctx.run(linkCheck, { path });
    if (!checked.ok) return ctx.fail(checked.error);
    if (checked.value.broken.length === 0) return 'current';
    brokenLinks = checked.value.broken;
  }
  return 'stuck';
});

const docs = H.lane('docs', DocPage)
  .handler(docFlow)
  .suppliers(docFolder)
  .store(docFolder)
  .wip(2);

const poolB = H.pool('docs-subscriptions', subscriptions.map(account => ({ account, share: 0.3 })), soonestExpiring);

export const projectB = H.harness('docs')
  .ledger(sqlite.ledger('/home/owner/code/docs/.harness/ledger.db'))
  .lanes(docs)
  .pools(poolB)
  .scheduler(H.policy.scheduler('oldest-first', ({ pending }) => ({
    start: [...pending].sort((x, y) => y.waitedMs - x.waitedMs),
  })))
  .clients(http.control({ port: 7102, token: H.env('DOCS_CONTROL_TOKEN'), grants: controlGrants }));
