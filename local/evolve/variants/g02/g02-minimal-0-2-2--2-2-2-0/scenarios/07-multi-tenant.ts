import { z } from 'zod';
import { H } from 'harness-dsl';
import type { PendingView } from 'harness-dsl';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as linear from 'harness-dsl/linear';
import * as folder from 'harness-dsl/folder';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as git from 'harness-dsl/git';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const sharedQuota = sqlite.quota('/home/owner/.harness/shared-quota.sqlite');

const subscriptionOne = claudeCode.subscription('claude-subscription-1', { token: H.env('CLAUDE_TOKEN_1'), quota: sharedQuota });
const subscriptionTwo = claudeCode.subscription('claude-subscription-2', { token: H.env('CLAUDE_TOKEN_2'), quota: sharedQuota });
const subscriptionThree = claudeCode.subscription('claude-subscription-3', { token: H.env('CLAUDE_TOKEN_3'), quota: sharedQuota });
const apiAccount = anthropic.account('api-fallback', { apiKey: H.env('ANTHROPIC_API_KEY'), quota: sharedQuota });
const subscriptions = [subscriptionOne, subscriptionTwo, subscriptionThree];

const sonnet = claudeCode.model('claude-sonnet-4-5');
const opus = claudeCode.model('claude-opus-4-1');

const soonestExpiringSubscriptionFirst = H.policy.account('soonest-expiring-subscription-first', choice => {
  const usable = choice.accounts.filter(view => view.eligible && view.usedShare < view.share);
  const ordered = [...usable].sort((a, b) =>
    a.account.plan === b.account.plan
      ? (a.windowEndsAt ? a.windowEndsAt.getTime() : Number.MAX_SAFE_INTEGER) -
        (b.windowEndsAt ? b.windowEndsAt.getTime() : Number.MAX_SAFE_INTEGER)
      : a.account.plan === 'subscription' ? -1 : 1
  );
  const [first] = ordered;
  return first ? first.account : null;
});

const membersAtShare = (share: number) => [
  ...subscriptions.map(account => ({ account, share })),
  { account: apiAccount, share: 1 },
];

const ownerTaste = H.memory('owner-taste', 'taste');
const experience = H.memory('experience', 'experience');
const sharedTasteJournal = H.journal('owner-taste-journal', ownerTaste, jsonl.memory('/home/owner/.harness/taste.jsonl'));

const workItem = z.object({ title: z.string(), description: z.string() });

const todo = H.state('todo', 'pending');
const done = H.state('done', 'terminal', 'success');
const unresolved = H.state('unresolved', 'terminal', 'failure');
const wontDo = H.state('wont-do', 'terminal', 'neutral');

const bug = H.kind('bug').data(workItem).states(todo, done, unresolved, wontDo);
const feature = H.kind('feature').data(workItem).states(todo, done, unresolved, wontDo);

const trackerStatuses = { todo: 'Todo', done: 'Done', unresolved: 'Canceled', 'wont-do': "Won't Do" };

const bugTracker = linear.tracker(bug, {
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'product',
  label: 'bug',
  read: issue => ({ title: issue.title, description: issue.description }),
  statuses: trackerStatuses,
});
const featureTracker = linear.tracker(feature, {
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'product',
  label: 'feature',
  read: issue => ({ title: issue.title, description: issue.description }),
  statuses: trackerStatuses,
});
const bugFolder = folder.files(bug, {
  dir: '/repos/product/bugs',
  read: file => ({ title: String(file.frontmatter.title ?? file.path), description: file.body }),
});

const codingExperienceJournal = H.journal('coding-experience', experience, jsonl.memory('/repos/product/.harness/experience.jsonl'));

const worktrees = git.worktree('product-worktrees', { repo: '/repos/product', slots: 3 });
const localShell = shell.local('product-shell', { slots: 2 });

const projectChecks = H.command('project-checks').argv(() => ['npm', 'run', 'check']).on(localShell);

const builderRole = H.role('builder')
  .input(z.object({ title: z.string(), description: z.string(), deficits: z.array(z.string()) }))
  .output(z.object({ summary: z.string(), question: z.string().optional() }))
  .prompt(input => `Build: ${input.title}\n${input.description}\nOpen deficits:\n${input.deficits.join('\n')}`)
  .intents(['read', 'edit', 'execute']);

const auditorRole = H.role('auditor')
  .input(z.object({ title: z.string(), summary: z.string() }))
  .output(z.object({ deficits: z.array(z.string()) }))
  .prompt(input => `Audit the change for "${input.title}": ${input.summary}. List every deficit.`)
  .intents(['read', 'execute']);

const builderModel = H.policy.model('cheaper-until-unreliable', choice => {
  const record = choice.metrics.successRate({ kind: choice.kind, model: sonnet, days: 14 });
  return record.samples >= 20 && record.value !== null && record.value < 0.85 ? opus : sonnet;
});

const builder = H.seat('builder', builderRole)
  .model(builderModel)
  .on(worktrees)
  .guards(claudeCode.fileLeases(), claudeCode.stopCheck(projectChecks))
  .recalls(codingExperienceJournal, sharedTasteJournal);

const auditor = H.seat('auditor', auditorRole)
  .model(sonnet)
  .on(worktrees)
  .recalls(codingExperienceJournal)
  .records(codingExperienceJournal);

