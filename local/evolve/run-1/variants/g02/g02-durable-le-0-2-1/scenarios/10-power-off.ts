import { z } from 'zod';
import { H } from 'harness-dsl';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { sqlite } from 'harness-dsl/sqlite';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const releaseRunner = local.runner('release-local');
const unitStore = sqlite.store({ path: 'state/units.sqlite' });

const reviewModel = claudeCode.model('release-review-model', { id: 'claude-opus-4-1' });
const summaryModel = anthropic.model('release-summary-model', { id: 'claude-haiku-4-5' });

const subscriptionPool = H.pool('release-subscription')
  .accounts(claudeCode.subscription('release-max', { token: H.env('CLAUDE_MAX_TOKEN') }))
  .serves(reviewModel);
const apiPool = H.pool('release-api')
  .accounts(anthropic.account('release-api', { apiKey: H.env('ANTHROPIC_API_KEY') }))
  .serves(summaryModel);

const platformSchema = z.enum(['linux', 'macos', 'windows']);

const releaseSchema = z.object({
  version: z.string(),
  channel: z.string(),
  platforms: z.array(platformSchema),
});

const smokeSchema = z.object({
  version: z.string(),
  platform: platformSchema,
});

const SmokeQueued = H.state('SmokeQueued', 'pending');
const SmokeRunning = H.state('SmokeRunning', 'active');
const SmokePassed = H.terminal('SmokePassed', 'success');
const SmokeBroken = H.terminal('SmokeBroken', 'failure');

const Smoke = H.kind('Smoke')
  .attributes(smokeSchema)
  .states(SmokeQueued, SmokeRunning, SmokePassed, SmokeBroken)
  .key(smoke => `${smoke.version}:${smoke.platform}`)
  .initial(SmokeQueued)
  .onAttemptFailed(SmokeBroken);

const smokeTest = H.command('smoke-test')
  .input(smokeSchema)
  .argv(input => ['release', 'smoke', input.version, '--platform', input.platform])
  .runner(releaseRunner);

const smokeFlow = H.flow('smoke')
  .input(smokeSchema)
  .step('smokeTest', smokeTest, ctx => ({ version: ctx.unit.attributes.version, platform: ctx.unit.attributes.platform }), {
    afterCrash: 'rerun',
  })
  .exit('passed');

const smoke = H.lane('smoke', Smoke)
  .store(unitStore)
  .handler(smokeFlow, {
    exits: { passed: SmokePassed },
    during: { smokeTest: SmokeRunning },
  })
  .retry(H.retry({ maxAttempts: 2, backoff: 'fixed', initialDelayMs: 120000 }));

const Requested = H.state('Requested', 'pending');
const Building = H.state('Building', 'active');
const Announcing = H.state('Announcing', 'active');
const UnderReview = H.state('UnderReview', 'active');
const AwaitingApproval = H.state('AwaitingApproval', 'waiting');
const Summarizing = H.state('Summarizing', 'waiting');
const SmokeTesting = H.state('SmokeTesting', 'waiting');
const Released = H.terminal('Released', 'success');
const Rejected = H.terminal('Rejected', 'neutral');
const ReleaseFailed = H.terminal('ReleaseFailed', 'failure');
const Abandoned = H.terminal('Abandoned', 'neutral');

const Release = H.kind('Release')
  .attributes(releaseSchema)
  .states(Requested, Building, Announcing, UnderReview, AwaitingApproval, Summarizing, SmokeTesting, Released, Rejected, ReleaseFailed, Abandoned)
  .key(release => release.version)
  .initial(Requested)
  .onAttemptFailed(ReleaseFailed)
  .onCancelled(Abandoned);

const buildRelease = H.command('build-release')
  .input(z.object({ version: z.string() }))
  .argv(input => ['release', 'build', input.version])
  .output(z.object({ artifact: z.string() }))
  .runner(releaseRunner);

const announcementSchema = z.object({ version: z.string(), channel: z.string() });

