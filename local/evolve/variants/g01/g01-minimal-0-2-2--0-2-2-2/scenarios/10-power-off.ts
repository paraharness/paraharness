import { H } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claude from 'harness-dsl/claude-code';
import * as sqlite from 'harness-dsl/sqlite';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';
import { z } from 'zod';

const account = anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const pool = H.pool('api-pool', [{ account, share: 1 }]);
const sonnet = anthropic.model('claude-sonnet');
const local = shell.local('local', { slots: 4 });

const requested = H.state('requested', 'pending');
const awaitingSmoke = H.state('awaiting-smoke', 'waiting');
const released = H.state('released', 'terminal', 'success');
const smokeFailed = H.state('smoke-failed', 'terminal', 'failure');
const rejected = H.state('rejected', 'terminal', 'neutral');
const release = H.kind('release')
  .data(z.object({ version: z.string(), platforms: z.array(z.string()) }))
  .states(requested, awaitingSmoke, released, smokeFailed, rejected);

const smokeQueued = H.state('smoke-queued', 'pending');
const passed = H.state('passed', 'terminal', 'success');
const failed = H.state('failed', 'terminal', 'failure');
const smoke = H.kind('smoke')
  .data(z.object({ version: z.string(), platform: z.string() }))
  .states(smokeQueued, passed, failed);

const versionInput = z.object({ version: z.string() });

const build = H.command('build')
  .input(versionInput)
  .argv(input => ['make', 'release', `VERSION=${input.version}`])
  .on(local)
  .recovery('rerun');
const announcementPosted = H.command('announcement-posted')
  .input(versionInput)
  .output(z.boolean())
  .argv(input => ['./release/announced', input.version])
  .on(local);
const announce = H.command('announce')
  .input(versionInput)
  .argv(input => ['./release/announce', input.version])
  .on(local)
  .recovery(announcementPosted);
const smokeTest = H.command('smoke-test')
  .input(z.object({ version: z.string(), platform: z.string() }))
  .argv(input => ['./release/smoke', input.version, input.platform])
  .on(local)
  .recovery('rerun');

const reviewerRole = H.role('release-reviewer')
  .input(z.object({ version: z.string(), buildLog: z.string() }))
  .output(z.object({ concerns: z.array(z.string()) }))
  .prompt(input => `Review release ${input.version}. Build log:\n${input.buildLog}`);
const summarizerRole = H.role('release-summarizer')
  .input(z.object({ version: z.string(), concerns: z.array(z.string()) }))
  .output(z.object({ notes: z.string() }))
  .prompt(input => `Write release notes for ${input.version}. Reviewer concerns:\n${input.concerns.join('\n')}`);
const reviewer = H.seat('release-reviewer', reviewerRole).model(sonnet);
const summarizer = H.seat('release-summarizer', summarizerRole).model(sonnet);

const approval = H.halt('release-approval', z.object({ approved: z.boolean() }));

const runSmoke = H.flow('run-smoke').for(smoke).does(async ctx => {
  const result = await ctx.run(smokeTest, ctx.unit.data);
  return result.ok ? 'passed' : 'failed';
});
const smokes = H.lane('smoke', smoke).handler(runSmoke).wip(4);

const ship = H.flow('ship-release').for(release).does(async ctx => {
  const version = ctx.unit.data.version;
  const built = await ctx.run(build, { version });
  if (!built.ok) return ctx.fail(built.error);
  const announced = await ctx.run(announce, { version });
  if (!announced.ok) return ctx.fail(announced.error);
  const review = await ctx.run(reviewer, { version, buildLog: built.value });
  if (!review.ok) return ctx.fail(review.error);
  const decision = await ctx.halt(approval, `Approve release ${version}? Concerns: ${review.value.concerns.join('; ') || 'none'}`);
  if (!decision.approved) return 'rejected';
  const [summary] = await ctx.batch(summarizer, [{ version, concerns: review.value.concerns }]);
  if (!summary.ok) return ctx.fail(summary.error);
  const children = await ctx.spawn(smokes, ctx.unit.data.platforms.map(platform => ({ version, platform })));
  const results = await ctx.wait('awaiting-smoke', { children });
  return results.every(result => result.state === 'passed') ? 'released' : 'smoke-failed';
});

const releases = H.lane('releases', release)
  .handler(ship)
  .suppliers(H.operator)
  .store(sqlite.store(release, './.harness/units.db'))
  .wip(1);

export const harness = H.harness('release')
  .ledger(sqlite.ledger('./.harness/ledger.db'))
  .lanes(releases, smokes)
  .pools(pool)
  .clients(claude.supervisor({ grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.readTelemetry] }))
  .observers(markdown.board('./BOARD.md'));
