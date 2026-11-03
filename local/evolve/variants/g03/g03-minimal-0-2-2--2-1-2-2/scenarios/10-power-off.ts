import { z } from 'zod';
import { H } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as shell from 'harness-dsl/shell';
import * as claude from 'harness-dsl/claude-code';
import * as markdown from 'harness-dsl/markdown';

const api = anthropic.account('release-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const strong = anthropic.model('claude-sonnet-4-5');
const pool = H.pool('release-accounts', [{ account: api, share: 1 }]);
const builders = shell.local('release-builders', { slots: 2 });

const smokeQueued = H.state('queued', 'pending');
const passed = H.state('passed', 'terminal', 'success');
const smokeFailed = H.state('failed', 'terminal', 'failure');

const smoke = H.kind('smoke')
  .data(z.object({ version: z.string(), platform: z.string() }))
  .states(smokeQueued, passed, smokeFailed);

const smokeTest = H.command('smoke-test')
  .input(z.object({ version: z.string(), platform: z.string() }))
  .output(z.object({ passed: z.boolean() }))
  .argv(input => ['./bin/smoke', input.version, input.platform])
  .on(builders)
  .recovery('rerun');

const runSmoke = H.flow('run-smoke').for(smoke).does(async ctx => {
  const result = await ctx.run(smokeTest, { version: ctx.unit.data.version, platform: ctx.unit.data.platform });
  if (!result.ok) return ctx.fail(result.error);
  return result.value.passed ? 'passed' : 'failed';
});

const smokes = H.lane('smoke', smoke)
  .handler(runSmoke)
  .retry({ times: 1, exhausted: 'failed' })
  .store(sqlite.store(smoke, './harness/smoke.sqlite'));

const requested = H.state('requested', 'pending');
const awaitingSmoke = H.state('awaiting-smoke', 'waiting');
const released = H.state('released', 'terminal', 'success');
const rejected = H.state('rejected', 'terminal', 'neutral');
const smokeBroken = H.state('smoke-failed', 'terminal', 'failure');
const releaseFailed = H.state('failed', 'terminal', 'failure');

const release = H.kind('release')
  .data(z.object({ version: z.string(), changelog: z.string(), channel: z.string(), platforms: z.array(z.string()) }))
  .states(requested, awaitingSmoke, released, rejected, smokeBroken, releaseFailed);

const build = H.command('build')
  .input(z.object({ version: z.string() }))
  .output(z.object({ artifact: z.string() }))
  .argv(input => ['make', 'release', `VERSION=${input.version}`])
  .on(builders)
  .recovery('rerun');

const announcePosted = H.command('announce-posted')
  .input(z.object({ version: z.string(), channel: z.string() }))
  .output(z.boolean())
  .argv(input => ['./bin/channel-has-post', input.channel, input.version])
  .on(builders);

const announce = H.command('announce')
  .input(z.object({ version: z.string(), channel: z.string() }))
  .argv(input => ['./bin/channel-post', input.channel, `Releasing ${input.version}`])
  .on(builders)
  .recovery(announcePosted);

const reviewRole = H.role('release-reviewer')
  .input(z.object({ version: z.string(), changelog: z.string(), artifact: z.string() }))
  .output(z.object({ ready: z.boolean(), notes: z.string() }))
  .prompt(input => `Review release ${input.version} (${input.artifact}):\n${input.changelog}`);

const summaryRole = H.role('release-summarizer')
  .input(z.object({ version: z.string(), changelog: z.string(), notes: z.string() }))
  .output(z.object({ summary: z.string() }))
  .prompt(input => `Write release notes for ${input.version}:\n${input.changelog}\nReview: ${input.notes}`);

const reviewer = H.seat('release-reviewer', reviewRole).model(strong);
const summarizer = H.seat('release-summarizer', summaryRole).model(strong);

const approval = H.halt('release-approval', z.object({ approve: z.boolean(), note: z.string().optional() }))
  .about(z.object({ version: z.string(), notes: z.string() }));

const shipRelease = H.flow('ship-release').for(release).does(async ctx => {
  const data = ctx.unit.data;
  const built = await ctx.run(build, { version: data.version });
  if (!built.ok) return ctx.fail(built.error);
  const announced = await ctx.run(announce, { version: data.version, channel: data.channel });
  if (!announced.ok) return ctx.fail(announced.error);
  const review = await ctx.run(reviewer, { version: data.version, changelog: data.changelog, artifact: built.value.artifact });
  if (!review.ok) return ctx.fail(review.error);
  const decision = await ctx.halt(approval, `Approve ${data.version}? ${review.value.notes}`, { version: data.version, notes: review.value.notes });
  if (!decision.approve) return 'rejected';
  const [summary] = await ctx.batch(summarizer, [{ version: data.version, changelog: data.changelog, notes: review.value.notes }]);
  if (!summary.ok) return ctx.fail(summary.error);
  await ctx.update({ changelog: summary.value.summary });
  const children = await ctx.spawn(smokes, data.platforms.map(platform => ({ version: data.version, platform })));
  const finished = await ctx.suspend('awaiting-smoke', { children });
  return finished.every(child => child.state === 'passed') ? 'released' : 'smoke-failed';
});

const releases = H.lane('releases', release)
  .handler(shipRelease)
  .retry({ times: 1, backoff: { first: { minutes: 10 } }, exhausted: 'failed' })
  .suppliers(H.operator)
  .store(sqlite.store(release, './harness/releases.sqlite'));

export const releaseHarness = H.harness('releases')
  .ledger(sqlite.ledger('./harness/release-ledger.sqlite'))
  .lanes(releases, smokes)
  .pools(pool)
  .clients(claude.supervisor({
    grants: [
      H.ops.readWork, H.ops.writeWork, H.ops.readTelemetry,
      H.ops.resolve(approval, H.halts.interrupted, H.halts.definitionChanged),
    ],
  }))
  .observers(markdown.board('./harness/BOARD.md'));
