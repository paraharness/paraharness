import { H } from 'harness-dsl';
import { z } from 'zod';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';
import { sqlite } from 'harness-dsl/sqlite';

const runner = local.runner('local');

const subscription = claudeCode.subscription('releaseSeat', { token: H.env('CLAUDE_RELEASE_TOKEN') });
const apiAccount = anthropic.account('releaseApi', { apiKey: H.env('ANTHROPIC_API_KEY') });
const opus = claudeCode.model('opus', { id: 'claude-opus-4-1' });
const haiku = anthropic.model('haiku', { id: 'claude-haiku-4-5' });
const sessionPool = H.pool('releaseSessions').accounts(subscription);
const batchPool = H.pool('releaseBatch').accounts(apiAccount);

const SmokeQueued = H.state('SmokeQueued', 'pending');
const SmokeRunning = H.state('SmokeRunning', 'active');
const SmokePassed = H.terminal('SmokePassed', 'success');
const SmokeFailed = H.terminal('SmokeFailed', 'failure');

const smokeAttrs = z.object({ version: z.string(), platform: z.string() });

const Smoke = H.kind('Smoke')
  .attributes(smokeAttrs)
  .states(SmokeQueued, SmokeRunning, SmokePassed, SmokeFailed)
  .key(smoke => `${smoke.version}:${smoke.platform}`)
  .initial(SmokeQueued)
  .onAttemptFailed(SmokeFailed);

const smokeTest = H.command('smokeTest')
  .input(smokeAttrs)
  .argv(input => ['smoke', '--version', input.version, '--platform', input.platform])
  .acceptExitCodes(0, 1)
  .runner(runner);

const smokeFlow = H.flow('smoke')
  .input(smokeAttrs)
  .step('run', smokeTest, ctx => ({ version: ctx.unit.attributes.version, platform: ctx.unit.attributes.platform }), {
    afterCrash: 'rerun',
  })
  .exit('passed', ctx => ctx.steps.run.exitCode === 0)
  .exit('failed');

const smoke = H.lane('smoke', Smoke)
  .handler(smokeFlow, { exits: { passed: SmokePassed, failed: SmokeFailed }, during: { run: SmokeRunning } });

const Requested = H.state('Requested', 'pending');
const Building = H.state('Building', 'active');
const Announcing = H.state('Announcing', 'active');
const UnderReview = H.state('UnderReview', 'active');
const AwaitingApproval = H.state('AwaitingApproval', 'waiting');
const Summarizing = H.state('Summarizing', 'waiting');
const AwaitingSmoke = H.state('AwaitingSmoke', 'waiting');
const Released = H.terminal('Released', 'success');
const ReleaseRejected = H.terminal('ReleaseRejected', 'neutral');
const SmokeRegressed = H.terminal('SmokeRegressed', 'failure');
const ReleaseAbandoned = H.terminal('ReleaseAbandoned', 'failure');

const releaseAttrs = z.object({ version: z.string(), platforms: z.array(z.string()) });

const Release = H.kind('Release')
  .attributes(releaseAttrs)
  .states(Requested, Building, Announcing, UnderReview, AwaitingApproval, Summarizing, AwaitingSmoke, Released, ReleaseRejected, SmokeRegressed, ReleaseAbandoned)
  .key(release => release.version)
  .initial(Requested)
  .onAttemptFailed(ReleaseAbandoned);

const build = H.command('build')
  .input(z.object({ version: z.string() }))
  .argv(input => ['make', 'release', `VERSION=${input.version}`])
  .runner(runner);

const announce = H.command('announce')
  .input(z.object({ version: z.string() }))
  .argv(input => ['release-chat', 'post', `Release ${input.version} is rolling out.`])
  .runner(runner);

const announcementPosted = H.command('announcementPosted')
  .input(z.object({ version: z.string() }))
  .argv(input => ['release-chat', 'has-posted', input.version])
  .output(z.boolean())
  .runner(runner);

const reviewerRole = H.role('releaseReviewer')
  .intents('read', 'search')
  .instructions('Review the release diff and notes. List concrete concerns only.');

const writerRole = H.role('releaseWriter')
  .intents('read')
  .instructions('Write a short public release summary.');

const reviewer = H.agent('releaseReviewer')
  .role(reviewerRole)
  .model(opus)
  .pool(sessionPool)
  .output(z.object({ concerns: z.array(z.string()) }));

const summarizer = H.agent('releaseSummarizer')
  .role(writerRole)
  .model(haiku)
  .pool(batchPool);

const releaseFlow = H.flow('release')
  .input(releaseAttrs)
  .step('build', build, ctx => ({ version: ctx.unit.attributes.version }), {
    afterCrash: 'rerun',
    retry: { maxAttempts: 3, initialDelayMs: 5000 },
  })
  .step('announce', announce, ctx => ({ version: ctx.unit.attributes.version }), {
    afterCrash: 'park',
    alreadyDone: announcementPosted,
  })
  .step('review', reviewer, ctx => ({ task: `Review release ${ctx.unit.attributes.version}.` }), {
    afterCrash: 'askDriver',
  })
  .halt('approval', {
    ask: ctx => `Ship ${ctx.unit.attributes.version}? Concerns: ${ctx.steps.review.concerns.join('; ') || 'none'}`,
    decision: z.object({ approved: z.boolean(), notes: z.string().optional() }),
  })
  .exit('rejected', ctx => !ctx.steps.approval.approved)
  .step('summarize', summarizer.batch(), ctx => [{
    task: `Summarise release ${ctx.unit.attributes.version}. Manager notes: ${ctx.steps.approval.notes ?? 'none'}`,
  }])
  .spawn('smokeTests', smoke, ctx => ctx.unit.attributes.platforms.map(platform => ({
    version: ctx.unit.attributes.version,
    platform,
  })))
  .exit('released', ctx => ctx.steps.smokeTests.every(child => child.verdict === 'success'))
  .exit('smokeFailed');

const releases = H.lane('releases', Release)
  .supply(H.operator)
  .handler(releaseFlow, {
    exits: { rejected: ReleaseRejected, released: Released, smokeFailed: SmokeRegressed },
    during: {
      build: Building,
      announce: Announcing,
      review: UnderReview,
      approval: AwaitingApproval,
      summarize: Summarizing,
      smokeTests: AwaitingSmoke,
    },
  });

const releaseManager = claudeCode.supervisor('releaseManager', {
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
  .ledger(sqlite.ledger({ path: 'release/ledger.db' }))
  .lanes(releases, smoke)
  .scheduler(H.scheduler('releases').priority(releases, smoke))
  .clients(releaseManager)
  .observers(markdown.board({ path: 'release/BOARD.md' }), markdown.telemetry({ path: 'release/TELEMETRY.md' }));
