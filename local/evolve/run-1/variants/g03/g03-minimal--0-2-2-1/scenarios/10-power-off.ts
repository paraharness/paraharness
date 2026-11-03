import { z } from 'zod';
import { H } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as shell from 'harness-dsl/shell';
import * as git from 'harness-dsl/git';
import * as claudeCode from 'harness-dsl/claude-code';
import * as markdown from 'harness-dsl/markdown';

const releaseData = z.object({
  version: z.string(),
  channel: z.string(),
  platforms: z.array(z.string()),
  releaseNotes: z.string(),
});

const releaseQueued = H.state('release-queued', 'pending');
const releaseRunning = H.state('release-running', 'active');
const releaseAwaitingSmoke = H.state('release-awaiting-smoke', 'waiting');
const releaseShipped = H.state('release-shipped', 'terminal', 'success');
const releaseRejected = H.state('release-rejected', 'terminal', 'neutral');
const releaseFailed = H.state('release-failed', 'terminal', 'failure');

const release = H.kind('release')
  .data(releaseData)
  .states(releaseQueued, releaseRunning, releaseAwaitingSmoke, releaseShipped, releaseRejected, releaseFailed)
  .failsTo('release-failed');

const smokeData = z.object({ version: z.string(), platform: z.string() });

const smokeQueued = H.state('smoke-queued', 'pending');
const smokeRunning = H.state('smoke-running', 'active');
const smokePassed = H.state('smoke-passed', 'terminal', 'success');
const smokeFailed = H.state('smoke-failed', 'terminal', 'failure');

const smoke = H.kind('smoke')
  .data(smokeData)
  .states(smokeQueued, smokeRunning, smokePassed, smokeFailed)
  .failsTo('smoke-failed');

const local = shell.local('local', { slots: 4 });
const releaseRepo = git.worktree('release-repo', { repo: '.', slots: 1 });

const build = H.command('build')
  .input(releaseData)
  .argv((r) => ['make', 'release', `VERSION=${r.version}`])
  .on(local)
  .recovery('rerun');

const announcement = z.object({ version: z.string(), channel: z.string() });

const announcementLanded = H.command('announcement-landed')
  .input(announcement)
  .output(z.boolean())
  .argv((a) => ['chat', 'find-post', '--channel', a.channel, '--contains', `Release ${a.version}`, '--json'])
  .on(local);

const announce = H.command('announce')
  .input(announcement)
  .argv((a) => ['chat', 'post', '--channel', a.channel, '--text', `Release ${a.version} is rolling out`])
  .on(local)
  .recovery(announcementLanded);

const reviewerRole = H.role('release-reviewer')
  .input(z.object({ version: z.string() }))
  .output(z.object({ verdict: z.enum(['ship', 'hold']), notes: z.string() }))
  .prompt((r) => `Review the changes going into release ${r.version}. Say ship or hold, with notes.`)
  .intents(['read', 'execute']);

const summarizerRole = H.role('release-summarizer')
  .input(z.object({ version: z.string(), notes: z.string() }))
  .output(z.object({ summary: z.string() }))
  .prompt((r) => `Write public release notes for ${r.version} from these review notes:\n\n${r.notes}`);

const sonnet = anthropic.model('claude-sonnet-4-5');
const haiku = anthropic.model('claude-haiku-4-5');

const releaseReviewer = H.agent('release-reviewer', reviewerRole).model(sonnet).on(releaseRepo);
const summarizer = H.agent('release-summarizer', summarizerRole).model(haiku);

const releaseApproval = H.halt('release-approval', z.object({
  action: z.enum(['approve', 'reject']),
  note: z.string(),
}));

const smokeTest = H.command('smoke-test')
  .input(smokeData)
  .argv((s) => ['smoke', '--platform', s.platform, '--version', s.version])
  .on(local)
  .recovery('rerun');

const runSmoke = H.flow('run-smoke').for(smoke).does(async (ctx) => {
  await ctx.move('smoke-running');
  const tested = await ctx.run(smokeTest, ctx.unit.data);
  if (!tested.ok) return ctx.fail(tested.error);
  return 'smoke-passed';
});

const smokeLane = H.lane('smoke', smoke)
  .handler(runSmoke)
  .store(sqlite.store(smoke, 'release.db'))
  .wip(4);

const shipRelease = H.flow('ship-release').for(release).does(async (ctx) => {
  await ctx.move('release-running');
  const { version, channel, platforms } = ctx.unit.data;
  const built = await ctx.run(build, ctx.unit.data);
  if (!built.ok) return ctx.fail(built.error);
  const announced = await ctx.run(announce, { version, channel });
  if (!announced.ok) return ctx.fail(announced.error);
  const reviewed = await ctx.run(releaseReviewer, { version });
  if (!reviewed.ok) return ctx.fail(reviewed.error);
  const approved = await ctx.halt(releaseApproval, `${version}: reviewer says ${reviewed.value.verdict}. ${reviewed.value.notes}`);
  if (approved.action === 'reject') return 'release-rejected';
  const summaries = await ctx.batch(summarizer, [{ version, notes: reviewed.value.notes }]);
  const summary = summaries[0];
  if (summary === undefined) return ctx.fail('summary batch returned no result');
  if (!summary.ok) return ctx.fail(summary.error);
  await ctx.update({ releaseNotes: summary.value.summary });
  const children = await ctx.spawn(smokeLane, platforms.map((platform) => ({ version, platform })));
  const finished = await ctx.wait('release-awaiting-smoke', { children });
  return finished.every((child) => child.state === 'smoke-passed') ? 'release-shipped' : 'release-failed';
});

const releases = H.lane('releases', release)
  .handler(shipRelease)
  .suppliers(H.operator)
  .store(sqlite.store(release, 'release.db'))
  .wip(1);

const api = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const pool = H.pool('anthropic', [{ account: api, share: 1 }]);

export const harness = H.harness('release')
  .ledger(sqlite.ledger('release-ledger.db'))
  .lanes(releases, smokeLane)
  .pools(pool)
  .clients(claudeCode.supervisor({
    grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.readTelemetry],
  }))
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
