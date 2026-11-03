import { H } from 'harness-dsl';
import { z } from 'zod';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as sqlite from 'harness-dsl/sqlite';
import * as git from 'harness-dsl/git';
import * as shell from 'harness-dsl/shell';
import * as ssh from 'harness-dsl/ssh';
import * as markdown from 'harness-dsl/markdown';

const stalled = H.state('stalled', 'waiting');

const requested = H.state('requested', 'pending');
const releasing = H.state('releasing', 'active');
const awaitingSmoke = H.state('awaiting-smoke', 'waiting');
const verifying = H.state('verifying', 'pending');
const released = H.state('released', 'terminal', 'success');
const smokeFailed = H.state('smoke-failed', 'terminal', 'failure');
const withdrawn = H.state('withdrawn', 'terminal', 'neutral');

const Release = H.kind('Release')
  .data(z.object({ version: z.string(), channel: z.string(), changelog: z.string(), platforms: z.array(z.string()) }))
  .states([requested, releasing, awaitingSmoke, verifying, stalled, released, smokeFailed, withdrawn], { initial: 'requested', afterFailure: 'stalled' });

const queued = H.state('queued', 'pending');
const smoking = H.state('smoking', 'active');
const passed = H.state('passed', 'terminal', 'success');
const broken = H.state('broken', 'terminal', 'failure');

const Smoke = H.kind('Smoke')
  .data(z.object({ version: z.string(), platform: z.string() }))
  .states([queued, smoking, passed, broken], { initial: 'queued', afterFailure: 'broken' });

const buildHost = ssh.host('build-host', {
  address: 'build.internal',
  user: 'release',
  key: H.env('BUILD_SSH_KEY'),
  slots: 1,
  preflight: ['df --output=avail -BG / | tail -1'],
});
const smokeRunner = shell.local('smoke-local', { slots: 4 });
const worktrees = git.worktree('release-worktrees', { repo: '.', slots: 2 });

const releaseInput = z.object({ version: z.string(), channel: z.string() });

const build = H.command('build')
  .input(releaseInput)
  .argv(i => ['make', 'release', `VERSION=${i.version}`])
  .on(buildHost)
  .onCrash('rerun');

const announcementPosted = H.command('announcement-posted')
  .input(releaseInput)
  .output(z.boolean())
  .argv(i => ['release-tools', 'announced', '--channel', i.channel, '--version', i.version])
  .on(buildHost);

const announce = H.command('announce')
  .input(releaseInput)
  .argv(i => ['release-tools', 'announce', '--channel', i.channel, '--version', i.version])
  .on(buildHost)
  .onCrash('park', { happened: announcementPosted });

const reviewerRole = H.role('release-reviewer')
  .input(z.object({ version: z.string(), changelog: z.string() }))
  .output(z.object({ concerns: z.array(z.string()) }))
  .prompt(i => `Review release ${i.version} against its changelog:\n${i.changelog}`)
  .intents(['read', 'execute']);

const summaryRole = H.role('release-summarizer')
  .input(z.object({ version: z.string(), changelog: z.string(), concerns: z.array(z.string()) }))
  .output(z.object({ summary: z.string() }))
  .prompt(i => `Summarise release ${i.version} for users.\n${i.changelog}\nReviewer concerns:\n${i.concerns.join('\n')}`)
  .intents([]);

const reviewer = H.agent('reviewer', reviewerRole).model(claudeCode.model('claude-opus-4-1')).on(worktrees).onCrash('ask');
const summarizer = H.agent('summarizer', summaryRole).model(anthropic.model('claude-haiku-4-5'));

const smokeTest = H.command('smoke-test')
  .input(z.object({ version: z.string(), platform: z.string() }))
  .argv(i => ['smoke', '--platform', i.platform, '--version', i.version])
  .on(smokeRunner)
  .onCrash('rerun');

const runSmoke = H.flow('run-smoke').for(Smoke).does(async ctx => {
  await ctx.move('smoking');
  const result = await ctx.run(smokeTest, ctx.unit.data);
  if (!result.ok) return ctx.fail(result.error);
  return 'passed';
});

const smoke = H.lane('smoke', Smoke).handler(runSmoke).store(sqlite.store(Smoke, '.harness/work.db')).wip(4);

const shipRelease = H.flow('ship-release').for(Release).does(async ctx => {
  const release = ctx.unit.data;
  if (ctx.unit.state === 'verifying') {
    const children = await ctx.children();
    return children.every(child => child.verdict === 'success') ? 'released' : 'smoke-failed';
  }
  await ctx.move('releasing');
  const target = { version: release.version, channel: release.channel };

  const built = await ctx.run(build, target);
  if (!built.ok) return ctx.fail(built.error);

  const announced = await ctx.run(announce, target);
  if (!announced.ok) return ctx.fail(announced.error);

  const review = await ctx.run(reviewer, { version: release.version, changelog: release.changelog });
  if (!review.ok) return ctx.fail(review.error);

  const approval = await ctx.halt({
    name: 'approval',
    show: `Release ${release.version}. Reviewer concerns:\n${review.value.concerns.join('\n') || 'none'}`,
    decision: z.object({ approved: z.boolean(), note: z.string() }),
  });
  if (!approval.approved) return 'withdrawn';

  const summaries = await ctx.batch(summarizer, [{ version: release.version, changelog: release.changelog, concerns: review.value.concerns }]);
  for (const summary of summaries) {
    if (!summary.ok) return ctx.fail(summary.error);
  }
  await ctx.update({ changelog: summaries.map(s => (s.ok ? s.value.summary : '')).join('\n') });

  await ctx.spawn(smoke, release.platforms.map(platform => ({ version: release.version, platform })));
  return ctx.until('awaiting-smoke', { children: true, then: 'verifying' });
});

const releases = H.lane('releases', Release).handler(shipRelease).suppliers(H.operator).store(sqlite.store(Release, '.harness/work.db')).wip(1);

const subscription = claudeCode.subscription('claude-max', { token: H.env('CLAUDE_TOKEN') });
const api = anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const pool = H.pool('release-accounts', [{ account: subscription, share: 1 }, { account: api, share: 1 }],
  H.policy.account('provider-match', c => c.accounts.find(a => a.eligible && a.account.provider === c.model.provider)?.account ?? null));

const releasesFirst = H.policy.scheduler('releases-first', v => ({
  start: [...v.pending].sort((a, b) => (a.kind === 'Release' ? 0 : 1) - (b.kind === 'Release' ? 0 : 1) || b.waitedMs - a.waitedMs),
}));

export const releaseHarness = H.harness('release')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(releases, smoke)
  .pools(pool)
  .scheduler(releasesFirst)
  .clients(claudeCode.supervisor({ grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.readTelemetry] }))
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
