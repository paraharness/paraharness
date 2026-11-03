import { z } from 'zod';
import { H } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';
import { sqlite } from 'harness-dsl/sqlite';

const releaseRunner = local.runner('releaseRunner').slots(2);

const subscription = claudeCode.subscription('releaseSubscription', { token: H.env('CLAUDE_TOKEN') });
const apiAccount = anthropic.account('releaseApi', { apiKey: H.env('ANTHROPIC_API_KEY') });
const subscriptionPool = H.pool('releaseSubscriptionPool').accounts(subscription);
const apiPool = H.pool('releaseApiPool').accounts(apiAccount);

const reviewModel = claudeCode.model('releaseReviewModel', { id: 'claude-opus-4-1' });
const summaryModel = anthropic.model('releaseSummaryModel', { id: 'claude-sonnet-4-5' });

const ReleaseAttributes = z.object({ version: z.string(), channel: z.string() });

const Requested = H.state('Requested', 'pending');
const Building = H.state('Building', 'active');
const Announcing = H.state('Announcing', 'active');
const InReview = H.state('InReview', 'active');
const AwaitingApproval = H.state('AwaitingApproval', 'active');
const Summarizing = H.state('Summarizing', 'active');
const Smoking = H.state('Smoking', 'active');
const Released = H.terminal('Released', 'success');
const Rejected = H.terminal('Rejected', 'failure');
const SmokeRed = H.terminal('SmokeRed', 'failure');
const ReleaseFailed = H.terminal('ReleaseFailed', 'failure');
const Abandoned = H.terminal('Abandoned', 'neutral');

const Release = H.kind('Release')
  .attributes(ReleaseAttributes)
  .states(Requested, Building, Announcing, InReview, AwaitingApproval, Summarizing, Smoking, Released, Rejected, SmokeRed, ReleaseFailed, Abandoned)
  .key(r => r.version)
  .initial(Requested)
  .onAttemptFailed(ReleaseFailed)
  .onCancelled(Abandoned);

const SmokeAttributes = z.object({ release: z.string(), platform: z.string() });
const SmokeQueued = H.state('SmokeQueued', 'pending');
const SmokeRunning = H.state('SmokeRunning', 'active');
const SmokePassed = H.terminal('SmokePassed', 'success');
const SmokeFailed = H.terminal('SmokeFailed', 'failure');
const Smoke = H.kind('Smoke')
  .attributes(SmokeAttributes)
  .states(SmokeQueued, SmokeRunning, SmokePassed, SmokeFailed)
  .key(s => `${s.release}/${s.platform}`)
  .initial(SmokeQueued)
  .onAttemptFailed(SmokeFailed);

const smokeTest = H.command('smokeTest')
  .input(SmokeAttributes)
  .argv(input => ['./scripts/smoke', '--release', input.release, '--platform', input.platform])
  .runner(releaseRunner);

const smokeFlow = H.flow('smoke')
  .input(SmokeAttributes)
  .step('smokeTest', smokeTest, ctx => ctx.unit.attributes, { afterCrash: 'rerun' })
  .exit('passed');

const smoke = H.lane('smoke', Smoke)
  .store(sqlite.store({ path: 'state/units.db' }))
  .handler(smokeFlow, { exits: { passed: SmokePassed }, during: { smokeTest: SmokeRunning } });

const build = H.command('build')
  .input(z.object({ version: z.string() }))
  .argv(input => ['./scripts/build', '--version', input.version])
  .runner(releaseRunner);

const Announcement = z.object({ version: z.string(), channel: z.string() });

const announce = H.command('announce')
  .input(Announcement)
  .argv(input => ['./scripts/announce', '--channel', input.channel, '--version', input.version])
  .runner(releaseRunner);

const announcementPosted = H.command('announcementPosted')
  .input(Announcement)
  .argv(input => ['./scripts/find-announcement', '--channel', input.channel, '--version', input.version])
  .output(z.boolean())
  .runner(releaseRunner);

const releaseReviewer = H.role('releaseReviewer')
  .intents('read', 'search')
  .instructions('Review the release diff and changelog. List concerns a release manager must weigh.');
const reviewer = H.agent('releaseReviewer')
  .role(releaseReviewer)
  .model(reviewModel)
  .output(z.object({ concerns: z.array(z.string()), recommendation: z.enum(['ship', 'hold']) }));

const notesWriter = H.role('releaseNotesWriter').intents('read').instructions('Write release notes for end users.');
const summarizer = H.agent('releaseSummarizer').role(notesWriter).model(summaryModel).output(z.object({ notes: z.string() }));

const platforms = ['linux', 'macos', 'windows'];

const releaseFlow = H.flow('release')
  .input(ReleaseAttributes)
  .step('build', build, ctx => ({ version: ctx.unit.attributes.version }), {
    afterCrash: 'rerun',
    retry: H.retry({ maxAttempts: 2, backoff: 'fixed', initialDelayMs: 30000 }),
  })
  .step('announce', announce, ctx => ({ version: ctx.unit.attributes.version, channel: ctx.unit.attributes.channel }), {
    afterCrash: 'park',
    alreadyDone: announcementPosted,
  })
  .step('review', reviewer, ctx => ({ task: `Review release ${ctx.unit.attributes.version}.` }), { afterCrash: 'askDriver' })
  .halt('approval', {
    ask: ctx => `Ship ${ctx.unit.attributes.version}? Reviewer recommends ${ctx.steps.review.recommendation}. Concerns: ${ctx.steps.review.concerns.join('; ')}`,
    decision: z.object({ approved: z.boolean(), note: z.string() }),
  })
  .exit('rejected', ctx => ctx.steps.approval.approved === false)
  .step('summarize', summarizer.batch(), ctx => [
    { task: `Release notes for ${ctx.unit.attributes.version}. Manager note: ${ctx.steps.approval.note}` },
  ])
  .spawn('smoke', smoke, ctx => platforms.map(platform => ({ release: ctx.unit.attributes.version, platform })))
  .exit('released', ctx => ctx.steps.smoke.every(child => child.verdict === 'success'))
  .exit('smokeRed');

const releases = H.lane('releases', Release)
  .supply(H.operator)
  .store(sqlite.store({ path: 'state/units.db' }))
  .handler(releaseFlow, {
    exits: { released: Released, rejected: Rejected, smokeRed: SmokeRed },
    during: {
      build: Building,
      announce: Announcing,
      review: InReview,
      approval: AwaitingApproval,
      summarize: Summarizing,
      smoke: Smoking,
    },
  });

export const releaseHarness = H.harness('releaseHarness')
  .ledger(sqlite.ledger({ path: 'state/ledger.db' }))
  .pools(subscriptionPool, apiPool)
  .lanes(releases, smoke)
  .scheduler(H.scheduler('releaseScheduler').priority(releases, smoke).wip(releases, 1))
  .clients(
    claudeCode.supervisor('releaseManagerDesk', {
      grants: [
        H.ops.workRead,
        H.ops.workCreate,
        H.ops.workCancel,
        H.ops.blockersResolve,
        H.ops.attemptsRecover,
        H.ops.telemetryRead,
      ],
    }),
  )
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));
