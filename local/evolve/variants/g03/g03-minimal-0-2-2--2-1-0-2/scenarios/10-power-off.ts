import { z } from 'zod';
import { H } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as sqlite from 'harness-dsl/sqlite';
import * as shell from 'harness-dsl/shell';
import * as git from 'harness-dsl/git';
import * as markdown from 'harness-dsl/markdown';

const sonnet = anthropic.model('claude-sonnet-4-5');
const api = anthropic.account('release-api', { apiKey: H.env('ANTHROPIC_API_KEY'), serves: [sonnet] });

const local = shell.local('local', { slots: 4 });
const checkout = git.worktree('release-checkout', { repo: '.', slots: 2 });

const platformValues = z.enum(['linux', 'macos', 'windows']);

const requested = H.state('requested', 'pending');
const smoking = H.state('smoking', 'waiting');
const released = H.state('released', 'terminal', 'success');
const heldBack = H.state('held-back', 'terminal', 'neutral');
const failed = H.state('failed', 'terminal', 'failure');

const release = H.kind('release')
  .data(z.object({ version: z.string(), platforms: z.array(platformValues), summary: z.string().optional() }))
  .states(requested, smoking, released, heldBack, failed);

const smokeQueued = H.state('smoke-queued', 'pending');
const smokePassed = H.state('smoke-passed', 'terminal', 'success');
const smokeFailed = H.state('smoke-failed', 'terminal', 'failure');

const smoke = H.kind('smoke')
  .data(z.object({ version: z.string(), platform: platformValues }))
  .states(smokeQueued, smokePassed, smokeFailed);

const build = H.command('build')
  .input(z.object({ version: z.string() }))
  .argv(i => ['make', 'release', `VERSION=${i.version}`])
  .on(checkout)
  .recovery('rerun');

const findAnnouncement = H.command('find-announcement')
  .input(z.object({ version: z.string() }))
  .output(z.boolean())
  .argv(i => ['announce', 'find', '--version', i.version])
  .on(local);

const announce = H.command('announce')
  .input(z.object({ version: z.string() }))
  .argv(i => ['announce', 'post', '--version', i.version])
  .on(local)
  .recovery(findAnnouncement);

const reviewRole = H.role('review-release')
  .input(z.object({ version: z.string(), buildLog: z.string() }))
  .output(z.object({ ship: z.boolean(), notes: z.string() }))
  .prompt(i => `Review release ${i.version}. Build log:\n${i.buildLog}`)
  .intents(['read']);

const summarizeRole = H.role('summarize-release')
  .input(z.object({ version: z.string(), notes: z.string() }))
  .output(z.object({ summary: z.string() }))
  .prompt(i => `Write release notes for ${i.version} from: ${i.notes}`);

const reviewer = H.seat('release-reviewer', reviewRole).model(sonnet).on(checkout);
const summarizer = H.seat('release-summarizer', summarizeRole).model(sonnet);

const releaseApproval = H.halt('release-approval', z.object({ approved: z.boolean() }));

const smokeTest = H.command('smoke-test')
  .input(z.object({ version: z.string(), platform: platformValues }))
  .argv(i => ['smoke', '--version', i.version, '--platform', i.platform])
  .on(local)
  .recovery('rerun');

const runSmoke = H.flow('run-smoke')
  .for(smoke)
  .does(async ctx => {
    const result = await ctx.run(smokeTest, { version: ctx.unit.data.version, platform: ctx.unit.data.platform });
    return result.ok ? 'smoke-passed' : 'smoke-failed';
  });

const smokes = H.lane('smoke', smoke)
  .handler(runSmoke)
  .retries(0, { exhausted: 'smoke-failed' })
  .store(sqlite.store(smoke, '.harness/smoke.db'));

const shipRelease = H.flow('ship-release')
  .for(release)
  .does(async ctx => {
    const version = ctx.unit.data.version;
    const built = await ctx.run(build, { version });
    if (!built.ok) return ctx.fail(built.error);
    const announced = await ctx.run(announce, { version });
    if (!announced.ok) return ctx.fail(announced.error);
    const review = await ctx.run(reviewer, { version, buildLog: built.value });
    if (!review.ok) return ctx.fail(review.error);
    const approval = await ctx.halt(releaseApproval, review.value.notes);
    if (!approval.approved || !review.value.ship) return 'held-back';
    const [summary] = await ctx.batch(summarizer, [{ version, notes: review.value.notes }]);
    if (!summary.ok) return ctx.fail(summary.error);
    await ctx.update({ summary: summary.value.summary });
    const children = await ctx.spawn(smokes, ctx.unit.data.platforms.map(platform => ({ version, platform })));
    const results = await ctx.suspend('smoking', { children });
    return results.every(r => r.state === 'smoke-passed') ? 'released' : ctx.fail('a smoke run failed');
  });

const releases = H.lane('releases', release)
  .handler(shipRelease)
  .retries(1, { exhausted: 'failed' })
  .suppliers(H.operator)
  .store(sqlite.store(release, '.harness/releases.db'));

export default H.harness('release')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(releases, smokes)
  .pools(H.pool('release-api', [{ account: api, share: 1 }]))
  .clients(claudeCode.supervisor({
    grants: [
      H.ops.readWork, H.ops.writeWork, H.ops.readTelemetry,
      H.ops.resolve(releaseApproval, H.halts.interrupted, H.halts.definitionChanged),
    ],
  }))
  .observers(markdown.board('.harness/board.md'));
