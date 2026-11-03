import { z } from 'zod';
import { H } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as sqlite from 'harness-dsl/sqlite';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const apiAccount = anthropic.account('release-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const sonnet = anthropic.model('claude-sonnet-4-5');
const runner = shell.local('release-shell', { slots: 4 });

const requested = H.state('requested', 'pending');
const smoking = H.state('smoking', 'waiting');
const released = H.state('released', 'terminal', 'success');
const rejected = H.state('rejected', 'terminal', 'neutral');
const smokeFailed = H.state('smoke-failed', 'terminal', 'failure');

const release = H.kind('release')
  .data(z.object({ version: z.string(), channel: z.string(), platforms: z.array(z.string()) }))
  .states(requested, smoking, released, rejected, smokeFailed);

const smokeQueued = H.state('smoke-queued', 'pending');
const smokePassed = H.state('smoke-passed', 'terminal', 'success');
const smokeBroken = H.state('smoke-broken', 'terminal', 'failure');

const smoke = H.kind('smoke')
  .data(z.object({ version: z.string(), platform: z.string() }))
  .states(smokeQueued, smokePassed, smokeBroken);

const build = H.command('build')
  .input(z.object({ version: z.string() }))
  .output(z.object({ artifact: z.string() }))
  .argv(input => ['make', 'release', `VERSION=${input.version}`])
  .on(runner)
  .recovery('rerun');

const announcement = z.object({ version: z.string(), channel: z.string() });

const announcementPosted = H.command('announcement-posted')
  .input(announcement)
  .output(z.boolean())
  .argv(input => ['chat', 'search', '--channel', input.channel, `release ${input.version}`])
  .on(runner);

const announce = H.command('announce')
  .input(announcement)
  .argv(input => ['chat', 'post', '--channel', input.channel, `Releasing ${input.version}`])
  .on(runner)
  .recovery(announcementPosted);

const reviewRole = H.role('release-reviewer')
  .input(z.object({ version: z.string(), artifact: z.string() }))
  .output(z.object({ summary: z.string(), concerns: z.array(z.string()) }))
  .prompt(input => `Review release ${input.version} built as ${input.artifact}. Summarise risk and list concerns.`)
  .intents(['read']);

const reviewer = H.seat('release-reviewer', reviewRole).model(sonnet);

const notesRole = H.role('release-notes')
  .input(z.object({ version: z.string(), review: z.string() }))
  .output(z.object({ notes: z.string() }))
  .prompt(input => `Write release notes for ${input.version} from this review:\n${input.review}`);

const notesWriter = H.seat('release-notes-writer', notesRole).model(sonnet);
const summarize = H.job('summarize').batch(notesWriter);

const approval = H.halt('release-approval', z.object({ approve: z.boolean() }));

const smokeTest = H.command('smoke-test')
  .input(z.object({ version: z.string(), platform: z.string() }))
  .argv(input => ['smoke', '--platform', input.platform, '--version', input.version])
  .on(runner)
  .recovery('rerun');

const smokeRun = H.flow('smoke-run')
  .for(smoke)
  .does(async ctx => {
    const result = await ctx.run(smokeTest, { version: ctx.unit.data.version, platform: ctx.unit.data.platform });
    return result.ok ? 'smoke-passed' : 'smoke-broken';
  });

const smokeLane = H.lane('smoke', smoke)
  .handler(smokeRun)
  .store(sqlite.store(smoke, '/srv/release/smoke.sqlite'));

const releaseRun = H.flow('release-run')
  .for(release)
  .does(async ctx => {
    const version = ctx.unit.data.version;
    const built = await ctx.run(build, { version });
    if (!built.ok) return ctx.fail(built.error);
    const announced = await ctx.run(announce, { version, channel: ctx.unit.data.channel });
    if (!announced.ok) return ctx.fail(announced.error);
    const reviewed = await ctx.run(reviewer, { version, artifact: built.value.artifact });
    if (!reviewed.ok) return ctx.fail(reviewed.error);
    const decision = await ctx.halt(approval, reviewed.value.summary);
    if (!decision.approve) return 'rejected';
    const summaries = await ctx.run(summarize, [{ version, review: reviewed.value.summary }]);
    if (!summaries.ok) return ctx.fail(summaries.error);
    const children = await ctx.spawn(smokeLane, ctx.unit.data.platforms.map(platform => ({ version, platform })));
    const finished = await ctx.wait('smoking', { children });
    return finished.every(child => child.state === 'smoke-passed') ? 'released' : 'smoke-failed';
  });

const releases = H.lane('releases', release)
  .handler(releaseRun)
  .suppliers(H.operator)
  .store(sqlite.store(release, '/srv/release/releases.sqlite'));

export const releaseHarness = H.harness('release')
  .ledger(sqlite.ledger('/srv/release/ledger.sqlite'))
  .lanes(releases, smokeLane)
  .pools(H.pool('release-pool', [{ account: apiAccount, share: 1 }]))
  .clients(
    claudeCode.supervisor({
      grants: [
        H.ops.readWork,
        H.ops.writeWork,
        H.ops.resolve(approval, H.halts.changed, H.halts.interrupted),
        H.ops.readTelemetry,
      ],
    })
  )
  .observers(markdown.board('/srv/release/BOARD.md'));
