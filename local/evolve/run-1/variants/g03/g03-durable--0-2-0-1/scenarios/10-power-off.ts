import { z } from 'zod';
import { H } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { sqlite } from 'harness-dsl/sqlite';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const releaseRunner = local.runner('release-box').slots(2);

const subscription = claudeCode.subscription('claude-subscription', { token: H.env('CLAUDE_SUBSCRIPTION') });
const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const sessionPool = H.pool('session-pool').accounts(subscription);
const batchPool = H.pool('batch-pool').accounts(apiAccount);

const reviewerModel = claudeCode.model('opus-session', { id: 'claude-opus-4' });
const summaryModel = anthropic.model('haiku-batch', { id: 'claude-haiku-4' });

const releaseAttrs = z.object({
  version: z.string(),
  channel: z.string(),
  platforms: z.array(z.enum(['macos', 'linux', 'windows'])),
});

const Queued = H.state('Queued', 'pending');
const Building = H.state('Building', 'active');
const Announcing = H.state('Announcing', 'active');
const Reviewing = H.state('Reviewing', 'active');
const AwaitingApproval = H.state('AwaitingApproval', 'waiting');
const Summarizing = H.state('Summarizing', 'active');
const Smoking = H.state('Smoking', 'waiting');
const Released = H.terminal('Released', 'success');
const SmokeFailed = H.terminal('SmokeFailed', 'failure');
const Rejected = H.terminal('Rejected', 'neutral');
const Broken = H.terminal('Broken', 'failure');
const Abandoned = H.terminal('Abandoned', 'neutral');

const Release = H.kind('Release')
  .attributes(releaseAttrs)
  .states(Queued, Building, Announcing, Reviewing, AwaitingApproval, Summarizing, Smoking, Released, SmokeFailed, Rejected, Broken, Abandoned)
  .key(release => release.version)
  .initial(Queued)
  .onCancelled(Abandoned);

const smokeAttrs = z.object({ version: z.string(), platform: z.string() });

const SmokeQueued = H.state('SmokeQueued', 'pending');
const SmokeRunning = H.state('SmokeRunning', 'active');
const Passed = H.terminal('Passed', 'success');
const Failed = H.terminal('Failed', 'failure');

const Smoke = H.kind('Smoke')
  .attributes(smokeAttrs)
  .states(SmokeQueued, SmokeRunning, Passed, Failed)
  .key(smoke => `${smoke.version}/${smoke.platform}`)
  .initial(SmokeQueued)
  .onAttemptFailed(Failed);

const smokeTest = H.command('smoke-test')
  .input(smokeAttrs)
  .argv(input => ['./scripts/smoke', input.version, input.platform])
  .runner(releaseRunner);

const smokeFlow = H.flow('smoke')
  .input(smokeAttrs)
  .step('run', smokeTest, ctx => ({ version: ctx.unit.attributes.version, platform: ctx.unit.attributes.platform }), { afterCrash: 'rerun' })
  .exit('passed');

const smoke = H.lane('smoke', Smoke)
  .store(sqlite.store({ path: 'state/units.sqlite' }))
  .handler(smokeFlow, { exits: { passed: Passed }, during: { run: SmokeRunning } });

const build = H.command('build-release')
  .input(z.object({ version: z.string() }))
  .argv(input => ['make', 'release', `VERSION=${input.version}`])
  .runner(releaseRunner);

const announcement = z.object({ version: z.string(), channel: z.string() });

const announce = H.command('announce-release')
  .input(announcement)
  .argv(input => ['./scripts/announce', input.channel, input.version])
  .runner(releaseRunner);

const announcementPosted = H.command('announcement-posted')
  .input(announcement)
  .argv(input => ['./scripts/announced', input.channel, input.version])
  .output(z.boolean())
  .runner(releaseRunner);

const releaseReviewerRole = H.role('release-reviewer')
  .intents('read', 'search')
  .instructions('Review the release diff and build log. Report blocking risks.');

const releaseSummarizerRole = H.role('release-summarizer')
  .intents('read')
  .instructions('Write the public release notes from the review.');

const reviewer = H.agent('release-reviewer')
  .role(releaseReviewerRole)
  .model(reviewerModel)
  .pool(sessionPool)
  .output(z.object({ risks: z.array(z.string()), notes: z.string() }));

const summarizer = H.agent('release-summarizer')
  .role(releaseSummarizerRole)
  .model(summaryModel)
  .pool(batchPool);

const shipRelease = H.flow('ship-release')
  .input(releaseAttrs)
  .step('build', build, ctx => ({ version: ctx.unit.attributes.version }), { afterCrash: 'rerun' })
  .step(
    'announce',
    announce,
    ctx => ({ version: ctx.unit.attributes.version, channel: ctx.unit.attributes.channel }),
    { afterCrash: 'park', alreadyDone: announcementPosted },
  )
  .step('review', reviewer, ctx => ({
    task: `Review release ${ctx.unit.attributes.version}. Build log:\n${ctx.steps.build.stdout}`,
  }), { afterCrash: 'askDriver' })
  .halt('approval', {
    ask: ctx => `Approve ${ctx.unit.attributes.version}? Risks: ${ctx.steps.review.risks.join('; ') || 'none'}`,
    decision: z.object({ approved: z.boolean(), note: z.string() }),
  })
  .exit('rejected', ctx => !ctx.steps.approval.approved)
  .step('summarize', summarizer.batch(), ctx => [{
    task: `Release notes for ${ctx.unit.attributes.version}:\n${ctx.steps.review.notes}`,
  }])
  .spawn('smoke', smoke, ctx => ctx.unit.attributes.platforms.map(platform => ({
    version: ctx.unit.attributes.version,
    platform,
  })))
  .exit('released', ctx => ctx.steps.smoke.every(child => child.verdict === 'success'))
  .exit('smokeFailed');

const releases = H.lane('releases', Release)
  .supply(H.operator)
  .store(sqlite.store({ path: 'state/units.sqlite' }))
  .handler(shipRelease, {
    exits: { rejected: Rejected, released: Released, smokeFailed: SmokeFailed },
    during: {
      build: Building,
      announce: Announcing,
      review: Reviewing,
      approval: AwaitingApproval,
      summarize: Summarizing,
      smoke: Smoking,
    },
  })
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 300_000, exhausted: Broken });

export const releaseHarness = H.harness('release')
  .ledger(sqlite.ledger({ path: 'state/release-ledger.sqlite' }))
  .lanes(releases, smoke)
  .scheduler(H.scheduler('release-scheduler').priority(releases, smoke))
  .clients(claudeCode.supervisor('release-desk', {
    grants: [
      H.ops.workRead,
      H.ops.workCreate,
      H.ops.workCancel,
      H.ops.blockersResolve,
      H.ops.attemptsRecover,
      H.ops.telemetryRead,
    ],
  }))
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));