const announceRelease = H.command('announce-release')
  .input(announcementSchema)
  .argv(input => ['release', 'announce', input.version, '--channel', input.channel])
  .runner(releaseRunner);

const announcementPosted = H.command('announcement-posted')
  .input(announcementSchema)
  .argv(input => ['release', 'announced', input.version, '--channel', input.channel])
  .output(z.boolean())
  .runner(releaseRunner);

const releaseReviewerRole = H.role('release-reviewer')
  .intents('read', 'search')
  .instructions('Review the release artifact and changelog for regressions and missing migration notes.');

const releaseReviewer = H.agent('release-reviewer')
  .role(releaseReviewerRole)
  .model(reviewModel)
  .output(z.object({ verdict: z.enum(['ship', 'hold']), notes: z.string() }));

const notesWriterRole = H.role('release-notes-writer')
  .intents('read')
  .instructions('Write user-facing release notes in short paragraphs.');

const releaseSummarizer = H.agent('release-summarizer')
  .role(notesWriterRole)
  .model(summaryModel)
  .output(z.object({ summary: z.string() }));

const releaseApproval = H.signal('releaseApproval').payload(z.object({
  approved: z.boolean(),
  notes: z.string().optional(),
}));

const releaseFlow = H.flow('release')
  .input(releaseSchema)
  .step('build', buildRelease, ctx => ({ version: ctx.unit.attributes.version }), {
    afterCrash: 'rerun',
    retry: H.retry({ maxAttempts: 2, backoff: 'fixed', initialDelayMs: 30000 }),
  })
  .step('announce', announceRelease, ctx => ({ version: ctx.unit.attributes.version, channel: ctx.unit.attributes.channel }), {
    afterCrash: 'park',
    alreadyDone: announcementPosted,
  })
  .step('review', releaseReviewer, ctx => ({
    task: `Review release ${ctx.unit.attributes.version}, artifact ${ctx.steps.build.artifact}.`,
  }), { afterCrash: 'askDriver' })
  .await('approval', releaseApproval, {
    ask: ctx => `Approve release ${ctx.unit.attributes.version}? Reviewer says ${ctx.steps.review.verdict}: ${ctx.steps.review.notes}`,
  })
  .exit('rejected', ctx => !ctx.steps.approval.approved)
  .batch('summarize', releaseSummarizer, ctx => [{
    task: `Write release notes for ${ctx.unit.attributes.version} from the review: ${ctx.steps.review.notes}`,
  }])
  .spawn('smoke', smoke, ctx => ctx.unit.attributes.platforms.map(platform => ({
    version: ctx.unit.attributes.version,
    platform,
  })))
  .exit('released', ctx => ctx.steps.smoke.every(child => child.verdict === 'success'))
  .exit('smokeFailed');

const releases = H.lane('releases', Release)
  .supply(H.operator)
  .store(unitStore)
  .handler(releaseFlow, {
    exits: { rejected: Rejected, released: Released, smokeFailed: ReleaseFailed },
    during: {
      build: Building,
      announce: Announcing,
      review: UnderReview,
      approval: AwaitingApproval,
      summarize: Summarizing,
      smoke: SmokeTesting,
    },
  })
  .retry(H.retry({ maxAttempts: 2, backoff: 'fixed', initialDelayMs: 600000 }));

const releaseDesk = claudeCode.supervisor('release-desk', {
  grants: [
    H.ops.workRead,
    H.ops.workCreate,
    H.ops.send(releaseApproval, { lanes: [releases] }),
    H.ops.send(H.cancel, { lanes: [releases] }),
    H.ops.attemptsRecover,
    H.ops.telemetryRead,
  ],
});

export const harness = H.harness('release')
  .ledger(sqlite.ledger({ path: 'state/ledger.sqlite' }))
  .pools(subscriptionPool, apiPool)
  .lanes(releases, smoke)
  .scheduler(H.scheduler('release').priority(releases, smoke).wip(smoke, 3))
  .clients(releaseDesk)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));

export const running = harness.start();
