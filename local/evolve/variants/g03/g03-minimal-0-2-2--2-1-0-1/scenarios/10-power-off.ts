import { H } from 'harness-dsl';
import { z } from 'zod';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as sqlite from 'harness-dsl/sqlite';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const sonnet = anthropic.model('claude-sonnet-4-5');
const haiku = anthropic.model('claude-haiku-4-5');
const subscription = claudeCode.subscription('release-claude', { token: H.env('CLAUDE_TOKEN') });
const api = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });

const releaseBox = shell.local('release-box', { slots: 2 });
const smokeBox = shell.local('smoke-box', { slots: 4 });

const requested = H.state('requested', 'pending');
const smoking = H.state('smoking', 'waiting');
const released = H.state('released', 'terminal', 'success');
const rejected = H.state('rejected', 'terminal', 'failure');
const failed = H.state('failed', 'terminal', 'failure');

const release = H.kind('Release')
  .data(z.object({
    version: z.string(),
    channel: z.string(),
    platforms: z.array(z.string()),
    summary: z.string().optional(),
  }))
  .states(requested, smoking, released, rejected, failed);

const queued = H.state('queued', 'pending');
const passed = H.state('passed', 'terminal', 'success');
const broken = H.state('broken', 'terminal', 'failure');

const smoke = H.kind('Smoke').data(z.object({ release: z.string(), platform: z.string() })).states(queued, passed, broken);

const build = H.command('build')
  .input(z.object({ version: z.string() }))
  .argv(input => ['make', 'release', `VERSION=${input.version}`])
  .on(releaseBox)
  .recovery('rerun');

const announcement = z.object({ version: z.string(), channel: z.string() });

const announcementPosted = H.command('announcement-posted')
  .input(announcement)
  .output(z.boolean())
  .argv(input => ['chat', 'has-message', '--channel', input.channel, '--contains', `Release ${input.version}`])
  .on(releaseBox)
  .recovery('rerun');

const announce = H.command('announce')
  .input(announcement)
  .argv(input => ['chat', 'post', '--channel', input.channel, '--text', `Release ${input.version} is rolling out`])
  .on(releaseBox)
  .recovery(announcementPosted);

const reviewing = H.role('release-reviewer')
  .input(z.object({ version: z.string(), buildLog: z.string() }))
  .output(z.object({ notes: z.string(), concerns: z.array(z.string()) }))
  .prompt(input => `Review release ${input.version}. Build log:\n${input.buildLog}`)
  .intents(['read']);

const reviewer = H.seat('release-reviewer', reviewing).model(sonnet).recovery('ask');

const summarizing = H.role('release-summarizer')
  .input(z.object({ version: z.string(), notes: z.string() }))
  .output(z.object({ summary: z.string() }))
  .prompt(input => `Write release notes for ${input.version} from these review notes:\n${input.notes}`);

const summarizer = H.seat('release-summarizer', summarizing).model(haiku).batched();

const releaseApproval = H.halt('release-approval', z.object({ approved: z.boolean(), note: z.string().optional() }));

const smokeTest = H.command('smoke-test')
  .input(z.object({ release: z.string(), platform: z.string() }))
  .argv(input => ['make', 'smoke', `VERSION=${input.release}`, `PLATFORM=${input.platform}`])
  .on(smokeBox)
  .recovery('rerun');

const runSmoke = H.flow('run-smoke').for(smoke).does(async ctx => {
  const result = await ctx.run(smokeTest, { release: ctx.unit.data.release, platform: ctx.unit.data.platform });
  return result.ok ? 'passed' : 'broken';
});

const smokeLane = H.lane('smoke', smoke)
  .handler(runSmoke)
  .attempts(2, { exhausted: 'broken' })
  .store(sqlite.store(smoke, '.harness/smoke.db'))
  .wip(4);

const shipRelease = H.flow('ship-release').for(release).does(async ctx => {
  const { version, channel, platforms } = ctx.unit.data;
  const built = await ctx.run(build, { version });
  if (!built.ok) return ctx.fail(built.error);
  const announced = await ctx.run(announce, { version, channel });
  if (!announced.ok) return ctx.fail(announced.error);
  const reviewed = await ctx.run(reviewer, { version, buildLog: built.value });
  if (!reviewed.ok) return ctx.fail(reviewed.error);
  const approval = await ctx.halt(releaseApproval, `${version}: ${reviewed.value.notes}\n${reviewed.value.concerns.join('\n')}`);
  if (!approval.approved) return 'rejected';
  const summary = await ctx.run(summarizer, { version, notes: reviewed.value.notes });
  if (!summary.ok) return ctx.fail(summary.error);
  await ctx.update({ summary: summary.value.summary });
  const children = await ctx.spawn(smokeLane, platforms.map(platform => ({ release: version, platform })));
  const finished = await ctx.suspend('smoking', { children });
  const brokenPlatforms = finished.filter(child => child.state !== 'passed').map(child => child.data.platform);
  return brokenPlatforms.length === 0 ? 'released' : ctx.fail(`smoke broken on ${brokenPlatforms.join(', ')}`);
});

const releases = H.lane('releases', release)
  .handler(shipRelease)
  .attempts(1, { exhausted: 'failed' })
  .suppliers(H.operator)
  .store(sqlite.store(release, '.harness/releases.db'))
  .wip(1);

export const releaseHarness = H.harness('release')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(releases, smokeLane)
  .pools(H.pool('release-models', [
    { account: subscription, share: 1, serves: [sonnet] },
    { account: api, share: 1, serves: [sonnet, haiku] },
  ]))
  .clients(claudeCode.supervisor({
    grants: [
      H.ops.readWork,
      H.ops.writeWork,
      H.ops.resolve(releaseApproval, H.halts.interrupted, H.halts.definitionChanged),
      H.ops.readTelemetry,
    ],
  }))
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
