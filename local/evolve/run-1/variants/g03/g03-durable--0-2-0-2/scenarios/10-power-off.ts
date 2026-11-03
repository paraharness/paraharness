import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const Failed = H.terminal('Failed', 'failure');
const Withdrawn = H.terminal('Withdrawn', 'neutral');

const localRunner = local.runner('release-runner').slots(2);

const subscription = claudeCode.subscription('claude-max', { token: H.env('CLAUDE_TOKEN') });
const reviewPool = H.pool('review-pool').accounts(subscription);
const reviewModel = claudeCode.model('opus', { id: 'claude-opus-4-1' });

const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const batchPool = H.pool('batch-pool').accounts(apiAccount);
const summaryModel = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });

const smokeSchema = z.object({ version: z.string(), platform: z.string() });

const SmokeQueued = H.state('SmokeQueued', 'pending');
const SmokeRunning = H.state('SmokeRunning', 'active');
const SmokePassed = H.terminal('SmokePassed', 'success');

const Smoke = H.kind('Smoke')
  .attributes(smokeSchema)
  .states(SmokeQueued, SmokeRunning, SmokePassed, Failed, Withdrawn)
  .key((smoke) => `${smoke.version}/${smoke.platform}`)
  .initial(SmokeQueued)
  .onAttemptFailed(Failed)
  .onCancelled(Withdrawn);

const smokeTest = H.command('smoke-test')
  .input(smokeSchema)
  .argv((input) => ['./scripts/smoke', input.platform, input.version])
  .runner(localRunner);

const smokeFlow = H.flow('smoke')
  .input(smokeSchema)
  .step('smokeTest', smokeTest, (ctx) => ctx.unit.attributes, { afterCrash: 'rerun' })
  .exit('passed');

const smoke = H.lane('smoke', Smoke).handler(smokeFlow, {
  exits: { passed: SmokePassed },
  during: { smokeTest: SmokeRunning },
});

const releaseSchema = z.object({ version: z.string(), platforms: z.array(z.string()) });

const Requested = H.state('Requested', 'pending');
const Building = H.state('Building', 'active');
const Announcing = H.state('Announcing', 'active');
const Reviewing = H.state('Reviewing', 'active');
const AwaitingApproval = H.state('AwaitingApproval', 'waiting');
const Summarizing = H.state('Summarizing', 'waiting');
const AwaitingSmoke = H.state('AwaitingSmoke', 'waiting');
const Released = H.terminal('Released', 'success');
const Rejected = H.terminal('Rejected', 'neutral');
const BlockedBySmoke = H.terminal('BlockedBySmoke', 'failure');

const Release = H.kind('Release')
  .attributes(releaseSchema)
  .states(
    Requested,
    Building,
    Announcing,
    Reviewing,
    AwaitingApproval,
    Summarizing,
    AwaitingSmoke,
    Released,
    Rejected,
    BlockedBySmoke,
    Failed,
    Withdrawn,
  )
  .key((release) => release.version)
  .initial(Requested)
  .onAttemptFailed(Failed)
  .onCancelled(Withdrawn);

const versionInput = z.object({ version: z.string() });

const build = H.command('build-release')
  .input(versionInput)
  .argv((input) => ['make', 'release', `VERSION=${input.version}`])
  .runner(localRunner);

const announce = H.command('announce-release')
  .input(versionInput)
  .argv((input) => ['./scripts/announce', input.version])
  .runner(localRunner);

const announcementPosted = H.command('announcement-posted')
  .input(versionInput)
  .argv((input) => ['./scripts/announcement-exists', input.version])
  .output(z.boolean())
  .runner(localRunner);

const releaseReviewer = H.role('release-reviewer')
  .intents('read', 'run', 'search')
  .instructions('Review the release diff and changelog for risk. Report blockers plainly.');

const reviewer = H.agent('release-review').role(releaseReviewer).model(reviewModel).pool(reviewPool);

const summarizerRole = H.role('release-summarizer').intents('read').instructions('Write the public release summary.');
const summarizer = H.agent('release-summary').role(summarizerRole).model(summaryModel).pool(batchPool);

const releaseFlow = H.flow('release')
  .input(releaseSchema)
  .step('build', build, (ctx) => ({ version: ctx.unit.attributes.version }), { afterCrash: 'rerun' })
  .step('announce', announce, (ctx) => ({ version: ctx.unit.attributes.version }), {
    afterCrash: 'park',
    alreadyDone: announcementPosted,
  })
  .step('review', reviewer, (ctx) => ({ task: `Review release ${ctx.unit.attributes.version}.` }), {
    afterCrash: 'askDriver',
  })
  .halt('approval', {
    ask: (ctx) => `Approve release ${ctx.unit.attributes.version}?\n\n${ctx.steps.review}`,
    decision: z.object({ approved: z.boolean(), note: z.string() }),
  })
  .exit('rejected', (ctx) => !ctx.steps.approval.approved)
  .batch('summarize', summarizer, (ctx) => [
    { task: `Summarise release ${ctx.unit.attributes.version} for users.\n\nReview notes:\n${ctx.steps.review}` },
  ])
  .spawn('smoke', smoke, (ctx) =>
    ctx.unit.attributes.platforms.map((platform) => ({ version: ctx.unit.attributes.version, platform })),
  )
  .exit('smokeFailed', (ctx) => ctx.steps.smoke.some((child) => child.verdict !== 'success'))
  .exit('released');

const releases = H.lane('releases', Release)
  .supply(H.operator)
  .store(sqlite.store({ path: 'state/units.sqlite' }))
  .handler(releaseFlow, {
    exits: { rejected: Rejected, smokeFailed: BlockedBySmoke, released: Released },
    during: {
      build: Building,
      announce: Announcing,
      review: Reviewing,
      approval: AwaitingApproval,
      summarize: Summarizing,
      smoke: AwaitingSmoke,
    },
  })
  .retry({ maxAttempts: 2, backoff: 'fixed', initialDelayMs: 300000 });

const releaseManager = claudeCode.supervisor('release-manager', {
  grants: [
    H.ops.workRead,
    H.ops.workCreate,
    H.ops.workCancel,
    H.ops.blockersResolve,
    H.ops.attemptsRecover,
    H.ops.telemetryRead,
  ],
});

export const releaseHarness = H.harness('releases')
  .ledger(sqlite.ledger({ path: 'state/ledger.sqlite' }))
  .lanes(releases, smoke)
  .scheduler(H.scheduler('release-scheduler').priority(releases, smoke).wip(smoke, 4))
  .clients(releaseManager)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));
