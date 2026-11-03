import { z } from 'zod';
import { H } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as sqlite from 'harness-dsl/sqlite';
import * as shell from 'harness-dsl/shell';
import * as git from 'harness-dsl/git';
import * as markdown from 'harness-dsl/markdown';

const requested = H.state('requested', 'pending');
const releasing = H.state('releasing', 'active');
const awaitingSmoke = H.state('awaiting-smoke', 'waiting');
const smoked = H.state('smoked', 'pending');
const released = H.state('released', 'terminal', 'success');
const smokeFailed = H.state('smoke-failed', 'terminal', 'failure');
const rejected = H.state('rejected', 'terminal', 'neutral');

const Release = H.kind('Release')
  .data(z.object({
    version: z.string(),
    channel: z.string(),
    platforms: z.array(z.string()),
    notes: z.string().optional(),
  }))
  .states(requested, releasing, awaitingSmoke, smoked, released, smokeFailed, rejected);

const queued = H.state('queued', 'pending');
const testing = H.state('testing', 'active');
const passed = H.state('passed', 'terminal', 'success');
const failed = H.state('failed', 'terminal', 'failure');

const Smoke = H.kind('Smoke')
  .data(z.object({ release: z.string(), platform: z.string() }))
  .states(queued, testing, passed, failed);

const local = shell.local('release-host', { slots: 4 });
const checkout = git.worktree('release-checkout', { repo: '.', slots: 2 });

const build = H.command('build')
  .input(z.object({ version: z.string() }))
  .argv(r => ['make', 'release', `VERSION=${r.version}`])
  .on(local)
  .recovery('rerun');

const announcement = z.object({ version: z.string(), channel: z.string() });

const announcementPosted = H.command('announcement-posted')
  .input(announcement)
  .output(z.boolean())
  .argv(a => ['release-tools', 'announced', '--channel', a.channel, '--version', a.version])
  .on(local)
  .recovery('rerun');

const announce = H.command('announce')
  .input(announcement)
  .argv(a => ['release-tools', 'announce', '--channel', a.channel, '--version', a.version])
  .on(local)
  .recovery(announcementPosted);

const releaseReview = H.role('release-review')
  .input(z.object({ version: z.string(), buildLog: z.string() }))
  .output(z.object({ findings: z.string() }))
  .prompt(r => `Review release ${r.version}. Build log:\n${r.buildLog}`)
  .intents(['read', 'execute']);
const reviewer = H.agent('release-reviewer', releaseReview).model(claudeCode.model('claude-opus-4-1')).on(checkout);

const releaseNotes = H.role('release-notes')
  .input(z.object({ version: z.string(), findings: z.string() }))
  .output(z.object({ notes: z.string() }))
  .prompt(r => `Write release notes for ${r.version} from these review findings:\n${r.findings}`);
const summarizer = H.agent('release-summarizer', releaseNotes).model(anthropic.model('claude-haiku-4-5'));

const smokeTest = H.command('smoke-test')
  .input(z.object({ release: z.string(), platform: z.string() }))
  .argv(s => ['release-tools', 'smoke', '--platform', s.platform, '--version', s.release])
  .on(local)
  .recovery('rerun');

const smokeFlow = H.flow('smoke').for(Smoke).does(async ctx => {
  const tested = await ctx.run(smokeTest, { release: ctx.unit.data.release, platform: ctx.unit.data.platform });
  return tested.ok ? 'passed' : 'failed';
});
const smoke = H.lane('smoke', Smoke).handler(smokeFlow).wip(4);

const releaseFlow = H.flow('release').for(Release).does(async ctx => {
  const release = ctx.unit.data;
  if (ctx.unit.state === 'smoked') {
    const children = await ctx.children();
    return children.every(c => c.state === 'passed') ? 'released' : 'smoke-failed';
  }

  const built = await ctx.run(build, { version: release.version });
  if (!built.ok) return ctx.fail(built.error);

  const announced = await ctx.run(announce, { version: release.version, channel: release.channel });
  if (!announced.ok) return ctx.fail(announced.error);

  const review = await ctx.run(reviewer, { version: release.version, buildLog: built.value });
  if (!review.ok) return ctx.fail(review.error);

  const approval = await ctx.halt({
    name: 'release-approval',
    show: review.value.findings,
    decision: z.object({ approved: z.boolean(), note: z.string().optional() }),
  });
  if (!approval.approved) return 'rejected';

  const [summary] = await ctx.batch(summarizer, [{ version: release.version, findings: review.value.findings }]);
  if (!summary || !summary.ok) return ctx.fail('release notes batch produced no summary');
  await ctx.update({ notes: summary.value.notes });

  await ctx.spawn(smoke, release.platforms.map(platform => ({ release: release.version, platform })));
  return ctx.until('awaiting-smoke', { children: true, then: 'smoked' });
});

const releases = H.lane('releases', Release).handler(releaseFlow).suppliers(H.operator).wip(1);

const releaseAccounts = H.pool('release', [
  { account: claudeCode.subscription('release-max', { token: H.env('CLAUDE_TOKEN') }), share: 1 },
  { account: anthropic.account('release-api', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 },
]);

const releaseOrder = H.policy.scheduler('releases-then-smoke', view => ({
  start: [...view.pending].sort((x, y) => (x.kind === Release.name ? 0 : 1) - (y.kind === Release.name ? 0 : 1) || y.waitedMs - x.waitedMs),
}));

const releaseManager = claudeCode.supervisor({
  grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.readTelemetry],
});

export const running = H.harness('release')
  .ledger(sqlite.ledger('release/ledger.db'))
  .lanes(releases, smoke)
  .pools(releaseAccounts)
  .scheduler(releaseOrder)
  .clients(releaseManager)
  .observers(markdown.board('release/BOARD.md'))
  .start();
