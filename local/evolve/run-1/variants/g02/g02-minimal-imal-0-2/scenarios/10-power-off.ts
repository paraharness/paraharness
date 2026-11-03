import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Runner } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as git from 'harness-dsl/git';
import * as shell from 'harness-dsl/shell';
import * as ssh from 'harness-dsl/ssh';
import * as sqlite from 'harness-dsl/sqlite';
import * as markdown from 'harness-dsl/markdown';

const Platform = z.enum(['linux', 'macos', 'windows']);
type Platform = z.infer<typeof Platform>;

const queued = H.state.pending('queued');
const building = H.state.active('building');
const announcing = H.state.active('announcing');
const reviewing = H.state.active('reviewing');
const awaitingApproval = H.state.active('awaiting-approval');
const summarizing = H.state.active('summarizing');
const awaitingSmoke = H.state.waiting('awaiting-smoke');
const released = H.state.terminal('released', 'success');
const rejected = H.state.terminal('rejected', 'neutral');
const smokeFailed = H.state.terminal('smoke-failed', 'failure');

const Release = H.kind('release')
  .data(z.object({ version: z.string(), channel: z.string(), platforms: z.array(Platform) }))
  .states([queued, building, announcing, reviewing, awaitingApproval, summarizing, awaitingSmoke, released, rejected, smokeFailed], 'queued');

const smokeQueued = H.state.pending('queued');
const smoking = H.state.active('smoking');
const passed = H.state.terminal('passed', 'success');
const failed = H.state.terminal('failed', 'failure');

const Smoke = H.kind('smoke')
  .data(z.object({ release: z.string(), platform: Platform }))
  .states([smokeQueued, smoking, passed, failed], 'queued')
  .onFailure('failed');

const local = shell.local('local', { slots: 2 });
const releaseTree = git.worktree('release-worktree', { repo: '.', slots: 1 });

function smokeHost(name: string, address: string): Runner {
  return ssh.host(name, {
    address,
    user: 'release',
    key: H.env('SMOKE_SSH_KEY'),
    slots: 1,
  });
}

const smokeHosts: Readonly<Record<Platform, Runner>> = {
  linux: smokeHost('smoke-linux', 'smoke-linux.internal'),
  macos: smokeHost('smoke-macos', 'smoke-macos.internal'),
  windows: smokeHost('smoke-windows', 'smoke-windows.internal'),
};

const build = H.command('build')
  .input(z.object({ version: z.string() }))
  .output(z.object({ artifact: z.string() }))
  .argv(input => ['make', 'release', `VERSION=${input.version}`])
  .on(releaseTree)
  .restart('rerun');

const AnnounceInput = z.object({ version: z.string(), channel: z.string() });
const AnnounceOutput = z.object({ messageId: z.string() });

const findAnnouncement = H.command('find-announcement')
  .input(AnnounceInput)
  .output(AnnounceOutput.nullable())
  .argv(input => ['./release/find-announcement', '--channel', input.channel, '--version', input.version])
  .on(local)
  .restart('rerun');

const announce = H.command('announce')
  .input(AnnounceInput)
  .output(AnnounceOutput)
  .argv(input => ['./release/announce', '--channel', input.channel, '--version', input.version])
  .on(local)
  .restart({ check: findAnnouncement });

const releaseReviewerRole = H.role('release-reviewer')
  .input(z.object({ version: z.string(), artifact: z.string() }))
  .output(z.object({ findings: z.array(z.string()) }))
  .prompt(r => `Review release ${r.version} (artifact ${r.artifact}) for regressions and risky changes.`)
  .intents(['read', 'execute']);

const releaseReviewer = H.agent('release-reviewer', releaseReviewerRole)
  .model(claudeCode.model('claude-opus-4-1'))
  .on(releaseTree);

