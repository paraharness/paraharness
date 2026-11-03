import { H } from 'harness-dsl';
import { z } from 'zod';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as folder from 'harness-dsl/folder';
import * as linear from 'harness-dsl/linear';
import * as git from 'harness-dsl/git';
import * as shell from 'harness-dsl/shell';
import * as http from 'harness-dsl/http';
import * as markdown from 'harness-dsl/markdown';

const sharedQuota = sqlite.quota('/home/owner/.harness/subscriptions-quota.sqlite');

export const shared = {
  accounts: [
    claudeCode.subscription('subscription-one', { token: H.env('CLAUDE_TOKEN_ONE'), quota: sharedQuota }),
    claudeCode.subscription('subscription-two', { token: H.env('CLAUDE_TOKEN_TWO'), quota: sharedQuota }),
    claudeCode.subscription('subscription-three', { token: H.env('CLAUDE_TOKEN_THREE'), quota: sharedQuota }),
  ],
  sonnet: anthropic.model('claude-sonnet-4-5'),
  opus: anthropic.model('claude-opus-4-1'),
  experience: H.memory('experience', 'experience'),
  ownerTaste: H.journal('owner-taste', H.memory('taste', 'taste'), jsonl.memory('/home/owner/.harness/taste.jsonl')),
  soonestExpiring: H.policy.account('subscriptions-soonest-expiring-first', (choice) => {
    const open = choice.accounts.filter((view) => view.eligible && view.usedShare < view.share);
    const ranked = [...open].sort(
      (left, right) =>
        (left.account.plan === 'subscription' ? 0 : 1) - (right.account.plan === 'subscription' ? 0 : 1) ||
        (left.windowEndsAt?.getTime() ?? Number.MAX_SAFE_INTEGER) - (right.windowEndsAt?.getTime() ?? Number.MAX_SAFE_INTEGER)
    );
    return ranked[0]?.account ?? null;
  }),
};

const sharesOf = (share: number) => shared.accounts.map((account) => ({ account, share }));

const queued = H.state('queued', 'pending');
const done = H.state('done', 'terminal', 'success');
const abandoned = H.state('abandoned', 'terminal', 'failure');

const workItem = z.object({ title: z.string(), description: z.string() });
const bug = H.kind('Bug').data(workItem).states(queued, done, abandoned);
const feature = H.kind('Feature').data(workItem).states(queued, done, abandoned);

const codingExperience = H.journal('coding-experience', shared.experience, jsonl.memory('coding/.harness/experience.jsonl'));
const worktrees = git.worktree('coding-worktrees', { repo: 'coding', slots: 3 });

const projectChecks = H.command('project-checks').argv(() => ['npm', 'run', 'check']).on(worktrees).recovery('rerun');

const builderRole = H.role('builder')
  .input(z.object({ title: z.string(), description: z.string(), deficits: z.array(z.string()) }))
  .output(z.object({ summary: z.string() }))
  .prompt((input) => `Build: ${input.title}\n${input.description}\nOpen deficits: ${input.deficits.join('; ') || 'none'}`);

const auditorRole = H.role('auditor')
  .input(z.object({ title: z.string(), summary: z.string() }))
  .output(z.object({ deficits: z.array(z.string()) }))
  .prompt((input) => `Audit the change for "${input.title}": ${input.summary}. List every deficit.`);

const builderModel = H.policy.model('cheaper-until-unreliable', [shared.sonnet, shared.opus], (choice) => {
  const cheaper = choice.metrics.successRate({ kind: choice.kind, model: shared.sonnet, days: 14 });
  return cheaper.samples >= 20 && cheaper.value !== null && cheaper.value < 0.85 ? shared.opus : shared.sonnet;
});

const builder = H.seat('builder', builderRole)
  .model(builderModel)
  .on(worktrees)
  .recalls(shared.ownerTaste, codingExperience)
  .guards(claudeCode.fileLeases(), claudeCode.stopCheck(projectChecks));

const auditor = H.seat('auditor', auditorRole).model(shared.opus).on(worktrees).recalls(codingExperience).records(codingExperience);

const buildAndAudit = H.flow('build-and-audit')
  .for(bug, feature)
  .params(z.object({ rounds: z.number() }))
  .does(async (ctx) => {
    let deficits: string[] = [];
    for (let round = 0; round < ctx.params.rounds; round += 1) {
      const built = await ctx.run(builder, { title: ctx.unit.data.title, description: ctx.unit.data.description, deficits });
      if (!built.ok) return ctx.fail(built.error);
      const audit = await ctx.run(auditor, { title: ctx.unit.data.title, summary: built.value.summary });
      if (!audit.ok) return ctx.fail(audit.error);
      if (audit.value.deficits.length === 0) return 'done';
      deficits = audit.value.deficits;
    }
    return 'abandoned';
  });

