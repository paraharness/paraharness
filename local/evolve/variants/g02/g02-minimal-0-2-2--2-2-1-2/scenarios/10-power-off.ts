import { H } from 'harness-dsl';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as shell from 'harness-dsl/shell';
import * as git from 'harness-dsl/git';
import * as markdown from 'harness-dsl/markdown';
import { z } from 'zod';

const local = shell.local('local', { slots: 4 });
const buildTree = git.worktree('release-worktrees', { repo: '.', slots: 2 });

const subscription = claudeCode.subscription('max-1', { token: H.env('CLAUDE_MAX_1_TOKEN') });
const apiAccount = anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const opus = claudeCode.model('claude-opus');
const batchModel = anthropic.model('claude-haiku');
const releasePool = H.pool('release-accounts', [
  { account: subscription, share: 1 },
  { account: apiAccount, share: 1 },
]);

const platform = z.enum(['linux', 'macos', 'windows']);

const requested = H.state('requested', 'pending');
const smoking = H.state('smoking', 'waiting');
const released = H.state('released', 'terminal', 'success');
const rejected = H.state('rejected', 'terminal', 'failure');
const smokeBroken = H.state('smoke-broken', 'terminal', 'failure');
const releaseFailed = H.state('release-failed', 'terminal', 'failure');
const release = H.kind('Release')
  .data(z.object({ version: z.string(), commit: z.string(), channel: z.string(), summary: z.string().optional() }))
  .states(requested, smoking, released, rejected, smokeBroken, releaseFailed);

const queued = H.state('queued', 'pending');
const passed = H.state('passed', 'terminal', 'success');
const broken = H.state('broken', 'terminal', 'failure');
const smoke = H.kind('Smoke').data(z.object({ version: z.string(), platform })).states(queued, passed, broken);

const build = H.command('build')
  .input(z.object({ commit: z.string() }))
  .argv(input => ['make', 'release', `COMMIT=${input.commit}`])
  .on(buildTree)
  .recovery('rerun');

const announcement = z.object({ version: z.string(), channel: z.string() });

const announcementPosted = H.command('announcement-posted')
  .input(announcement)
  .output(z.boolean())
  .argv(input => ['bin/find-post', input.channel, input.version])
  .on(local);

const announce = H.command('announce')
  .input(announcement)
  .argv(input => ['bin/post', input.channel, `Release ${input.version} is rolling out`])
  .on(local)
  .recovery(announcementPosted);

const reviewRole = H.role('review-release')
  .input(z.object({ version: z.string(), commit: z.string() }))
  .output(z.object({ approve: z.boolean(), notes: z.string() }))
  .prompt(input => `Review release ${input.version} at commit ${input.commit}.`)
  .intents(['read', 'execute']);

const summarizeRole = H.role('summarize-release')
  .input(z.object({ version: z.string(), notes: z.string() }))
  .output(z.object({ summary: z.string() }))
  .prompt(input => `Write release notes for ${input.version} from these review notes:\n${input.notes}`);

const reviewer = H.seat('release-reviewer', reviewRole).model(opus).on(buildTree);
const summarizer = H.seat('release-summarizer', summarizeRole).model(batchModel);

const releaseApproval = H.halt('release-approval', z.object({ approved: z.boolean() }));

const runSmoke = H.command('run-smoke')
  .input(z.object({ version: z.string(), platform }))
  .argv(input => ['bin/smoke', input.platform, input.version])
  .on(local)
  .recovery('rerun');

const smokeTest = H.flow('smoke-test').for(smoke).does(async ctx => {
  const result = await ctx.run(runSmoke, { version: ctx.unit.data.version, platform: ctx.unit.data.platform });
  return result.ok ? 'passed' : 'broken';
});

const smokeLane = H.lane('smoke', smoke)
  .handler(smokeTest, { retries: 1, exhausted: 'broken' })
  .store(sqlite.store(smoke, '.harness/smoke.sqlite'))
  .wip(3);

const shipRelease = H.flow('ship-release').for(release).does(async ctx => {
  const { version, commit, channel } = ctx.unit.data;
  const built = await ctx.run(build, { commit });
  if (!built.ok) return ctx.fail(built.error);
  const announced = await ctx.run(announce, { version, channel });
  if (!announced.ok) return ctx.fail(announced.error);
  const review = await ctx.run(reviewer, { version, commit });
  if (!review.ok) return ctx.fail(review.error);
  if (!review.value.approve) return 'rejected';
  const approved = await ctx.halt(releaseApproval, `Release ${version}: ${review.value.notes}`);
  if (!approved.approved) return 'rejected';
  const summaries = await ctx.batch(summarizer, [{ version, notes: review.value.notes }]);
  const summary = summaries[0];
  if (summary === undefined) return ctx.fail('summary batch returned nothing');
  if (!summary.ok) return ctx.fail(summary.error);
  await ctx.update({ summary: summary.value.summary });
  const children = await ctx.spawn(smokeLane, platform.options.map(target => ({ version, platform: target })));
  const results = await ctx.suspend('smoking', { children });
  return results.every(child => child.state === 'passed') ? 'released' : 'smoke-broken';
});

const releaseLane = H.lane('releases', release)
  .handler(shipRelease, { retries: 1, exhausted: 'release-failed' })
  .suppliers(H.operator)
  .store(sqlite.store(release, '.harness/releases.sqlite'))
  .wip(1);

const releaseManager = claudeCode.supervisor({
  grants: [
    H.ops.readWork,
    H.ops.writeWork,
    H.ops.resolve(releaseApproval, H.halts.interrupted, H.halts.definitionChanged),
    H.ops.readTelemetry,
  ],
});

export const releases = H.harness('releases')
  .ledger(sqlite.ledger('.harness/ledger.sqlite'))
  .lanes(releaseLane, smokeLane)
  .pools(releasePool)
  .clients(releaseManager)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
