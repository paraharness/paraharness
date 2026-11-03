import { z } from 'zod';
import { H } from 'harness-dsl';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { sqlite } from 'harness-dsl/sqlite';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const buildHost = local.runner('build-host').slots(2);

const subscription = claudeCode.subscription('release-subscription', {
  token: H.env('CLAUDE_TOKEN'),
  quota: sqlite.quota('release-subscription', { path: '/srv/release/quota.sqlite' }),
});
const apiAccount = anthropic.account('release-api', {
  apiKey: H.env('ANTHROPIC_API_KEY'),
  quota: sqlite.quota('release-api', { path: '/srv/release/api-quota.sqlite' }),
});
const reviewModel = claudeCode.model('sonnet', { id: 'claude-sonnet-4-5' });
const batchModel = anthropic.model('haiku', { id: 'claude-haiku-4-5' });

const reviewer = H.seat('release-reviewer')
  .role(
    H.role('release-reviewer')
      .intents('read', 'search')
      .instructions('Review the release diff for risk.')
      .output(z.object({ verdict: z.string(), risks: z.array(z.string()) })),
  )
  .model(reviewModel)
  .pool(H.pool('release-subscriptions').accounts(subscription));

const summarizer = H.seat('release-summarizer')
  .role(H.role('release-summarizer').intents('read').instructions('Write release notes for customers.'))
  .model(batchModel)
  .pool(H.pool('release-api').accounts(apiAccount));

const releaseNotes = H.batch('release-notes', summarizer);

const version = z.object({ version: z.string() });

const build = H.command('build')
  .input(version)
  .argv(release => ['make', 'release', `VERSION=${release.version}`])
  .runner(buildHost);

const announce = H.command('announce')
  .input(version)
  .argv(release => ['./release/announce.sh', release.version])
  .runner(buildHost);

const announcementPosted = H.command('announcement-posted')
  .input(version)
  .argv(release => ['./release/announcement-posted.sh', release.version])
  .output(z.boolean())
  .runner(buildHost);

const releaseApproval = H.halt('release-approval').decision(z.object({ approved: z.boolean(), note: z.string() }));

const SmokeQueued = H.state('SmokeQueued', 'pending');
const SmokePassed = H.terminal('SmokePassed', 'success');
const SmokeFailed = H.terminal('SmokeFailed', 'failure');
const smokeAttrs = z.object({ version: z.string(), platform: z.string() });
const Smoke = H.kind('Smoke').attributes(smokeAttrs).states(SmokeQueued, SmokePassed, SmokeFailed).initial(SmokeQueued);

const smokeTest = H.command('smoke-test')
  .input(smokeAttrs)
  .argv(target => ['./release/smoke.sh', target.version, target.platform])
  .runner(buildHost);

const smokeFlow = H.flow('smoke')
  .input(smokeAttrs)
  .step('run', smokeTest, ctx => ctx.unit.attributes, { afterCrash: 'rerun' })
  .exit('passed');

const smoke = H.lane('smoke', Smoke)
  .handler(smokeFlow, { exits: { passed: SmokePassed } })
  .store(sqlite.store({ path: '/srv/release/units.sqlite' }))
  .retry({ maxAttempts: 2, exhausted: SmokeFailed });

const Requested = H.state('Requested', 'pending');
const Released = H.terminal('Released', 'success');
const SmokeRed = H.terminal('SmokeRed', 'failure');
const Rejected = H.terminal('Rejected', 'neutral');
const ReleaseFailed = H.terminal('ReleaseFailed', 'failure');
const releaseAttrs = z.object({ version: z.string(), platforms: z.array(z.string()) });
const Release = H.kind('Release')
  .attributes(releaseAttrs)
  .states(Requested, Released, SmokeRed, Rejected, ReleaseFailed)
  .key(attrs => attrs.version)
  .initial(Requested);

const ship = H.flow('ship')
  .input(releaseAttrs)
  .step('build', build, ctx => ({ version: ctx.unit.attributes.version }), { afterCrash: 'rerun' })
  .step('announce', announce, ctx => ({ version: ctx.unit.attributes.version }), { afterCrash: 'park', alreadyDone: announcementPosted })
  .step('review', reviewer, ctx => ({ task: `Review release ${ctx.unit.attributes.version}` }), { afterCrash: 'askDriver' })
  .halt('approval', releaseApproval, {
    ask: ctx => `Ship ${ctx.unit.attributes.version}? Reviewer: ${ctx.steps.review.verdict}; risks: ${ctx.steps.review.risks.join(', ')}`,
  })
  .exit('rejected', ctx => !ctx.steps.approval.approved)
  .job('summarize', releaseNotes, ctx => [{ task: `Write release notes for ${ctx.unit.attributes.version}` }])
  .spawn('smoke', smoke, ctx =>
    ctx.unit.attributes.platforms.map(platform => ({ version: ctx.unit.attributes.version, platform })),
  )
  .exit('smokeFailed', ctx => ctx.steps.smoke.some(child => child.verdict !== 'success'))
  .exit('released');

const releases = H.lane('releases', Release)
  .supply(H.operator)
  .handler(ship, { exits: { rejected: Rejected, smokeFailed: SmokeRed, released: Released } })
  .store(sqlite.store({ path: '/srv/release/units.sqlite' }))
  .retry({ maxAttempts: 2, backoff: 'fixed', initialDelayMs: 600_000, exhausted: ReleaseFailed });

const releaseManager = claudeCode.supervisor('release-manager', {
  port: H.slot.port(1),
  grants: [H.ops.workRead, H.ops.workCreate, H.ops.resolve(releaseApproval), H.ops.attemptsRecover, H.ops.telemetryRead],
});

export const harness = H.harness('release')
  .ledger(sqlite.ledger({ path: '/srv/release/ledger.sqlite' }))
  .lanes(releases, smoke)
  .scheduler(H.scheduler('release').standard(releases, smoke))
  .clients(releaseManager)
  .observers(markdown.board({ path: '/srv/release/BOARD.md' }), markdown.telemetry({ path: '/srv/release/TELEMETRY.md' }));

void harness.start();
