import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const localRunner = local.runner('local').slots(2);
const harnessStore = sqlite.store({ path: '.harness/units.sqlite' });

const quota = sqlite.quota('release-quota', { path: '.harness/quota.sqlite' });
const subscription = claudeCode.subscription('claude-max', { token: H.env('CLAUDE_MAX_TOKEN'), quota });
const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });

const reviewModel = claudeCode.model('opus', { id: 'claude-opus-4-1' });
const batchModel = anthropic.model('haiku', { id: 'claude-haiku-4-5' });

const sessionPool = H.pool('release-pool').accounts(subscription).fallback(apiAccount);
const batchPool = H.pool('batch-pool').accounts(apiAccount);

const reviewerRole = H.role('release-reviewer').intents('read', 'run').instructions('Review the release build and list risks.');
const writerRole = H.role('release-notes-writer').intents('read').instructions('Write concise release notes.');

const reviewer = H.seat('reviewer')
  .role(reviewerRole)
  .model(reviewModel)
  .pool(sessionPool)
  .output(z.object({ approve: z.boolean(), notes: z.string() }));

const summarizer = H.seat('summarizer')
  .role(writerRole)
  .model(batchModel)
  .pool(batchPool)
  .output(z.object({ notes: z.string() }));

const platform = z.enum(['linux', 'macos', 'windows']);
const smokeSchema = z.object({ version: z.string(), platform });

const SmokeQueued = H.state('SmokeQueued', 'pending');
const SmokePassed = H.terminal('SmokePassed', 'success');
const SmokeFailed = H.terminal('SmokeFailed', 'failure');

const smokeKind = H.kind('Smoke')
  .attributes(smokeSchema)
  .states(SmokeQueued, SmokePassed, SmokeFailed)
  .key(a => `${a.version}:${a.platform}`)
  .initial(SmokeQueued);

const smokeTest = H.command('smoke-test')
  .input(smokeSchema)
  .argv(input => ['ci', 'smoke', input.version, input.platform])
  .runner(localRunner);

const runSmoke = H.flow('run-smoke')
  .input(smokeSchema)
  .step('smoke', smokeTest, ctx => ({ version: ctx.unit.attributes.version, platform: ctx.unit.attributes.platform }), { afterCrash: 'rerun' })
  .exit('passed');

const smoke = H.lane('smoke', smokeKind)
  .handler(runSmoke, { exits: { passed: SmokePassed } })
  .store(harnessStore)
  .retry({ maxAttempts: 2, exhausted: SmokeFailed });

const releaseSchema = z.object({ version: z.string(), channel: z.string() });

const ReleaseRequested = H.state('ReleaseRequested', 'pending');
const Released = H.terminal('Released', 'success');
const ReleaseRejected = H.terminal('ReleaseRejected', 'failure');
const SmokeBroken = H.terminal('SmokeBroken', 'failure');
const ReleaseFailed = H.terminal('ReleaseFailed', 'failure');

const release = H.kind('Release')
  .attributes(releaseSchema)
  .states(ReleaseRequested, Released, ReleaseRejected, SmokeBroken, ReleaseFailed)
  .key(a => a.version)
  .initial(ReleaseRequested);

const build = H.command('build')
  .input(z.object({ version: z.string() }))
  .argv(input => ['make', 'release', `VERSION=${input.version}`])
  .runner(localRunner);

const announce = H.command('announce')
  .input(z.object({ version: z.string(), channel: z.string() }))
  .argv(input => ['chat-post', input.channel, `Release ${input.version} is in review`])
  .runner(localRunner);

const announced = H.command('announced')
  .input(z.object({ version: z.string(), channel: z.string() }))
  .argv(input => ['chat-search', input.channel, `Release ${input.version} is in review`])
  .output(z.boolean())
  .runner(localRunner);

const releaseApproval = H.halt('release-approval').decision(z.object({ approve: z.boolean(), note: z.string() }));

const ship = H.flow('ship')
  .input(releaseSchema)
  .step('build', build, ctx => ({ version: ctx.unit.attributes.version }), { afterCrash: 'rerun' })
  .step('announce', announce, ctx => ({ version: ctx.unit.attributes.version, channel: ctx.unit.attributes.channel }), {
    afterCrash: 'park',
    alreadyDone: announced,
  })
  .step('review', reviewer, ctx => ({
    task: `Review release ${ctx.unit.attributes.version}. Build log:\n${ctx.steps.build.stdout}`,
  }), { afterCrash: 'askDriver' })
  .halt('approval', releaseApproval, {
    ask: ctx => `Ship ${ctx.unit.attributes.version}? Reviewer: ${ctx.steps.review.notes}`,
  })
  .exit('rejected', ctx => !ctx.steps.approval.approve)
  .job('summarize', H.batch(summarizer), ctx => [{
    task: `Write release notes for ${ctx.unit.attributes.version}. Review notes: ${ctx.steps.review.notes}`,
  }])
  .spawn('smoke', smoke, ctx => platform.options.map(p => ({ version: ctx.unit.attributes.version, platform: p })))
  .exit('released', ctx => ctx.steps.smoke.every(child => child.verdict === 'success'))
  .exit('smokeFailed');

const releases = H.lane('releases', release)
  .supply(H.operator)
  .handler(ship, { exits: { rejected: ReleaseRejected, released: Released, smokeFailed: SmokeBroken } })
  .store(harnessStore)
  .retry({ maxAttempts: 1, exhausted: ReleaseFailed });

const releaseManager = claudeCode.supervisor('release-manager', {
  grants: [
    H.ops.workRead,
    H.ops.workCreate,
    H.ops.resolve(releaseApproval),
    H.ops.attemptsRecover,
    H.ops.telemetryRead,
  ],
  port: H.slot.port(1),
});

export const releaseHarness = H.harness('release')
  .ledger(sqlite.ledger({ path: '.harness/ledger.sqlite' }))
  .lanes(releases, smoke)
  .scheduler(H.scheduler('release').standard(releases, smoke).wip(releases, 1).wip(smoke, 3))
  .clients(releaseManager)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));
