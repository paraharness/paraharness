import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const quota = sqlite.quota('release-quota', { path: '.harness/quota.sqlite' });
const subscription = claudeCode.subscription('claude-release', { token: H.env('CLAUDE_TOKEN'), quota });
const apiAccount = anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });
const opus = claudeCode.model('opus', { id: 'claude-opus-4-1' });
const batchSonnet = anthropic.model('batch-sonnet', { id: 'claude-sonnet-4-5' });
const sessionPool = H.pool('claude-sessions').accounts(subscription);
const apiPool = H.pool('api').accounts(apiAccount);
const runner = local.runner('local').slots(4);

const releaseAttrs = z.object({ version: z.string(), commit: z.string(), channel: z.string() });
const RequestedRelease = H.state('requested-release', 'pending');
const BuildingRelease = H.state('building-release', 'active');
const Announcing = H.state('announcing', 'active');
const ReviewingRelease = H.state('reviewing-release', 'active');
const AwaitingApproval = H.state('awaiting-approval', 'waiting');
const Summarizing = H.state('summarizing', 'waiting');
const Smoking = H.state('smoking', 'waiting');
const ReleaseNeedsAttention = H.state('release-needs-attention', 'waiting');
const Released = H.terminal('released', 'success');
const ReleaseRejected = H.terminal('release-rejected', 'neutral');
const SmokeRegressed = H.terminal('smoke-regressed', 'failure');
const ReleaseWithdrawn = H.terminal('release-withdrawn', 'neutral');

const Release = H.kind('Release')
  .attributes(releaseAttrs)
  .states(
    RequestedRelease,
    BuildingRelease,
    Announcing,
    ReviewingRelease,
    AwaitingApproval,
    Summarizing,
    Smoking,
    ReleaseNeedsAttention,
    Released,
    ReleaseRejected,
    SmokeRegressed,
    ReleaseWithdrawn,
  )
  .key(a => a.version);

const smokeAttrs = z.object({ version: z.string(), platform: z.string() });
const SmokeQueued = H.state('smoke-queued', 'pending');
const SmokeRunning = H.state('smoke-running', 'active');
const SmokePassed = H.terminal('smoke-passed', 'success');
const SmokeFailed = H.terminal('smoke-failed', 'failure');
const SmokeCancelled = H.terminal('smoke-cancelled', 'neutral');
const Smoke = H.kind('Smoke')
  .attributes(smokeAttrs)
  .states(SmokeQueued, SmokeRunning, SmokePassed, SmokeFailed, SmokeCancelled)
  .key(a => `${a.version}:${a.platform}`);

const smokeTest = H.command('smoke-test')
  .input(smokeAttrs)
  .argv(i => ['./scripts/smoke', i.platform, i.version])
  .runner(runner);
const smokeFlow = H.flow('smoke')
  .input(smokeAttrs)
  .step('smoke', smokeTest, ctx => ({ version: ctx.unit.attributes.version, platform: ctx.unit.attributes.platform }), { afterCrash: 'rerun' })
  .exit('passed');
const smokeLane = H.lane('smoke', Smoke)
  .handler(smokeFlow, { exits: { passed: SmokePassed }, during: { smoke: SmokeRunning } })
  .retry({ maxAttempts: 2, backoff: 'fixed', initialDelayMs: 60_000, exhausted: SmokeFailed })
  .on(H.cancel, { enter: SmokeCancelled });

const build = H.command('build-release')
  .input(z.object({ commit: z.string() }))
  .argv(i => ['./scripts/build', i.commit])
  .runner(runner);

const announceInput = z.object({ version: z.string(), channel: z.string() });
const announce = H.command('announce-release')
  .input(announceInput)
  .argv(i => ['./scripts/announce', i.channel, i.version])
  .runner(runner);
const announcementPosted = H.command('announcement-posted')
  .input(announceInput)
  .argv(i => ['./scripts/announcement-posted', i.channel, i.version])
  .output(z.boolean())
  .runner(runner);

const releaseReviewerRole = H.role('release-reviewer').intents('read', 'search').instructions('Review the release diff for risk.');
const releaseReviewer = H.seat('release-reviewer')
  .role(releaseReviewerRole)
  .model(opus)
  .pool(sessionPool)
  .output(z.object({ verdict: z.enum(['ship', 'hold']), notes: z.string() }));

const releaseWriterRole = H.role('release-writer').intents('read').instructions('Summarise the release for users.');
const releaseSummarizer = H.seat('release-summarizer')
  .role(releaseWriterRole)
  .model(batchSonnet)
  .pool(apiPool)
  .output(z.object({ notes: z.string() }));

const releaseApproval = H.halt('release-approval').decision(z.object({ approve: z.boolean(), note: z.string() }));
const platforms = ['linux', 'macos', 'windows'];

const releaseFlow = H.flow('release')
  .input(releaseAttrs)
  .step('build', build, ctx => ({ commit: ctx.unit.attributes.commit }), { afterCrash: 'rerun' })
  .step('announce', announce, ctx => ({ version: ctx.unit.attributes.version, channel: ctx.unit.attributes.channel }), {
    afterCrash: 'park',
    alreadyDone: announcementPosted,
  })
  .step('review', releaseReviewer, ctx => ({ task: `Review release ${ctx.unit.attributes.version} at ${ctx.unit.attributes.commit}.` }), {
    afterCrash: 'askDriver',
  })
  .halt('approval', releaseApproval, {
    ask: ctx => `Ship ${ctx.unit.attributes.version}? Reviewer says ${ctx.steps.review.verdict}: ${ctx.steps.review.notes}`,
  })
  .exit('rejected', ctx => ctx.steps.approval.approve === false)
  .job('summarize', releaseSummarizer.batch(), ctx => [
    { task: `Write user-facing notes for ${ctx.unit.attributes.version}. Reviewer notes: ${ctx.steps.review.notes}` },
  ])
  .spawn('smoke', smokeLane, ctx => platforms.map(platform => ({ version: ctx.unit.attributes.version, platform })))
  .exit('shipped', ctx => ctx.steps.smoke.every(child => child.verdict === 'success'))
  .exit('smokeFailed');

const resume = H.signal('resume');

const releaseLane = H.lane('releases', Release)
  .supply(H.operator)
  .store(sqlite.store({ path: '.harness/units.sqlite' }))
  .handler(releaseFlow, {
    exits: { rejected: ReleaseRejected, shipped: Released, smokeFailed: SmokeRegressed },
    during: {
      build: BuildingRelease,
      announce: Announcing,
      review: ReviewingRelease,
      approval: AwaitingApproval,
      summarize: Summarizing,
      smoke: Smoking,
    },
  })
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 120_000, exhausted: ReleaseNeedsAttention })
  .on(resume, { enter: RequestedRelease })
  .on(H.cancel, { enter: ReleaseWithdrawn });

const releaseManager = claudeCode.supervisor('release-manager').client('release-control', {
  grants: [
    H.ops.workRead,
    H.ops.workCreate,
    H.ops.resolve(releaseApproval),
    H.ops.attemptsRecover,
    H.ops.signal(resume),
    H.ops.signal(H.cancel),
    H.ops.telemetryRead,
  ],
});

export const harness = H.harness('release')
  .ledger(sqlite.ledger({ path: '.harness/ledger.sqlite' }))
  .lanes(releaseLane, smokeLane)
  .scheduler(H.scheduler('release-scheduler').priority(releaseLane, smokeLane).wip(releaseLane, 1))
  .clients(releaseManager)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));

void harness.start();