const trackerStatuses = { queued: 'Todo', done: 'Done', abandoned: 'Canceled' };
const bugTracker = linear.tracker(bug, {
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'product',
  label: 'bug',
  read: (issue) => ({ title: issue.title, description: issue.description }),
  statuses: trackerStatuses,
});
const featureTracker = linear.tracker(feature, {
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'product',
  label: 'feature',
  read: (issue) => ({ title: issue.title, description: issue.description }),
  statuses: trackerStatuses,
});
const bugFolder = folder.files(bug, {
  dir: 'coding/bugs',
  frontmatter: z.object({ title: z.string() }),
  read: (file) => ({ title: file.frontmatter.title, description: file.body }),
});

const bugs = H.lane('bugs', bug)
  .handler(buildAndAudit, { rounds: 3 })
  .retries(2, { exhausted: 'abandoned' })
  .suppliers(bugTracker, bugFolder, H.operator)
  .store(bugTracker)
  .wip(2);

const features = H.lane('features', feature)
  .handler(buildAndAudit, { rounds: 5 })
  .retries(2, { exhausted: 'abandoned' })
  .suppliers(featureTracker, H.operator)
  .store(featureTracker);

const ownerGrants = [
  H.ops.readWork,
  H.ops.writeWork,
  H.ops.resolveHalts,
  H.ops.readMemory,
  H.ops.writeMemory,
  H.ops.readTelemetry,
  H.ops.readAccounts,
  H.ops.setShares,
];

export const coding = H.harness('coding')
  .ledger(sqlite.ledger('coding/.harness/ledger.sqlite'))
  .pools(
    H.pool('coding-accounts', [...sharesOf(0.6), { account: anthropic.account('coding-api', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 }], shared.soonestExpiring)
      .serves(shared.sonnet, shared.opus)
  )
  .lanes(bugs, features)
  .scheduler(H.policy.scheduler('bugs-before-features', (view) => ({ start: view.sorted((unit) => (unit.is(bug) ? 0 : 1)) })))
  .clients(http.control({ port: 7101, token: H.env('CODING_CONTROL_TOKEN'), grants: ownerGrants }))
  .observers(markdown.board('coding/BOARD.md'), markdown.telemetry('coding/TELEMETRY.md'));

const draftPage = H.state('draft', 'pending');
const published = H.state('published', 'terminal', 'success');
const brokenLinks = H.state('broken-links', 'terminal', 'failure');

const docPage = H.kind('DocPage')
  .data(z.object({ path: z.string(), title: z.string(), body: z.string() }))
  .states(draftPage, published, brokenLinks);

const docFiles = folder.files(docPage, {
  dir: 'docs/pages',
  frontmatter: z.object({ title: z.string() }),
  read: (file) => ({ path: file.path, title: file.frontmatter.title, body: file.body }),
  key: (file) => file.path,
});

const docsRunner = shell.local('docs-local', { slots: 2 });
const docsExperience = H.journal('docs-experience', shared.experience, jsonl.memory('docs/.harness/experience.jsonl'));

const writerRole = H.role('writer')
  .input(z.object({ title: z.string(), body: z.string() }))
  .output(z.object({ body: z.string() }))
  .prompt((input) => `Revise the documentation page "${input.title}":\n${input.body}`);

const writer = H.seat('writer', writerRole)
  .model(shared.sonnet)
  .on(docsRunner)
  .recalls(shared.ownerTaste, docsExperience)
  .records(docsExperience);

const linkCheck = H.command('link-check')
  .input(z.object({ path: z.string() }))
  .output(z.object({ broken: z.array(z.string()) }))
  .argv((input) => ['link-check', '--json', input.path])
  .on(docsRunner)
  .recovery('rerun');

const writePage = H.flow('write-page')
  .for(docPage)
  .does(async (ctx) => {
    const written = await ctx.run(writer, { title: ctx.unit.data.title, body: ctx.unit.data.body });
    if (!written.ok) return ctx.fail(written.error);
    await ctx.update({ body: written.value.body });
    const checked = await ctx.run(linkCheck, { path: ctx.unit.data.path });
    if (!checked.ok) return ctx.fail(checked.error);
    if (checked.value.broken.length > 0) return ctx.fail(`broken links: ${checked.value.broken.join(', ')}`);
    return 'published';
  });

const docPages = H.lane('doc-pages', docPage)
  .handler(writePage)
  .retries(2, { exhausted: 'broken-links' })
  .suppliers(docFiles)
  .store(docFiles)
  .wip(2);

export const docs = H.harness('docs')
  .ledger(sqlite.ledger('docs/.harness/ledger.sqlite'))
  .pools(H.pool('docs-accounts', sharesOf(0.3), shared.soonestExpiring).serves(shared.sonnet))
  .lanes(docPages)
  .scheduler(H.policy.scheduler('docs-oldest-first', (view) => ({ start: view.sorted(() => 0) })))
  .clients(http.control({ port: 7102, token: H.env('DOCS_CONTROL_TOKEN'), grants: ownerGrants }))
  .observers(markdown.board('docs/BOARD.md'), markdown.telemetry('docs/TELEMETRY.md'));
