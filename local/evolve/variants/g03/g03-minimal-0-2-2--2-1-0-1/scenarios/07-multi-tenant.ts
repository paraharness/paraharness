import { H } from 'harness-dsl';
import type { PendingView } from 'harness-dsl';
import { z } from 'zod';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as linear from 'harness-dsl/linear';
import * as folder from 'harness-dsl/folder';
import * as git from 'harness-dsl/git';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

export const sharedQuota = sqlite.quota('/home/owner/.harness/claude-quota.db');

export const sonnet = anthropic.model('claude-sonnet-4-5');
export const opus = anthropic.model('claude-opus-4-1');

export const claudeOne = claudeCode.subscription('claude-one', { token: H.env('CLAUDE_ONE_TOKEN'), quota: sharedQuota });
export const claudeTwo = claudeCode.subscription('claude-two', { token: H.env('CLAUDE_TWO_TOKEN'), quota: sharedQuota });
export const claudeThree = claudeCode.subscription('claude-three', { token: H.env('CLAUDE_THREE_TOKEN'), quota: sharedQuota });
export const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota: sharedQuota });

export const soonestExpiringFirst = H.policy.account('soonest-expiring-first', choice => {
  const eligible = choice.accounts.filter(view => view.eligible && view.usedShare < view.share);
  const subscriptions = eligible
    .filter(view => view.account.plan === 'subscription')
    .sort((a, b) => (a.windowEndsAt?.getTime() ?? Number.MAX_SAFE_INTEGER) - (b.windowEndsAt?.getTime() ?? Number.MAX_SAFE_INTEGER));
  const pick = subscriptions.length > 0 ? subscriptions[0] : eligible.find(view => view.account.plan === 'metered');
  return pick ? pick.account : null;
});

export const sharedMembers = (share: number) => [
  { account: claudeOne, share, serves: [sonnet, opus] },
  { account: claudeTwo, share, serves: [sonnet, opus] },
  { account: claudeThree, share, serves: [sonnet, opus] },
  { account: apiAccount, share: 1, serves: [sonnet, opus] },
];

export const tasteMemory = H.memory('taste', 'taste');
export const experienceMemory = H.memory('experience', 'experience');
export const ownerTaste = H.journal('owner-taste', tasteMemory, jsonl.memory('/home/owner/.harness/taste.jsonl'));

const open = H.state('open', 'pending');
const done = H.state('done', 'terminal', 'success');
const wontFix = H.state('wontFix', 'terminal', 'neutral');
const stuck = H.state('stuck', 'terminal', 'failure');

const workItem = z.object({ title: z.string(), body: z.string() });
const bug = H.kind('Bug').data(workItem).states(open, done, wontFix, stuck);
const feature = H.kind('Feature').data(workItem).states(open, done, wontFix, stuck);

const productExperience = H.journal('product-experience', experienceMemory, jsonl.memory('product/.harness/experience.jsonl'));

const worktree = git.worktree('product-worktree', { repo: 'product', slots: 3 });
const productShell = shell.local('product-shell', { slots: 2 });

const projectChecks = H.command('project-checks').argv(() => ['npm', 'run', 'check']).on(productShell).recovery('rerun');

const building = H.role('builder')
  .input(z.object({ title: z.string(), body: z.string(), deficits: z.array(z.string()) }))
  .output(z.object({ summary: z.string(), question: z.string().optional() }))
  .prompt(input => `Build: ${input.title}\n${input.body}\nOpen deficits:\n${input.deficits.join('\n')}`)
  .intents(['read', 'edit', 'execute']);

const auditing = H.role('auditor')
  .input(z.object({ title: z.string(), summary: z.string() }))
  .output(z.object({ deficits: z.array(z.string()) }))
  .prompt(input => `Audit the change for ${input.title}: ${input.summary}`)
  .intents(['read', 'execute']);

const cheapUntilWorse = H.policy.model('builder-cheap-until-worse', [sonnet, opus], choice => {
  const record = choice.metrics.successRate({ kind: choice.kind, model: sonnet, days: 14 });
  return record.samples >= 20 && record.value !== null && record.value < 0.85 ? opus : sonnet;
});

const builder = H.seat('builder', building)
  .model(cheapUntilWorse)
  .on(worktree)
  .recalls(productExperience, ownerTaste)
  .guards(claudeCode.fileLeases(), claudeCode.stopCheck(projectChecks));

const auditor = H.seat('auditor', auditing).model(sonnet).on(worktree).recalls(productExperience).records(productExperience);

const ownerDecision = H.halt('owner-decision', z.object({ proceed: z.boolean(), note: z.string().optional() }));

