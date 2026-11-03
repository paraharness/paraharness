import { H } from 'harness-dsl';
import * as cc from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as shell from 'harness-dsl/shell';
import * as http from 'harness-dsl/http';
import * as markdown from 'harness-dsl/markdown';
import { z } from 'zod';

const requested = H.state('requested', 'pending');
const releasing = H.state('releasing', 'active');
const awaitingSmoke = H.state('awaiting-smoke', 'waiting');
const verifying = H.state('verifying', 'pending');
const released = H.state('released', 'terminal', 'success');
const rejected = H.state('rejected', 'terminal', 'failure');
const failedRelease = H.state('failed', 'terminal', 'failure');

const Release = H.kind('release')
  .data(z.object({ version: z.string(), platforms: z.array(z.string()) }))
  .states(requested, releasing, awaitingSmoke, verifying, released, rejected, failedRelease)
  .failsTo('failed', 'rejected');

const smokeQueued = H.state('smoke-queued', 'pending');
const smokeRunning = H.state('smoke-running', 'active');
const passed = H.state('passed', 'terminal', 'success');
const broken = H.state('broken', 'terminal', 'failure');

const Smoke = H.kind('smoke')
  .data(z.object({ version: z.string(), platform: z.string() }))
  .states(smokeQueued, smokeRunning, passed, broken);

const local = shell.local('release-host', { slots: 4 });
const releaseInput = z.object({ version: z.string() });

const build = H.command('build')
  .input(releaseInput)
  .argv(r => ['make', 'release', `VERSION=${r.version}`])
  .on(local)
  .recovers('rerun');

const announcementPosted = H.command('announcement-posted')
  .input(releaseInput)
  .output(z.boolean())
  .argv(r => ['release-channel', 'find', '--version', r.version, '--json'])
  .on(local);

const announce = H.command('announce')
  .input(releaseInput)
  .argv(r => ['release-channel', 'post', '--version', r.version])
  .on(local)
  .recovers(announcementPosted);

const reviewRole = H.role('release-reviewer')
  .input(z.object({ version: z.string() }))
  .output(z.object({ concerns: z.array(z.string()) }))
  .prompt(r => `Review the changes going into release ${r.version} and list blocking concerns.`)
  .intents(['read']);
const reviewer = H.agent('release-reviewer', reviewRole).model(cc.model('claude-opus-4-1')).on(local);

const summaryRole = H.role('release-summarizer')
  .input(z.object({ version: z.string(), concerns: z.array(z.string()) }))
  .output(z.object({ notes: z.string() }))
  .prompt(r => `Write release notes for ${r.version}. Reviewer concerns: ${r.concerns.join('; ')}`);
const summarizer = H.agent('release-summarizer', summaryRole).model(anthropic.model('claude-haiku-4-5'));

const releaseApproval = H.halt('release-approval', z.object({ approved: z.boolean(), note: z.string() }));

const smokeTest = H.command('smoke-test')
  .input(z.object({ version: z.string(), platform: z.string() }))
  .argv(s => ['smoke', '--version', s.version, '--platform', s.platform])
  .on(local)
  .recovers('rerun');

const releaseFlow = H.flow('release')
  .for(Release)
  .does(async ctx => {
    await ctx.move('releasing');
    const release = ctx.unit.data;

    const built = await ctx.run(build, { version: release.version });
    if (!built.ok) return ctx.fail(built.error);

    const announced = await ctx.run(announce, { version: release.version });
    if (!announced.ok) return ctx.fail(announced.error);

    const review = await ctx.run(reviewer, { version: release.version });
    if (!review.ok) return ctx.fail(review.error);

    const decision = await ctx.halt(releaseApproval, `Release ${release.version}. Concerns: ${review.value.concerns.join('; ') || 'none'}`);
    if (!decision.approved) return ctx.fail(`rejected: ${decision.note}`, 'rejected');

    const summaries = await ctx.batch(summarizer, [{ version: release.version, concerns: review.value.concerns }]);
    const summary = summaries[0];
    if (!summary || !summary.ok) return ctx.fail('release summary batch failed');

    await ctx.spawn(smoke, release.platforms.map(platform => ({ version: release.version, platform })));
    return ctx.wait('awaiting-smoke', { children: true, then: 'verifying' });
  })
  .phase('verifying', async ctx => {
    const children = await ctx.children(smoke);
    if (children.some(c => c.position !== 'terminal')) return ctx.wait('awaiting-smoke', { children: true, then: 'verifying' });
    const failing = children.filter(c => c.state !== 'passed').map(c => c.data.platform);
    return failing.length === 0 ? 'released' : ctx.fail(`smoke failed on ${failing.join(', ')}`, 'failed');
  });

const smokeFlow = H.flow('smoke').for(Smoke).does(async ctx => {
  await ctx.move('smoke-running');
  const result = await ctx.run(smokeTest, ctx.unit.data);
  return result.ok ? 'passed' : 'broken';
});

const releases = H.lane('releases', Release).handler(releaseFlow).suppliers(H.operator).store(sqlite.store(Release, './.harness/units.sqlite'));
const smoke = H.lane('smoke', Smoke).handler(smokeFlow).store(sqlite.store(Smoke, './.harness/units.sqlite'));

const pool = H.pool('release-accounts', [
  { account: cc.subscription('release-subscription', { token: H.env('CLAUDE_TOKEN') }), share: 1 },
  { account: anthropic.account('release-api', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 },
]);

export const harness = H.harness('release')
  .ledger(sqlite.ledger('./.harness/ledger.sqlite'))
  .lanes(releases, smoke)
  .pools(pool)
  .scheduler(H.policy.scheduler('releases-before-smoke', view => ({
    start: [...view.pending].sort((x, y) => (x.kind === Release.name ? 0 : 1) - (y.kind === Release.name ? 0 : 1) || y.waitedMs - x.waitedMs),
  })))
  .clients(
    cc.supervisor({ grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.readTelemetry] }),
    http.control({ port: 7410, token: H.env('RELEASE_CONTROL_TOKEN'), grants: [H.ops.readWork, H.ops.resolveHalts, H.ops.readTelemetry] })
  )
  .observers(markdown.board('./BOARD.md'), markdown.telemetry('./TELEMETRY.md'));

export const running = harness.start();
