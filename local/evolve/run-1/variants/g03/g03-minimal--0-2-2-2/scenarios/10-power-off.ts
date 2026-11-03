import { z } from 'zod';
import { H } from 'harness-dsl';
import * as claude from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const requested = H.state('requested', 'pending');
const releasing = H.state('releasing', 'active');
const smoking = H.state('smoking', 'waiting');
const released = H.state('released', 'terminal', 'success');
const rejected = H.state('rejected', 'terminal', 'neutral');
const smokeFailed = H.state('smoke-failed', 'terminal', 'failure');

const Release = H.kind('Release')
  .data(z.object({
    version: z.string(),
    commit: z.string(),
    platforms: z.array(z.string()),
    summary: z.string().optional(),
  }))
  .states(requested, releasing, smoking, released, rejected, smokeFailed);

const smokeQueued = H.state('smoke-queued', 'pending');
const smokeRunning = H.state('smoke-running', 'active');
const smokePassed = H.state('smoke-passed', 'terminal', 'success');
const smokeBroken = H.state('smoke-broken', 'terminal', 'failure');

const Smoke = H.kind('Smoke')
  .data(z.object({ version: z.string(), platform: z.string() }))
  .states(smokeQueued, smokeRunning, smokePassed, smokeBroken);

const releaseHost = shell.local('release-host', { slots: 4 });

const build = H.command('build')
  .input(z.object({ commit: z.string(), version: z.string() }))
  .argv((r) => ['make', 'release', `COMMIT=${r.commit}`, `VERSION=${r.version}`])
  .on(releaseHost)
  .recovery('rerun');

const announcementPosted = H.command('announcement-posted')
  .input(z.object({ version: z.string() }))
  .output(z.boolean())
  .argv((r) => ['release-channel', 'has-post', r.version])
  .on(releaseHost);

const announce = H.command('announce')
  .input(z.object({ version: z.string() }))
  .argv((r) => ['release-channel', 'post', r.version])
  .on(releaseHost)
  .recovery(announcementPosted);

const smokeTest = H.command('smoke-test')
  .input(z.object({ version: z.string(), platform: z.string() }))
  .argv((s) => ['smoke', '--platform', s.platform, '--version', s.version])
  .on(releaseHost)
  .recovery('rerun');

const reviewRole = H.role('release-reviewer')
  .input(z.object({ version: z.string(), buildLog: z.string() }))
  .output(z.object({ concerns: z.array(z.string()), notes: z.string() }))
  .prompt((r) => `Review release ${r.version} for risk.\n\nBuild log:\n${r.buildLog}`)
  .intents(['read']);

const summaryRole = H.role('release-summarizer')
  .input(z.object({ version: z.string(), notes: z.string() }))
  .output(z.object({ summary: z.string() }))
  .prompt((r) => `Write release notes for ${r.version} from the review:\n${r.notes}`);

const opus = anthropic.model('claude-opus-4-1');
const haiku = anthropic.model('claude-haiku-4-5');
const subscription = claude.subscription('release-subscription', { token: H.env('CLAUDE_TOKEN') });
const api = anthropic.account('release-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const models = H.pool('release-models', [{ account: subscription, share: 1 }, { account: api, share: 1 }]);

const reviewer = H.agent('reviewer', reviewRole).model(opus);
const summarizer = H.agent('summarizer', summaryRole).model(haiku);

const releaseApproval = H.halt('release-approval', z.object({ approved: z.boolean(), note: z.string() }));

const runSmoke = H.flow('run-smoke')
  .for(Smoke)
  .phases('running')
  .exits('passed', 'broken')
  .does(async (ctx) => {
    await ctx.move('running');
    const result = await ctx.run(smokeTest, { version: ctx.unit.data.version, platform: ctx.unit.data.platform });
    return result.ok ? 'passed' : 'broken';
  });

const smokeTests = H.lane('smoke', Smoke)
  .handler(runSmoke, { running: smokeRunning, passed: smokePassed, broken: smokeBroken })
  .store(sqlite.store(Smoke, '.harness/smoke.db'))
  .wip(4);

const ship = H.flow('ship-release')
  .for(Release)
  .phases('building', 'announcing', 'reviewing', 'approving', 'summarizing', 'smoking')
  .exits('released', 'rejected', 'smoke-failed')
  .does(async (ctx) => {
    const release = ctx.unit.data;
    await ctx.move('building');
    const built = await ctx.run(build, { commit: release.commit, version: release.version });
    if (!built.ok) return ctx.fail(built.error);
    await ctx.move('announcing');
    const announced = await ctx.run(announce, { version: release.version });
    if (!announced.ok) return ctx.fail(announced.error);
    await ctx.move('reviewing');
    const reviewed = await ctx.run(reviewer, { version: release.version, buildLog: built.value });
    if (!reviewed.ok) return ctx.fail(reviewed.error);
    await ctx.move('approving');
    const approval = await ctx.halt(releaseApproval, reviewed.value.notes);
    if (!approval.approved) return 'rejected';
    await ctx.move('summarizing');
    const [summary] = await ctx.batch(summarizer, [{ version: release.version, notes: reviewed.value.notes }]);
    if (summary === undefined || !summary.ok) return ctx.fail('release summary unavailable');
    await ctx.update({ summary: summary.value.summary });
    const children = await ctx.spawn(
      smokeTests,
      release.platforms.map((platform) => ({ version: release.version, platform })),
    );
    const finished = await ctx.wait('smoking', { children });
    return finished.every((child) => child.state === 'smoke-passed') ? 'released' : 'smoke-failed';
  });

const releases = H.lane('releases', Release)
  .handler(ship, {
    building: releasing,
    announcing: releasing,
    reviewing: releasing,
    approving: releasing,
    summarizing: releasing,
    smoking,
    released,
    rejected,
    'smoke-failed': smokeFailed,
  })
  .suppliers(H.operator)
  .store(sqlite.store(Release, '.harness/releases.db'))
  .wip(1);

const oldestFirst = H.policy.scheduler('oldest-first', (view) => ({
  start: [...view.pending].sort((a, b) => b.waitedMs - a.waitedMs),
}));

export const releaseHarness = H.harness('release')
  .ledger(sqlite.ledger('.harness/release-ledger.db'))
  .lanes(releases, smokeTests)
  .pools(models)
  .scheduler(oldestFirst)
  .clients(claude.supervisor({
    grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.readTelemetry],
  }))
  .observers(markdown.board('board.md'), markdown.telemetry('telemetry.md'));