const ownerDecision = H.halt('owner-decision', z.object({ answer: z.string() }));

const delivery = H.flow('delivery')
  .for(bug, feature)
  .params(z.object({ rounds: z.number() }))
  .does(async ctx => {
    let deficits: string[] = [];
    for (let round = 1; round <= ctx.params.rounds; round += 1) {
      const built = await ctx.run(builder, { title: ctx.unit.data.title, description: ctx.unit.data.description, deficits });
      if (!built.ok) return ctx.fail(built.error);
      if (built.value.question) {
        const decision = await ctx.halt(ownerDecision, built.value.question);
        deficits = [...deficits, `Owner decided: ${decision.answer}`];
        continue;
      }
      const audited = await ctx.run(auditor, { title: ctx.unit.data.title, summary: built.value.summary });
      if (!audited.ok) return ctx.fail(audited.error);
      if (audited.value.deficits.length === 0) return 'done';
      deficits = audited.value.deficits;
    }
    return 'unresolved';
  });

const bugs = H.lane('bugs', bug).handler(delivery, { rounds: 3 }).suppliers(bugTracker, bugFolder, H.operator).store(bugTracker).wip(2);
const features = H.lane('features', feature).handler(delivery, { rounds: 5 }).suppliers(featureTracker, H.operator).store(featureTracker);

const codingPriority = (unit: PendingView) => (unit.is(bug) ? 0 : unit.waitedMs > 2 * 60 * 60 * 1000 ? 0 : 1);
const codingScheduler = H.policy.scheduler('bugs-then-features', view => ({
  start: [...view.pending].sort((a, b) => codingPriority(a) - codingPriority(b)),
}));

export const codingHarness = H.harness('coding-team')
  .ledger(sqlite.ledger('/repos/product/.harness/ledger.sqlite'))
  .lanes(bugs, features)
  .pools(H.pool('coding-accounts', membersAtShare(0.6), soonestExpiringSubscriptionFirst))
  .scheduler(codingScheduler)
  .clients(
    claudeCode.supervisor({
      grants: [
        H.ops.readWork,
        H.ops.writeWork,
        H.ops.resolve(ownerDecision, H.halts.changed, H.halts.interrupted),
        H.ops.writeMemory,
        H.ops.readTelemetry,
        H.ops.readAccounts,
        H.ops.setShares,
      ],
    })
  )
  .observers(markdown.board('/repos/product/.harness/BOARD.md'), markdown.telemetry('/repos/product/.harness/TELEMETRY.md'));

const stale = H.state('stale', 'pending');
const published = H.state('published', 'terminal', 'success');
const retired = H.state('retired', 'terminal', 'neutral');

const docPage = H.kind('doc-page')
  .data(z.object({ path: z.string(), title: z.string(), body: z.string() }))
  .states(stale, published, retired);

const docFolder = folder.files(docPage, {
  dir: '/repos/docs/pages',
  read: file => ({ path: file.path, title: String(file.frontmatter.title ?? file.path), body: file.body }),
  key: file => file.path,
});

const docsExperienceJournal = H.journal('docs-experience', experience, jsonl.memory('/repos/docs/.harness/experience.jsonl'));
const docsShell = shell.local('docs-shell', { slots: 2 });

const writerRole = H.role('writer')
  .input(z.object({ title: z.string(), body: z.string() }))
  .output(z.object({ body: z.string() }))
  .prompt(input => `Rewrite the page "${input.title}" so it is current and clear:\n${input.body}`)
  .intents(['read']);

const writer = H.seat('writer', writerRole)
  .model(sonnet)
  .recalls(sharedTasteJournal, docsExperienceJournal)
  .records(docsExperienceJournal);

const linkCheck = H.command('link-check')
  .input(z.object({ path: z.string() }))
  .argv(input => ['npx', 'linkinator', input.path])
  .on(docsShell);

const docWriting = H.flow('doc-writing')
  .for(docPage)
  .does(async ctx => {
    const written = await ctx.run(writer, { title: ctx.unit.data.title, body: ctx.unit.data.body });
    if (!written.ok) return ctx.fail(written.error);
    await ctx.update({ body: written.value.body });
    const checked = await ctx.run(linkCheck, { path: ctx.unit.data.path });
    if (!checked.ok) return ctx.fail(checked.error);
    return 'published';
  });

const docPages = H.lane('doc-pages', docPage).handler(docWriting).suppliers(docFolder).store(docFolder).wip(2);

export const docsHarness = H.harness('documentation')
  .ledger(sqlite.ledger('/repos/docs/.harness/ledger.sqlite'))
  .lanes(docPages)
  .pools(H.pool('docs-accounts', membersAtShare(0.3), soonestExpiringSubscriptionFirst))
  .clients(
    claudeCode.supervisor({
      grants: [
        H.ops.readWork,
        H.ops.writeWork,
        H.ops.resolve(H.halts.changed, H.halts.interrupted),
        H.ops.writeMemory,
        H.ops.readTelemetry,
        H.ops.readAccounts,
        H.ops.setShares,
      ],
    })
  )
  .observers(markdown.board('/repos/docs/.harness/BOARD.md'));
