import { z } from 'zod';
import { H } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claude from 'harness-dsl/claude-code';
import * as sqlite from 'harness-dsl/sqlite';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const local = shell.local('local', { slots: 4 });
const sonnet = anthropic.model('claude-sonnet-4-5');
const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const firstEligible = H.policy.account('first-eligible', choice => choice.accounts.find(a => a.eligible)?.account ?? null);

const queued = H.state('queued', 'pending');
const running = H.state('running', 'active');
const passed = H.state('passed', 'terminal', 'success');
const smokeFailed = H.state('failed', 'terminal', 'failure');
const skipped = H.state('skipped', 'terminal', 'neutral');

const Smoke = H.kind('Smoke')
  .data(z.object({ version: z.string(), platform: z.string() }))
  .states([queued, running, passed, smokeFailed, skipped], { initial: 'queued', afterFailure: 'failed', afterCancel: 'skipped' });

const smokeTest = H.command('smoke-test')
  .input(z.object({ version: z.string(), platform: z.string() }))
  .argv(s => ['smoke', '--version', s.version, '--platform', s.platform])
  .on(local)
  .restart('rerun');

const runSmoke = H.flow('run-smoke').for(Smoke).does(async ctx => {
  await ctx.move('running');
  const result = await ctx.run(smokeTest, ctx.unit.data);
  return result.ok ? 'passed' : ctx.fail(result.error);
});

const smokeLane = H.lane('smoke', Smoke).handler(runSmoke).store(sqlite.store(Smoke, 'release.db'));

const requested = H.state('requested', 'pending');
const releasing = H.state('releasing', 'active');
const awaitingSmoke = H.state('awaiting-smoke', 'waiting');
const smokeDone = H.state('smoke-done', 'pending');
const released = H.state('released', 'terminal', 'success');
const smokeRejected = H.state('smoke-failed', 'terminal', 'failure');
const releaseFailed = H.state('release-failed', 'terminal', 'failure');
const rejected = H.state('rejected', 'terminal', 'neutral');
const abandoned = H.state('abandoned', 'terminal', 'neutral');

const Release = H.kind('Release')
  .data(z.object({ version: z.string(), channel: z.string(), platforms: z.array(z.string()) }))
  .states([requested, releasing, awaitingSmoke, smokeDone, released, smokeRejected, releaseFailed, rejected, abandoned], {
    initial: 'requested',
    afterFailure: 'release-failed',
    afterCancel: 'abandoned',
  });

const build = H.command('build')
  .input(z.object({ version: z.string() }))
  .argv(r => ['make', 'release', `VERSION=${r.version}`])
  .on(local)
  .restart('rerun');

const announcement = z.object({ version: z.string(), channel: z.string() });
const postedMessage = z.object({ messageId: z.string() });

const findAnnouncement = H.command('find-announcement')
  .input(announcement)
  .output(postedMessage.nullable())
  .argv(a => ['chat-search', '--channel', a.channel, '--text', `Release ${a.version}`])
  .on(local)
  .restart('rerun');

const announce = H.command('announce')
  .input(announcement)
  .output(postedMessage)
  .argv(a => ['chat-post', '--channel', a.channel, '--text', `Release ${a.version}`])
  .on(local)
  .restart({ verify: findAnnouncement });

const reviewerRole = H.role('release-reviewer')
  .input(z.object({ version: z.string(), buildLog: z.string() }))
  .output(z.object({ approve: z.boolean(), concerns: z.array(z.string()) }))
  .prompt(r => `Review release ${r.version}. Build log:\n${r.buildLog}`)
  .intents(['read']);

const summarizerRole = H.role('release-summarizer')
  .input(z.object({ version: z.string(), concerns: z.array(z.string()), approvalNote: z.string() }))
  .output(z.object({ summary: z.string() }))
  .prompt(s => `Summarise release ${s.version}. Reviewer concerns: ${s.concerns.join('; ')}. Approval note: ${s.approvalNote}`);

const reviewer = H.agent('release-reviewer', reviewerRole).model(sonnet);
const summarizer = H.agent('release-summarizer', summarizerRole).model(sonnet);

const shipRelease = H.flow('ship-release').for(Release).does(async ctx => {
  const release = ctx.unit.data;
  if (ctx.unit.state === 'smoke-done') {
    const smokes = await ctx.children();
    return smokes.every(s => s.verdict === 'success') ? 'released' : 'smoke-failed';
  }
  await ctx.move('releasing');
  const built = await ctx.run(build, { version: release.version });
  if (!built.ok) return ctx.fail(built.error);
  const posted = await ctx.run(announce, { version: release.version, channel: release.channel });
  if (!posted.ok) return ctx.fail(posted.error);
  const review = await ctx.run(reviewer, { version: release.version, buildLog: built.value });
  if (!review.ok) return ctx.fail(review.error);
  const approval = await ctx.halt({
    name: 'release-approval',
    show: `Release ${release.version}: reviewer ${review.value.approve ? 'approves' : 'objects'}. ${review.value.concerns.join('; ')}`,
    decision: z.object({ approved: z.boolean(), note: z.string() }),
  });
  if (!approval.approved) return 'rejected';
  const summaries = await ctx.batch(summarizer, [{ version: release.version, concerns: review.value.concerns, approvalNote: approval.note }]);
  const summary = summaries[0];
  if (!summary || !summary.ok) return ctx.fail('release summary batch failed');
  await ctx.update({ channel: release.channel });
  await ctx.spawn(smokeLane, release.platforms.map(platform => ({ version: release.version, platform })));
  return ctx.until('awaiting-smoke', { children: true, then: 'smoke-done' });
});

const releaseLane = H.lane('releases', Release)
  .handler(shipRelease)
  .suppliers(H.operator)
  .store(sqlite.store(Release, 'release.db'))
  .wip(1);

export const releases = H.harness('releases')
  .ledger(sqlite.ledger('release.db'))
  .lanes(releaseLane, smokeLane)
  .pools(H.pool('api', [{ account: apiAccount, share: 1 }], firstEligible))
  .scheduler(H.policy.scheduler('releases-then-smoke', view => ({
    start: [...view.pending].sort((a, b) => (a.lane === 'releases' ? 0 : 1) - (b.lane === 'releases' ? 0 : 1) || b.waitedMs - a.waitedMs),
  })))
  .clients(claude.supervisor({
    grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.recoverAttempts, H.ops.readTelemetry],
  }))
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
