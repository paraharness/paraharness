import { z } from 'zod';
import { H } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as shell from 'harness-dsl/shell';
import * as ssh from 'harness-dsl/ssh';
import * as sqlite from 'harness-dsl/sqlite';
import * as markdown from 'harness-dsl/markdown';

const platformSchema = z.enum(['linux', 'macos', 'windows']);

const requested = H.state('requested', 'pending');
const verifying = H.state('verifying', 'pending');
const awaitingSmoke = H.state('awaiting-smoke', 'waiting');
const released = H.state('released', { terminal: 'success' });
const rejected = H.state('rejected', { terminal: 'neutral' });
const releaseFailed = H.state('release-failed', { terminal: 'failure' });

const Release = H.kind('release')
  .data(z.object({
    version: z.string(),
    commit: z.string(),
    channel: z.string(),
    platforms: z.array(platformSchema),
    notes: z.string(),
  }))
  .states([requested, verifying, awaitingSmoke, released, rejected, releaseFailed], 'requested')
  .failsTo('release-failed');

const smokeQueued = H.state('smoke-queued', 'pending');
const smokePassed = H.state('smoke-passed', { terminal: 'success' });
const smokeBroken = H.state('smoke-broken', { terminal: 'failure' });

const Smoke = H.kind('smoke')
  .data(z.object({ version: z.string(), platform: platformSchema }))
  .states([smokeQueued, smokePassed, smokeBroken], 'smoke-queued')
  .failsTo('smoke-broken');

const buildBox = shell.local('build-box', { slots: 2 });
const smokeKey = H.env('SMOKE_SSH_KEY');
const smokeHosts = {
  linux: ssh.host('smoke-linux', { address: 'smoke-linux.internal', user: 'ci', key: smokeKey, slots: 1 }),
  macos: ssh.host('smoke-macos', { address: 'smoke-macos.internal', user: 'ci', key: smokeKey, slots: 1 }),
  windows: ssh.host('smoke-windows', { address: 'smoke-windows.internal', user: 'ci', key: smokeKey, slots: 1 }),
};

const build = H.command('build')
  .input(z.object({ commit: z.string(), version: z.string() }))
  .output(z.object({ artifact: z.string() }))
  .argv(input => ['make', 'release', `COMMIT=${input.commit}`, `VERSION=${input.version}`])
  .on(buildBox)
  .restart('rerun');

const announcementPosted = H.command('announcement-posted')
  .input(z.object({ channel: z.string(), version: z.string() }))
  .output(z.boolean())
  .argv(input => ['announce', '--check', input.channel, input.version])
  .on(buildBox)
  .restart('rerun');

const announce = H.command('announce')
  .input(z.object({ channel: z.string(), version: z.string() }))
  .argv(input => ['announce', input.channel, input.version])
  .on(buildBox)
  .restart(announcementPosted);

const reviewRole = H.role('release-reviewer')
  .input(z.object({ version: z.string(), commit: z.string(), artifact: z.string() }))
  .output(z.object({ ship: z.boolean(), findings: z.array(z.string()) }))
  .prompt(r => `Review release ${r.version} (commit ${r.commit}, artifact ${r.artifact}) and list findings.`)
  .intents(['read', 'execute']);

const reviewer = H.agent('release-reviewer', reviewRole).model(claudeCode.model('claude-opus-4-1')).on(buildBox);

const summaryRole = H.role('release-summarizer')
  .input(z.object({ version: z.string(), findings: z.array(z.string()), approvalNote: z.string() }))
  .output(z.object({ notes: z.string() }))
  .prompt(r => `Write release notes for ${r.version}.\n\nReview findings:\n${r.findings.join('\n')}\n\nRelease manager: ${r.approvalNote}`);

const summarizer = H.agent('release-summarizer', summaryRole).model(anthropic.model('claude-haiku-4-5'));

const smokeTest = H.command('smoke-test')
  .input(z.object({ version: z.string(), platform: platformSchema }))
  .argv(input => ['smoke', '--version', input.version])
  .on(input => smokeHosts[input.platform])
  .restart('rerun');

const runSmoke = H.flow('run-smoke').for(Smoke).does(async ctx => {
  const smoke = await ctx.run(smokeTest, ctx.unit.data);
  if (smoke.ok === false) return ctx.fail(smoke.error);
  return 'smoke-passed';
});

const smoke = H.lane('smoke', Smoke).handler(runSmoke).store(sqlite.store(Smoke, 'release-store.db'));

const shipRelease = H.flow('ship-release').for(Release).does(async ctx => {
  const release = ctx.unit.data;

  if (ctx.unit.state === 'verifying') {
    const smokes = await ctx.children();
    const broken = smokes.filter(child => child.verdict === 'failure');
    return broken.length === 0 ? 'released' : 'release-failed';
  }

  const built = await ctx.run(build, { commit: release.commit, version: release.version });
  if (built.ok === false) return ctx.fail(built.error);

  const announced = await ctx.run(announce, { channel: release.channel, version: release.version });
  if (announced.ok === false) return ctx.fail(announced.error);

  const review = await ctx.run(reviewer, { version: release.version, commit: release.commit, artifact: built.value.artifact });
  if (review.ok === false) return ctx.fail(review.error);

  const approval = await ctx.halt({
    name: 'release-approval',
    show: `${release.version}: reviewer says ship=${review.value.ship}\n${review.value.findings.join('\n')}`,
    decision: z.object({ approved: z.boolean(), note: z.string() }),
  });
  if (approval.approved === false) return 'rejected';

  const [summary] = await ctx.batch(summarizer, [
    { version: release.version, findings: review.value.findings, approvalNote: approval.note },
  ]);
  if (summary === undefined || summary.ok === false) return ctx.fail('release notes batch produced no result');
  await ctx.update({ notes: summary.value.notes });

  await ctx.spawn(smoke, release.platforms.map(platform => ({ version: release.version, platform })));
  return ctx.until('awaiting-smoke', { children: true, then: 'verifying' });
});

const releases = H.lane('releases', Release)
  .handler(shipRelease)
  .suppliers(H.operator)
  .store(sqlite.store(Release, 'release-store.db'))
  .wip(1);

const releaseSubscription = claudeCode.subscription('release-max', { token: H.env('CLAUDE_MAX_TOKEN') });
const releaseApi = anthropic.account('release-api', { apiKey: H.env('ANTHROPIC_API_KEY') });

const subscriptionThenApi = H.policy.account('subscription-then-api', choice => {
  const usable = choice.accounts.filter(view => view.eligible);
  const [first] = [
    ...usable.filter(view => view.account.plan === 'subscription'),
    ...usable.filter(view => view.account.plan === 'metered'),
  ];
  return first ? first.account : null;
});

const smokeAfterRelease = H.policy.scheduler('releases-then-smoke', view => ({
  start: [...view.pending].sort((x, y) => (x.is(Release) ? 0 : 1) - (y.is(Release) ? 0 : 1) || y.waitedMs - x.waitedMs),
}));

export const releaseHarness = H.harness('release')
  .ledger(sqlite.ledger('release-ledger.db'))
  .lanes(releases, smoke)
  .pools(H.pool('release-accounts', [
    { account: releaseSubscription, share: 1 },
    { account: releaseApi, share: 1 },
  ], subscriptionThenApi))
  .scheduler(smokeAfterRelease)
  .clients(claudeCode.supervisor({ grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.readTelemetry] }))
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
