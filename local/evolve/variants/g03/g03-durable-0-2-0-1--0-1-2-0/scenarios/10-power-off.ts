import { z } from 'zod';
import { H } from 'harness-dsl';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { sqlite } from 'harness-dsl/sqlite';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const subscription = claudeCode.subscription('release-subscription', {
  token: H.env('CLAUDE_TOKEN'),
  quota: sqlite.quota('release-subscription', { path: '.harness/quota.db' }),
});
const apiAccount = anthropic.account('release-api', {
  apiKey: H.env('ANTHROPIC_API_KEY'),
  quota: sqlite.quota('release-api', { path: '.harness/api-quota.db' }),
});

const reviewModel = claudeCode.model('sonnet-session', { id: 'claude-sonnet-4-5' });
const summaryModel = anthropic.model('haiku-batch', { id: 'claude-haiku-4-5' });

const reviewer = H.role('release-reviewer').intents('read', 'search').instructions('Review the release diff for risks.');
const summarizer = H.role('release-summarizer').intents('read').instructions('Summarise the release for the changelog.');

const reviewerSeat = H.seat('release-reviewer').role(reviewer).model(reviewModel).pool(H.pool('release-sessions').accounts(subscription));
const summarizerSeat = H.seat('release-summarizer').role(summarizer).model(summaryModel).pool(H.pool('release-batch').accounts(apiAccount));

const reviewCall = H.call('review-release', reviewerSeat).output(z.object({ concerns: z.array(z.string()) }));
const summaryCall = H.call('summarize-release', summarizerSeat);

const runner = local.runner('release-local');
const ReleaseInput = z.object({ version: z.string(), channel: z.string() });

const build = H.command('build')
  .input(ReleaseInput)
  .argv(input => ['make', 'release', `VERSION=${input.version}`])
  .runner(runner);
const announce = H.command('announce')
  .input(ReleaseInput)
  .argv(input => ['./release/announce', input.channel, input.version])
  .runner(runner);
const announcementPosted = H.command('announcement-posted')
  .input(ReleaseInput)
  .argv(input => ['./release/announcement-posted', input.channel, input.version])
  .output(z.boolean())
  .runner(runner);

const releaseApproval = H.halt('release-approval').decision(z.object({ approved: z.boolean(), note: z.string() }));

const SmokeAttrs = z.object({ version: z.string(), platform: z.string() });
const SmokeQueued = H.state('SmokeQueued', 'pending');
const SmokePassed = H.terminal('SmokePassed', 'success');
const SmokeBroken = H.terminal('SmokeBroken', 'failure');
const Smoke = H.kind('Smoke')
  .attributes(SmokeAttrs)
  .states(SmokeQueued, SmokePassed, SmokeBroken)
  .key(attrs => `${attrs.version}-${attrs.platform}`)
  .initial(SmokeQueued);

const smokeTest = H.command('smoke-test')
  .input(SmokeAttrs)
  .argv(input => ['./release/smoke', input.platform, input.version])
  .runner(runner);

const smokeFlow = H.flow('smoke-test')
  .input(SmokeAttrs)
  .step('smoke', smokeTest, ctx => ({ version: ctx.unit.attributes.version, platform: ctx.unit.attributes.platform }), { afterCrash: 'rerun' })
  .exit('passed');

const smoke = H.lane('smoke', Smoke)
  .store(sqlite.store({ path: '.harness/units.db' }))
  .handler(smokeFlow, { exits: { passed: SmokePassed } })
  .retry({ maxAttempts: 2, exhausted: SmokeBroken });

const platforms = ['linux', 'macos', 'windows'];

const Requested = H.state('Requested', 'pending');
const Released = H.terminal('Released', 'success');
const ReleaseRejected = H.terminal('ReleaseRejected', 'neutral');
const SmokeFailed = H.terminal('SmokeFailed', 'failure');
const ReleaseFailed = H.terminal('ReleaseFailed', 'failure');

const Release = H.kind('Release')
  .attributes(ReleaseInput)
  .states(Requested, Released, ReleaseRejected, SmokeFailed, ReleaseFailed)
  .key(attrs => attrs.version)
  .initial(Requested);

const releaseFlow = H.flow('release')
  .input(ReleaseInput)
  .step('build', build, ctx => ctx.unit.attributes, { afterCrash: 'rerun' })
  .step('announce', announce, ctx => ctx.unit.attributes, { afterCrash: 'park', alreadyDone: announcementPosted })
  .step('review', reviewCall, ctx => ({ text: `Review release ${ctx.unit.attributes.version}.` }), { afterCrash: 'askDriver' })
  .halt('approval', releaseApproval, {
    ask: ctx => `Approve ${ctx.unit.attributes.version}? Concerns: ${ctx.steps.review.concerns.join('; ') || 'none'}`,
  })
  .exit('rejected', ctx => !ctx.steps.approval.approved)
  .job('summarize', H.batch(summaryCall), ctx => [
    { text: `Summarise release ${ctx.unit.attributes.version}. Reviewer concerns: ${ctx.steps.review.concerns.join('; ')}` },
  ])
  .spawn('smoke', smoke, ctx => platforms.map(platform => ({ version: ctx.unit.attributes.version, platform })))
  .exit('released', ctx => ctx.steps.smoke.every(child => child.verdict === 'success'))
  .exit('smokeFailed');

const releases = H.lane('releases', Release)
  .supply(H.operator)
  .store(sqlite.store({ path: '.harness/units.db' }))
  .handler(releaseFlow, { exits: { released: Released, rejected: ReleaseRejected, smokeFailed: SmokeFailed } })
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 120000, exhausted: ReleaseFailed });

export const harness = H.harness('release')
  .ledger(sqlite.ledger({ path: '.harness/ledger.db' }))
  .lanes(releases, smoke)
  .scheduler(H.scheduler('release').standard(releases, smoke).wip(smoke, 3))
  .clients(
    claudeCode.supervisor('release-manager', {
      port: H.slot.port(1),
      grants: [H.ops.workRead, H.ops.workCreate, H.ops.resolve(releaseApproval), H.ops.attemptsRecover, H.ops.telemetryRead],
    }),
  )
  .observers(markdown.board({ path: 'BOARD.md' }));
