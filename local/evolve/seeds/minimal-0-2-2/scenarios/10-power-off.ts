import { z } from 'zod';
import { H } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as sqlite from 'harness-dsl/sqlite';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const platform = z.enum(['linux', 'macos', 'windows']);

const requested = H.state('requested', 'pending');
const building = H.state('building', 'active');
const inReview = H.state('in-review', 'active');
const awaitingSmoke = H.state('awaiting-smoke', 'waiting');
const released = H.state('released', 'terminal', 'success');
const rejected = H.state('rejected', 'terminal', 'neutral');
const smokeFailed = H.state('smoke-failed', 'terminal', 'failure');

const Release = H.kind('Release')
  .data(z.object({
    version: z.string(),
    channel: z.string(),
    platforms: z.array(platform),
    notes: z.string().optional(),
  }))
  .states(requested, building, inReview, awaitingSmoke, released, rejected, smokeFailed);

const smokeQueued = H.state('smoke-queued', 'pending');
const smoking = H.state('smoking', 'active');
const smokePassed = H.state('smoke-passed', 'terminal', 'success');
const smokeBroken = H.state('smoke-broken', 'terminal', 'failure');

const Smoke = H.kind('Smoke')
  .data(z.object({ version: z.string(), platform }))
  .states(smokeQueued, smoking, smokePassed, smokeBroken);

const releaseBox = shell.local('release-box', { slots: 3 });

const build = H.command('build')
  .input(z.object({ version: z.string() }))
  .argv((release) => ['make', 'release', `VERSION=${release.version}`])
  .on(releaseBox)
  .recovery('rerun');

const announcement = z.object({ version: z.string(), channel: z.string() });

const announcementPosted = H.command('announcement-posted')
  .input(announcement)
  .output(z.boolean())
  .argv((post) => ['chat-history', '--channel', post.channel, '--contains', `Release ${post.version}`, '--json'])
  .on(releaseBox);

const announce = H.command('announce')
  .input(announcement)
  .argv((post) => ['chat-post', '--channel', post.channel, '--text', `Release ${post.version} is being prepared`])
  .on(releaseBox)
  .recovery(announcementPosted);

const smokeTest = H.command('smoke-test')
  .input(z.object({ version: z.string(), platform }))
  .argv((target) => ['smoke', '--version', target.version, '--platform', target.platform])
  .on(releaseBox)
  .recovery('rerun');

const reviewRole = H.role('release-reviewer')
  .input(z.object({ version: z.string(), buildLog: z.string() }))
  .output(z.object({ verdict: z.string(), concerns: z.array(z.string()) }))
  .prompt((release) => `Review release ${release.version}. Build log:\n${release.buildLog}`)
  .intents(['read', 'execute']);

const summaryRole = H.role('release-summarizer')
  .input(z.object({ version: z.string(), review: z.string() }))
  .output(z.object({ notes: z.string() }))
  .prompt((release) => `Write release notes for ${release.version} from this review:\n${release.review}`)
  .intents(['read']);

const reviewer = H.agent('release-reviewer', reviewRole).model(claudeCode.model('claude-opus-4-1')).on(releaseBox);
const summarizer = H.agent('release-summarizer', summaryRole).model(anthropic.model('claude-sonnet-4-5'));

const releaseApproval = H.halt('release-approval', z.object({ approved: z.boolean(), note: z.string() }));

const runSmoke = H.flow('run-smoke').for(Smoke).does(async (ctx) => {
  await ctx.move('smoking');
  const result = await ctx.run(smokeTest, ctx.unit.data);
  return result.ok ? 'smoke-passed' : 'smoke-broken';
});

const smoke = H.lane('smoke', Smoke).handler(runSmoke);

const shipRelease = H.flow('ship-release').for(Release).does(async (ctx) => {
  const { version, channel, platforms } = ctx.unit.data;
  await ctx.move('building');
  const built = await ctx.run(build, { version });
  if (built.ok === false) return ctx.fail(built.error);
  const announced = await ctx.run(announce, { version, channel });
  if (announced.ok === false) return ctx.fail(announced.error);
  await ctx.move('in-review');
  const review = await ctx.run(reviewer, { version, buildLog: built.value });
  if (review.ok === false) return ctx.fail(review.error);
  const approval = await ctx.halt(releaseApproval, `${review.value.verdict}\n${review.value.concerns.join('\n')}`);
  if (approval.approved === false) return 'rejected';
  const summaries = await ctx.batch(summarizer, [{ version, review: review.value.verdict }]);
  for (const summary of summaries) {
    if (summary.ok === false) return ctx.fail(summary.error);
    await ctx.update({ notes: summary.value.notes });
  }
  const children = await ctx.spawn(smoke, platforms.map((target) => ({ version, platform: target })));
  const finished = await ctx.wait('awaiting-smoke', { children });
  return finished.every((child) => child.state === 'smoke-passed') ? 'released' : 'smoke-failed';
});

const releases = H.lane('releases', Release).handler(shipRelease).suppliers(H.operator);

const subscription = claudeCode.subscription('release-subscription', { token: H.env('CLAUDE_TOKEN') });
const api = anthropic.account('release-api', { apiKey: H.env('ANTHROPIC_API_KEY') });

export const releaseHarness = H.harness('release')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(releases, smoke)
  .pools(H.pool('release-accounts', [{ account: subscription, share: 1 }, { account: api, share: 1 }]))
  .scheduler(H.policy.scheduler('oldest-first', ({ pending }) => ({
    start: [...pending].sort((a, b) => b.waitedMs - a.waitedMs),
  })))
  .clients(claudeCode.supervisor({
    grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.readTelemetry],
  }))
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