const releaseNotesRole = H.role('release-notes')
  .input(z.object({ version: z.string(), findings: z.array(z.string()), approvalNote: z.string() }))
  .output(z.object({ notes: z.string() }))
  .prompt(r => `Write release notes for ${r.version}.\nReview findings:\n${r.findings.join('\n')}\nRelease manager: ${r.approvalNote}`);

const releaseNotes = H.agent('release-notes', releaseNotesRole).model(anthropic.model('claude-sonnet-4-5'));

const smokeTest = H.command('smoke-test')
  .input(z.object({ release: z.string(), platform: Platform }))
  .output(z.object({ passed: z.boolean(), log: z.string() }))
  .argv(input => ['./release/smoke', '--version', input.release, '--platform', input.platform])
  .on(smokeHosts.linux)
  .restart('rerun');

const runSmoke = H.flow('run-smoke').for(Smoke).does(async ctx => {
  const smoke = ctx.unit.data;
  await ctx.move('smoking');
  const result = await ctx.run(smokeTest, smoke, { on: smokeHosts[smoke.platform] });
  if (!result.ok) return ctx.fail(result.error);
  return result.value.passed ? 'passed' : 'failed';
});

const smoke = H.lane('smoke', Smoke)
  .handler(runSmoke)
  .retry(H.policy.retry('two-tries', view => view.failures >= 2 ? 'stop' : { retryInMs: 30_000 }));

const shipRelease = H.flow('ship-release').for(Release).does(async ctx => {
  const release = ctx.unit.data;

  await ctx.move('building');
  const built = await ctx.run(build, { version: release.version });
  if (!built.ok) return ctx.fail(built.error);

  await ctx.move('announcing');
  const announced = await ctx.run(announce, { version: release.version, channel: release.channel });
  if (!announced.ok) return ctx.fail(announced.error);

  await ctx.move('reviewing');
  const review = await ctx.run(releaseReviewer, { version: release.version, artifact: built.value.artifact });
  if (!review.ok) return ctx.fail(review.error);

  await ctx.move('awaiting-approval');
  const approval = await ctx.halt({
    name: 'release-approval',
    show: `Release ${release.version}\n\n${review.value.findings.join('\n')}`,
    decision: z.object({ approved: z.boolean(), note: z.string() }),
  });
  if (!approval.approved) return 'rejected';

  await ctx.move('summarizing');
  const summaries = await ctx.batch(releaseNotes, [{
    version: release.version,
    findings: review.value.findings,
    approvalNote: approval.note,
  }]);
  const summary = summaries[0];
  if (!summary || !summary.ok) return ctx.fail(summary ? summary.error : 'batch returned no result');

  await ctx.spawn(smoke, release.platforms.map(platform => ({ release: release.version, platform })));
  await ctx.wait('awaiting-smoke', { children: true });
  const smokes = await ctx.children();
  return smokes.every(child => child.verdict === 'success') ? 'released' : 'smoke-failed';
});

const releases = H.lane('releases', Release)
  .handler(shipRelease)
  .suppliers(H.operator)
  .store(sqlite.store(Release, '.harness/releases.db'))
  .wip(1);

const releasePool = H.pool(
  'release-accounts',
  [
    { account: claudeCode.subscription('claude-max', { token: H.env('CLAUDE_MAX_TOKEN') }), share: 1 },
    { account: anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 },
  ],
  H.policy.account('provider-match', choice =>
    choice.accounts.find(view => view.eligible && view.account.provider === choice.model.provider)?.account ?? null),
);

export const releaseHarness = H.harness('release')
  .ledger(sqlite.ledger('.harness/release-ledger.db'))
  .lanes(releases, smoke)
  .pools(releasePool)
  .scheduler(H.policy.scheduler('releases-then-smoke', view => ({
    start: [...view.pending].sort((x, y) => (x.lane === 'releases' ? 0 : 1) - (y.lane === 'releases' ? 0 : 1) || y.waitedMs - x.waitedMs),
  })))
  .clients(claudeCode.supervisor({
    grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.readTelemetry],
  }))
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