const buildAndAudit = H.flow('build-and-audit')
  .for(bug, feature)
  .params(z.object({ rounds: z.number() }))
  .does(async ctx => {
    let deficits: readonly string[] = [];
    for (let round = 0; round < ctx.params.rounds; round++) {
      const built = await ctx.run(builder, { title: ctx.unit.data.title, body: ctx.unit.data.body, deficits: [...deficits] });
      if (!built.ok) return ctx.fail(built.error);
      if (built.value.question) {
        const decision = await ctx.halt(ownerDecision, built.value.question);
        if (!decision.proceed) return 'wontFix';
      }
      const audit = await ctx.run(auditor, { title: ctx.unit.data.title, summary: built.value.summary });
      if (!audit.ok) return ctx.fail(audit.error);
      if (audit.value.deficits.length === 0) return 'done';
      deficits = audit.value.deficits;
    }
    return ctx.fail('build-and-audit rounds ran out with deficits open');
  });

const trackerStatuses = { open: 'Todo', done: 'Done', wontFix: 'Canceled', stuck: 'Stuck' };

const bugTracker = linear.tracker(bug, {
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'PRODUCT',
  label: 'bug',
  read: issue => ({ title: issue.title, body: issue.description }),
  statuses: trackerStatuses,
});
const featureTracker = linear.tracker(feature, {
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'PRODUCT',
  label: 'feature',
  read: issue => ({ title: issue.title, body: issue.description }),
  statuses: trackerStatuses,
});
const bugFolder = folder.files(bug, { dir: 'product/bugs', read: file => ({ title: file.path, body: file.body }) });

const bugs = H.lane('bugs', bug)
  .handler(buildAndAudit, { rounds: 3 })
  .attempts(2, { backoff: { first: { minutes: 10 } }, exhausted: 'stuck' })
  .suppliers(bugTracker, bugFolder, H.operator)
  .store(bugTracker)
  .wip(2);

const features = H.lane('features', feature)
  .handler(buildAndAudit, { rounds: 5 })
  .attempts(2, { backoff: { first: { minutes: 10 } }, exhausted: 'stuck' })
  .suppliers(featureTracker, H.operator)
  .store(featureTracker);

const bugsThenFeatures = H.policy.scheduler('bugs-then-features', view => {
  const rank = (unit: PendingView): number => (unit.is(bug) || unit.waitedMs > 4 * 3_600_000 ? 0 : 1);
  return { start: [...view.pending].sort((a, b) => rank(a) - rank(b) || b.waitedMs - a.waitedMs) };
});

const ownerGrants = [
  H.ops.readWork,
  H.ops.writeWork,
  H.ops.resolveHalts,
  H.ops.writeMemory,
  H.ops.readTelemetry,
  H.ops.readAccounts,
  H.ops.setShares,
];

export const product = H.harness('product')
  .ledger(sqlite.ledger('product/.harness/ledger.db'))
  .lanes(bugs, features)
  .pools(H.pool('claude', sharedMembers(0.6), soonestExpiringFirst))
  .scheduler(bugsThenFeatures)
  .clients(claudeCode.supervisor({ grants: ownerGrants }))
  .observers(markdown.board('product/BOARD.md'), markdown.telemetry('product/TELEMETRY.md'));

const stale = H.state('stale', 'pending');
const published = H.state('published', 'terminal', 'success');
const broken = H.state('broken', 'terminal', 'failure');

const docPage = H.kind('DocPage').data(z.object({ path: z.string(), body: z.string() })).states(stale, published, broken);

const docsFolder = folder.files(docPage, {
  dir: 'docs/pages',
  read: file => ({ path: file.path, body: file.body }),
  key: file => file.path,
});

const docsExperience = H.journal('docs-experience', experienceMemory, jsonl.memory('docs/.harness/experience.jsonl'));
const docsShell = shell.local('docs-shell', { slots: 2 });

const writing = H.role('writer')
  .input(z.object({ path: z.string(), body: z.string() }))
  .output(z.object({ body: z.string() }))
  .prompt(input => `Revise the page ${input.path}:\n${input.body}`);

const writer = H.seat('writer', writing).model(sonnet).recalls(ownerTaste, docsExperience).records(docsExperience);

const linkCheck = H.command('link-check')
  .input(z.object({ path: z.string() }))
  .argv(input => ['npx', 'markdown-link-check', input.path])
  .on(docsShell)
  .recovery('rerun');

const writePage = H.flow('write-page').for(docPage).does(async ctx => {
  const written = await ctx.run(writer, { path: ctx.unit.data.path, body: ctx.unit.data.body });
  if (!written.ok) return ctx.fail(written.error);
  await ctx.update({ body: written.value.body });
  const links = await ctx.run(linkCheck, { path: ctx.unit.data.path });
  return links.ok ? 'published' : ctx.fail(links.error);
});

const pages = H.lane('pages', docPage)
  .handler(writePage)
  .attempts(3, { exhausted: 'broken' })
  .suppliers(docsFolder)
  .store(docsFolder)
  .wip(2);

export const docs = H.harness('docs')
  .ledger(sqlite.ledger('docs/.harness/ledger.db'))
  .lanes(pages)
  .pools(H.pool('claude', sharedMembers(0.3), soonestExpiringFirst))
  .clients(claudeCode.supervisor({ grants: ownerGrants }))
  .observers(markdown.board('docs/BOARD.md'));
