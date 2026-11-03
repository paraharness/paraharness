import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const platformSchema = z.enum(['linux', 'macos', 'windows']);
const releaseAttrs = z.object({ version: z.string(), platforms: z.array(platformSchema) });
const releaseInput = z.object({ version: z.string() });
const smokeAttrs = z.object({ version: z.string(), platform: platformSchema });

const Requested = H.state('Requested', 'pending');
const Released = H.terminal('Released', 'success');
const ReleaseRejected = H.terminal('ReleaseRejected', 'failure');
const SmokeTestsFailed = H.terminal('SmokeTestsFailed', 'failure');
const ReleaseFailed = H.terminal('ReleaseFailed', 'failure');
const Release = H.kind('Release')
  .attributes(releaseAttrs)
  .states(Requested, Released, ReleaseRejected, SmokeTestsFailed, ReleaseFailed)
  .key(a => a.version)
  .initial(Requested);

const SmokeQueued = H.state('SmokeQueued', 'pending');
const SmokePassed = H.terminal('SmokePassed', 'success');
const SmokeFailed = H.terminal('SmokeFailed', 'failure');
const Smoke = H.kind('Smoke')
  .attributes(smokeAttrs)
  .states(SmokeQueued, SmokePassed, SmokeFailed)
  .key(a => `${a.version}:${a.platform}`)
  .initial(SmokeQueued);

const runner = local.runner('local').slots(3);
const store = sqlite.store({ path: './.harness/units.sqlite' });

const subscription = claudeCode.subscription('release-subscription', {
  token: H.env('CLAUDE_TOKEN'),
  quota: sqlite.quota('release-subscription', { path: './.harness/quota.sqlite' }),
});
const reviewPool = H.pool('review').accounts(subscription);
const sonnet = claudeCode.model('sonnet', { id: 'claude-sonnet-4-5' });

const apiAccount = anthropic.account('release-api', {
  apiKey: H.env('ANTHROPIC_API_KEY'),
  quota: sqlite.quota('release-api', { path: './.harness/api-quota.sqlite' }),
});
const batchPool = H.pool('batch').accounts(apiAccount);
const batchSonnet = anthropic.model('batch-sonnet', { id: 'claude-sonnet-4-5' });

const reviewerRole = H.role('release-reviewer').intents('read').instructions('Review the release diff and changelog for risk.');
const summarizerRole = H.role('release-summarizer').intents('read').instructions('Summarize the release for the changelog.');

const reviewer = H.seat('release-reviewer').role(reviewerRole).model(sonnet).pool(reviewPool)
  .output(z.object({ approve: z.boolean(), concerns: z.array(z.string()) }));
const summarizer = H.seat('release-summarizer').role(summarizerRole).model(batchSonnet).pool(batchPool)
  .output(z.object({ summary: z.string() }));
const summarizeBatch = H.batch('release-summary', summarizer);

const build = H.command('build').input(releaseInput).argv(i => ['make', 'release', `VERSION=${i.version}`]).runner(runner);
const announce = H.command('announce').input(releaseInput).argv(i => ['./release/announce.sh', i.version]).runner(runner);
const announcedAlready = H.command('announced-already')
  .input(releaseInput)
  .argv(i => ['./release/announced.sh', i.version])
  .output(z.boolean())
  .runner(runner);
const smokeTest = H.command('smoke-test')
  .input(smokeAttrs)
  .argv(i => ['./release/smoke.sh', i.version, i.platform])
  .acceptExitCodes(0, 1)
  .runner(runner);

const releaseApproval = H.halt('release-approval').decision(z.object({ approved: z.boolean(), note: z.string() }));

const smokeFlow = H.flow('smoke')
  .input(smokeAttrs)
  .step('smoke', smokeTest, ctx => ({ version: ctx.unit.attributes.version, platform: ctx.unit.attributes.platform }), { afterCrash: 'rerun' })
  .exit('passed', ctx => ctx.steps.smoke.exitCode === 0)
  .exit('failed');

const smoke = H.lane('smoke', Smoke)
  .store(store)
  .handler(smokeFlow, { exits: { passed: SmokePassed, failed: SmokeFailed } })
  .retry({ maxAttempts: 2, backoff: 'fixed', initialDelayMs: 60_000, exhausted: SmokeFailed });

const releaseFlow = H.flow('release')
  .input(releaseAttrs)
  .step('build', build, ctx => ({ version: ctx.unit.attributes.version }), { afterCrash: 'rerun' })
  .step('announce', announce, ctx => ({ version: ctx.unit.attributes.version }), { afterCrash: 'park', alreadyDone: announcedAlready })
  .step('review', reviewer, ctx => ({ task: `Review release ${ctx.unit.attributes.version}. Build output:\n${ctx.steps.build.stdout}` }), { afterCrash: 'askDriver' })
  .halt('approval', releaseApproval, {
    ask: ctx => `Ship ${ctx.unit.attributes.version}? Reviewer concerns: ${ctx.steps.review.concerns.join('; ') || 'none'}`,
  })
  .exit('rejected', ctx => !ctx.steps.approval.approved)
  .job('summarize', summarizeBatch, ctx => [{ task: `Summarize release ${ctx.unit.attributes.version} for the changelog.\n${ctx.steps.build.stdout}` }])
  .spawn('smoke', smoke, ctx => ctx.unit.attributes.platforms.map(platform => ({ version: ctx.unit.attributes.version, platform })))
  .exit('released', ctx => ctx.steps.smoke.every(c => c.verdict === 'success'))
  .exit('smokeFailed');

const releases = H.lane('releases', Release)
  .supply(H.operator)
  .store(store)
  .handler(releaseFlow, { exits: { rejected: ReleaseRejected, released: Released, smokeFailed: SmokeTestsFailed } })
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 300_000, exhausted: ReleaseFailed });

const releaseManager = claudeCode.supervisor('release-manager', {
  port: H.slot.port(1),
  grants: [H.ops.workRead, H.ops.workCreate, H.ops.resolve(releaseApproval), H.ops.attemptsRecover, H.ops.telemetryRead],
});

export const releaseHarness = H.harness('release')
  .ledger(sqlite.ledger({ path: './.harness/ledger.sqlite' }))
  .lanes(releases, smoke)
  .scheduler(H.scheduler('release').standard(releases, smoke).wip(releases, 1))
  .clients(releaseManager)
  .observers(markdown.board({ path: './BOARD.md' }), markdown.telemetry({ path: './TELEMETRY.md' }));
