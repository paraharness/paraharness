import { H } from 'harness-dsl';
import { z } from 'zod';
import * as claude from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const releaseBox = shell.local('release-box', { slots: 2 });
const smokeBox = shell.local('smoke-box', { slots: 4 });

const reviewModel = claude.model('claude-sonnet');
const batchModel = anthropic.model('claude-sonnet');
const subscription = claude.subscription('claude-max', { token: H.env('CLAUDE_TOKEN') });
const api = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });

const release = H.kind('Release')
  .data(z.object({ version: z.string(), platforms: z.array(z.string()) }))
  .states(
    H.state('requested', 'pending'),
    H.state('smoking', 'waiting'),
    H.state('released', 'terminal', 'success'),
    H.state('rejected', 'terminal', 'neutral'),
    H.state('smokeFailed', 'terminal', 'failure'),
    H.state('stopped', 'terminal', 'failure')
  );

const smoke = H.kind('Smoke')
  .data(z.object({ version: z.string(), platform: z.string() }))
  .states(H.state('queued', 'pending'), H.state('passed', 'terminal', 'success'), H.state('broken', 'terminal', 'failure'));

const version = z.object({ version: z.string() });

const build = H.command('build')
  .input(version)
  .argv((i) => ['make', 'release', `VERSION=${i.version}`])
  .on(releaseBox)
  .recovery('rerun');

const announcementPosted = H.command('announcementPosted')
  .input(version)
  .output(z.boolean())
  .argv((i) => ['./scripts/announcement-posted.sh', i.version])
  .on(releaseBox);

const announce = H.command('announce')
  .input(version)
  .argv((i) => ['./scripts/announce.sh', i.version])
  .on(releaseBox)
  .recovery(announcementPosted);

const reviewerRole = H.role('releaseReviewer')
  .input(version)
  .output(z.object({ notes: z.string() }))
  .prompt((i) => `Review the release ${i.version}: changelog, open risks, migration notes.`)
  .intents(['read']);

const summarizerRole = H.role('releaseSummarizer')
  .input(z.object({ version: z.string(), notes: z.string() }))
  .output(z.object({ summary: z.string() }))
  .prompt((i) => `Write release notes for ${i.version} from this review:\n${i.notes}`);

const reviewer = H.seat('reviewer', reviewerRole).model(reviewModel).on(releaseBox);
const summarizer = H.seat('summarizer', summarizerRole).model(batchModel);

const releaseApproval = H.halt('releaseApproval', z.object({ approved: z.boolean() })).about(version);

const smokeTest = H.command('smokeTest')
  .input(z.object({ version: z.string(), platform: z.string() }))
  .argv((i) => ['./scripts/smoke.sh', i.platform, i.version])
  .on(smokeBox)
  .recovery('rerun');

const runSmoke = H.flow('runSmoke')
  .for(smoke)
  .does(async (ctx) => {
    const result = await ctx.run(smokeTest, ctx.unit.data);
    return result.ok ? 'passed' : 'broken';
  });

const smokes = H.lane('smoke', smoke)
  .handler(runSmoke)
  .store(sqlite.store(smoke, './.harness/units.db'))
  .wip(4)
  .retries(1, { exhausted: 'broken' });

const ship = H.flow('ship')
  .for(release)
  .does(async (ctx) => {
    const target = { version: ctx.unit.data.version };
    const built = await ctx.run(build, target);
    if (!built.ok) return ctx.fail(built.error);
    const posted = await ctx.run(announce, target);
    if (!posted.ok) return ctx.fail(posted.error);
    const reviewed = await ctx.run(reviewer, target);
    if (!reviewed.ok) return ctx.fail(reviewed.error);
    const decision = await ctx.halt(releaseApproval, `Release ${target.version}: ${reviewed.value.notes}`, target);
    if (!decision.approved) return 'rejected';
    const summaries = await ctx.batch(summarizer, [{ version: target.version, notes: reviewed.value.notes }]);
    const summary = summaries[0];
    if (summary === undefined || !summary.ok) return ctx.fail('summary batch failed');
    const children = await ctx.spawn(
      smokes,
      ctx.unit.data.platforms.map((platform) => ({ version: target.version, platform }))
    );
    const results = await ctx.wait('smoking', { children });
    return results.every((r) => r.state === 'passed') ? 'released' : 'smokeFailed';
  });

const releases = H.lane('releases', release)
  .handler(ship)
  .suppliers(H.operator)
  .store(sqlite.store(release, './.harness/units.db'))
  .wip(1)
  .retries(1, { exhausted: 'stopped' });

export const releaseHarness = H.harness('release')
  .ledger(sqlite.ledger('./.harness/ledger.db'))
  .lanes(releases, smokes)
  .pools(H.pool('accounts', [{ account: subscription, share: 1 }, { account: api, share: 1 }]))
  .clients(
    claude.supervisor({
      grants: [
        H.ops.readWork,
        H.ops.writeWork,
        H.ops.resolve(releaseApproval, H.halts.interrupted, H.halts.definitionChanged),
        H.ops.readTelemetry,
      ],
    })
  )
  .observers(markdown.board('./BOARD.md'));
