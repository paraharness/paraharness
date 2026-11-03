import { z } from 'zod';
import { H } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';
import { sqlite } from 'harness-dsl/sqlite';
import { webhook } from 'harness-dsl/webhook';

const releaseRunner = local.runner('release-local').slots(2);
const store = sqlite.store({ path: 'release/units.sqlite' });

const reviewModel = claudeCode.model('release-reviewer-model', { id: 'claude-opus-4-1' });
const summaryModel = anthropic.model('release-summary-model', { id: 'claude-sonnet-4-5' });

const releaseSubscription = claudeCode.subscription('release-max', { token: H.env('CLAUDE_MAX_TOKEN') });
const releaseApi = anthropic.account('release-api', { apiKey: H.env('ANTHROPIC_API_KEY') });

const reviewPool = H.pool('release-review').accounts(releaseSubscription).serves(reviewModel);
const batchPool = H.pool('release-batch').accounts(releaseApi).serves(summaryModel);

const smoke = z.object({ version: z.string(), platform: z.string() });

const SmokeQueued = H.state('smoke-queued', 'pending');
const SmokePassed = H.terminal('smoke-passed', 'success');
const SmokeFailed = H.terminal('smoke-failed', 'failure');
const SmokeWithdrawn = H.terminal('smoke-withdrawn', 'neutral');

const Smoke = H.kind('Smoke')
  .attributes(smoke)
  .states(SmokeQueued, SmokePassed, SmokeFailed, SmokeWithdrawn)
  .key(s => `${s.version}:${s.platform}`)
  .initial(SmokeQueued)
  .onCancelled(SmokeWithdrawn);

const SmokeReported = H.signal('smoke-reported').payload(z.object({ passed: z.boolean(), log: z.string() }));

const dispatchSmoke = H.command('dispatch-smoke')
  .input(smoke)
  .argv(target => ['ci-dispatch', 'smoke', '--version', target.version, '--platform', target.platform])
  .env({ CI_TOKEN: H.env('CI_TOKEN') })
  .runner(releaseRunner);

const smokeFlow = H.flow('smoke')
  .input(smoke)
  .step('dispatch', dispatchSmoke, ctx => ctx.unit.attributes, {
    afterCrash: 'rerun',
    retry: H.retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 30_000 }),
  })
  .await('result', SmokeReported)
  .exit('passed', ctx => ctx.steps.result.passed)
  .exit('failed');

const smokes = H.lane('smoke', Smoke)
  .supply(
    webhook.json('ci-results', {
      port: H.slot.port(0),
      path: '/ci-results',
      secret: H.env('CI_WEBHOOK_SECRET'),
      payload: z.object({ version: z.string(), platform: z.string(), passed: z.boolean(), log: z.string() }),
    }),
    (result, to) =>
      to.signal(SmokeReported, `${result.version}:${result.platform}`, { passed: result.passed, log: result.log }),
  )
  .store(store)
  .handler(smokeFlow, { exits: { passed: SmokePassed, failed: SmokeFailed } });

const release = z.object({ version: z.string(), platforms: z.array(z.string()) });
const releaseRef = z.object({ version: z.string() });

const Requested = H.state('requested', 'pending');
const Released = H.terminal('released', 'success');
const ReleaseRejected = H.terminal('release-rejected', 'neutral');
const Regressed = H.terminal('regressed', 'failure');
const ReleaseWithdrawn = H.terminal('release-withdrawn', 'neutral');

const Release = H.kind('Release')
  .attributes(release)
  .states(Requested, Released, ReleaseRejected, Regressed, ReleaseWithdrawn)
  .key(r => r.version)
  .initial(Requested)
  .onCancelled(ReleaseWithdrawn);

const build = H.command('build')
  .input(releaseRef)
  .argv(target => ['make', 'release', `VERSION=${target.version}`])
  .runner(releaseRunner);

const announce = H.command('announce')
  .input(releaseRef)
  .argv(target => ['post-announcement', '--channel', 'releases', '--version', target.version])
  .env({ CHANNEL_TOKEN: H.env('CHANNEL_TOKEN') })
  .runner(releaseRunner);

const announcementPosted = H.command('announcement-posted')
  .input(releaseRef)
  .argv(target => ['find-announcement', '--channel', 'releases', '--version', target.version])
  .env({ CHANNEL_TOKEN: H.env('CHANNEL_TOKEN') })
  .output(z.boolean())
  .runner(releaseRunner);

const releaseReviewer = H.role('release-reviewer')
  .intents('read', 'search')
  .instructions('Review the release diff and changelog. Rate the risk and say why.');
const releaseSummarizer = H.role('release-summarizer')
  .intents('read')
  .instructions('Write the release notes summary for customers.');

const reviewer = H.agent('release-reviewer')
  .role(releaseReviewer)
  .model(reviewModel)
  .output(z.object({ risk: z.enum(['low', 'medium', 'high']), notes: z.string() }));

const summarizer = H.agent('release-summarizer').role(releaseSummarizer).model(summaryModel);

const releaseFlow = H.flow('release')
  .input(release)
  .step('build', build, ctx => ({ version: ctx.unit.attributes.version }), {
    afterCrash: 'rerun',
    retry: H.retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 60_000 }),
  })
  .step('announce', announce, ctx => ({ version: ctx.unit.attributes.version }), {
    afterCrash: 'park',
    alreadyDone: announcementPosted,
  })
  .step('review', reviewer, ctx => ({ task: `Review release ${ctx.unit.attributes.version}.` }), {
    afterCrash: 'askDriver',
  })
  .halt('approval', z.object({ approved: z.boolean(), note: z.string() }), {
    ask: ctx =>
      `Approve release ${ctx.unit.attributes.version}? Review risk: ${ctx.steps.review.risk}.\n\n${ctx.steps.review.notes}`,
  })
  .exit('rejected', ctx => !ctx.steps.approval.approved)
  .step('summarize', summarizer.batch(), ctx => [
    { task: `Summarise release ${ctx.unit.attributes.version} for customers. Reviewer notes: ${ctx.steps.review.notes}` },
  ])
  .spawn('smoke', smokes, ctx =>
    ctx.unit.attributes.platforms.map(platform => ({ version: ctx.unit.attributes.version, platform })),
  )
  .exit('released', ctx => ctx.steps.smoke.every(child => child.verdict === 'success'))
  .exit('smokeFailed');

const releases = H.lane('releases', Release)
  .supply(H.operator)
  .store(store)
  .handler(releaseFlow, {
    exits: { rejected: ReleaseRejected, released: Released, smokeFailed: Regressed },
  });

export default H.harness('release')
  .ledger(sqlite.ledger({ path: 'release/ledger.sqlite' }))
  .pools(reviewPool, batchPool)
  .lanes(releases, smokes)
  .scheduler(H.scheduler('release').priority(releases, smokes))
  .clients(
    claudeCode.supervisor('release-desk', {
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
  .observers(markdown.board({ path: 'release/BOARD.md' }), markdown.telemetry({ path: 'release/TELEMETRY.md' }));
