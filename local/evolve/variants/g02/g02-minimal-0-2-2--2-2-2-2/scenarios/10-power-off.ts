import { z } from 'zod';
import { H } from 'harness-dsl';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const local = shell.local('local', { slots: 4 });
const subscription = claudeCode.subscription('claude-max-1', { token: H.env('CLAUDE_MAX_1_TOKEN') });
const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const reviewModel = claudeCode.model('claude-opus-4-1');
const batchModel = anthropic.model('claude-haiku-4-5');

const platformSchema = z.enum(['linux', 'macos', 'windows']);

const requested = H.state('requested', 'pending');
const awaitingSmoke = H.state('awaiting-smoke', 'waiting');
const released = H.state('released', 'terminal', 'success');
const smokeFailed = H.state('smoke-failed', 'terminal', 'failure');
const releaseRejected = H.state('release-rejected', 'terminal', 'neutral');

const release = H.kind('release')
  .data(z.object({ version: z.string(), platforms: z.array(platformSchema), summary: z.string().optional() }))
  .states(requested, awaitingSmoke, released, smokeFailed, releaseRejected);

const smokeQueued = H.state('smoke-queued', 'pending');
const smokePassed = H.state('smoke-passed', 'terminal', 'success');
const smokeBroken = H.state('smoke-broken', 'terminal', 'failure');

const smoke = H.kind('smoke')
  .data(z.object({ release: z.string(), platform: platformSchema }))
  .states(smokeQueued, smokePassed, smokeBroken);

const versionInput = z.object({ version: z.string() });

const build = H.command('build')
  .input(versionInput)
  .argv(input => ['make', 'release', `VERSION=${input.version}`])
  .on(local)
  .recovery('rerun');

const announcePosted = H.command('announce-posted')
  .input(versionInput)
  .output(z.boolean())
  .argv(input => ['scripts/announcement-exists', input.version])
  .on(local);

const announce = H.command('announce')
  .input(versionInput)
  .argv(input => ['scripts/announce', input.version])
  .on(local)
  .recovery(announcePosted);

const reviewRole = H.role('release-review')
  .input(z.object({ version: z.string(), buildLog: z.string() }))
  .output(z.object({ verdict: z.string() }))
  .prompt(input => `Review release ${input.version}.\n${input.buildLog}`)
  .intents(['read']);

const reviewer = H.seat('release-reviewer', reviewRole).model(reviewModel);

const summaryRole = H.role('release-summary')
  .input(z.object({ version: z.string(), review: z.string() }))
  .output(z.object({ text: z.string() }))
  .prompt(input => `Write release notes for ${input.version} from this review:\n${input.review}`);

const summarizer = H.seat('release-summarizer', summaryRole).model(batchModel);
const summarize = H.job('summarize').batch(summarizer);

const releaseApproval = H.halt('release-approval', z.object({ approved: z.boolean() })).about(
  z.object({ version: z.string(), review: z.string() })
);

const runSmoke = H.command('run-smoke')
  .input(z.object({ release: z.string(), platform: platformSchema }))
  .argv(input => ['scripts/smoke', input.release, input.platform])
  .on(local)
  .recovery('rerun');

const smokeTest = H.flow('smoke-test')
  .for(smoke)
  .does(async ctx => {
    const result = await ctx.run(runSmoke, ctx.unit.data);
    return result.ok ? 'smoke-passed' : 'smoke-broken';
  });

const smokeLane = H.lane('smoke', smoke).handler(smokeTest).store(sqlite.store(smoke, '/srv/release/units.db')).wip(3);

const shipRelease = H.flow('ship-release')
  .for(release)
  .does(async ctx => {
    const version = ctx.unit.data.version;
    const built = await ctx.run(build, { version });
    if (built.ok === false) return ctx.fail(built.error);
    const announced = await ctx.run(announce, { version });
    if (announced.ok === false) return ctx.fail(announced.error);
    const reviewed = await ctx.run(reviewer, { version, buildLog: built.value });
    if (reviewed.ok === false) return ctx.fail(reviewed.error);
    const decision = await ctx.halt(releaseApproval, reviewed.value.verdict, { version, review: reviewed.value.verdict });
    if (decision.approved === false) return 'release-rejected';
    const summaries = await ctx.run(summarize, [{ version, review: reviewed.value.verdict }]);
    if (summaries.ok === false) return ctx.fail(summaries.error);
    const first = summaries.value[0];
    if (first && first.ok) await ctx.update({ summary: first.value.text });
    const children = await ctx.spawn(
      smokeLane,
      ctx.unit.data.platforms.map(platform => ({ release: version, platform }))
    );
    const results = await ctx.wait('awaiting-smoke', { children });
    return results.every(child => child.state === 'smoke-passed') ? 'released' : 'smoke-failed';
  });

const releases = H.lane('releases', release)
  .handler(shipRelease)
  .suppliers(H.operator)
  .store(sqlite.store(release, '/srv/release/units.db'))
  .wip(1);

export const releaseHarness = H.harness('release')
  .ledger(sqlite.ledger('/srv/release/ledger.db'))
  .lanes(releases, smokeLane)
  .pools(
    H.pool('subscriptions', [{ account: subscription, share: 1 }]),
    H.pool('api', [{ account: apiAccount, share: 1 }])
  )
  .clients(
    claudeCode.supervisor({
      grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolve(releaseApproval, H.parked), H.ops.readTelemetry],
    })
  )
  .observers(markdown.board('/srv/release/BOARD.md'), markdown.telemetry('/srv/release/TELEMETRY.md'));

export const running = releaseHarness.start();
