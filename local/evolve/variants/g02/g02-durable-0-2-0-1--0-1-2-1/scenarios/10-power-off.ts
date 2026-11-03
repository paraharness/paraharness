import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const runner = local.runner('release-box');

const Platform = z.enum(['linux', 'macos', 'windows']);
const ReleaseAttrs = z.object({ version: z.string(), channel: z.string(), platforms: z.array(Platform) });
const SmokeAttrs = z.object({ version: z.string(), platform: Platform });

const Requested = H.state('Requested', 'pending');
const Released = H.terminal('Released', 'success');
const ReleaseRejected = H.terminal('ReleaseRejected', 'failure');
const ReleaseSmokeFailed = H.terminal('ReleaseSmokeFailed', 'failure');
const ReleaseFailed = H.terminal('ReleaseFailed', 'failure');
const Release = H.kind('Release')
  .attributes(ReleaseAttrs)
  .states(Requested, Released, ReleaseRejected, ReleaseSmokeFailed, ReleaseFailed)
  .key(a => a.version)
  .initial(Requested);

const SmokeQueued = H.state('SmokeQueued', 'pending');
const SmokePassed = H.terminal('SmokePassed', 'success');
const SmokeFailed = H.terminal('SmokeFailed', 'failure');
const Smoke = H.kind('Smoke')
  .attributes(SmokeAttrs)
  .states(SmokeQueued, SmokePassed, SmokeFailed)
  .key(a => `${a.version}:${a.platform}`)
  .initial(SmokeQueued);

const runSmoke = H.command('run-smoke')
  .input(SmokeAttrs)
  .argv(i => ['./bin/smoke', i.version, i.platform])
  .runner(runner);

const smokeFlow = H.flow('smoke')
  .input(SmokeAttrs)
  .step('smoke', runSmoke, ctx => ({ version: ctx.unit.attributes.version, platform: ctx.unit.attributes.platform }), { afterCrash: 'rerun' })
  .exit('passed');

const smokeLane = H.lane('smoke', Smoke)
  .handler(smokeFlow, { exits: { passed: SmokePassed } })
  .store(sqlite.store({ path: './release/store.sqlite' }))
  .retry({ maxAttempts: 2, exhausted: SmokeFailed });

const VersionInput = z.object({ version: z.string() });
const AnnounceInput = z.object({ version: z.string(), channel: z.string() });

const build = H.command('build').input(VersionInput).argv(i => ['make', 'release', `VERSION=${i.version}`]).runner(runner);
const announce = H.command('announce').input(AnnounceInput).argv(i => ['./bin/post', i.channel, `Releasing ${i.version}`]).runner(runner);
const announcePosted = H.command('announce-posted')
  .input(AnnounceInput)
  .argv(i => ['./bin/posted', i.channel, i.version])
  .output(z.boolean())
  .runner(runner);

const subscription = claudeCode.subscription('release-max', {
  token: H.env('CLAUDE_TOKEN'),
  quota: sqlite.quota('release-subscription', { path: './release/quota.sqlite' }),
});
const apiAccount = anthropic.account('release-api', {
  apiKey: H.env('ANTHROPIC_API_KEY'),
  quota: sqlite.quota('release-api', { path: './release/quota.sqlite' }),
});
const opus = claudeCode.model('opus', { id: 'claude-opus-4-1' });
const haikuBatch = anthropic.model('haiku', { id: 'claude-haiku-4-5' });

const reviewerRole = H.role('release-reviewer').intents('read', 'run').instructions('Review the diff and notes; list concerns.');
const summarizerRole = H.role('release-summarizer').intents('read').instructions('Write the release summary for users.');

const reviewer = H.seat('reviewer')
  .role(reviewerRole)
  .model(opus)
  .pool(H.pool('review').accounts(subscription))
  .runner(runner)
  .output(z.object({ verdict: z.string(), concerns: z.array(z.string()) }));
const summarizer = H.seat('summarizer')
  .role(summarizerRole)
  .model(haikuBatch)
  .pool(H.pool('batch').accounts(apiAccount));

const releaseApproval = H.halt('release-approval').decision(z.object({ approved: z.boolean(), note: z.string() }));

const releaseFlow = H.flow('release')
  .input(ReleaseAttrs)
  .step('build', build, ctx => ({ version: ctx.unit.attributes.version }), { afterCrash: 'rerun' })
  .step('announce', announce, ctx => ({ version: ctx.unit.attributes.version, channel: ctx.unit.attributes.channel }), {
    afterCrash: 'park',
    alreadyDone: announcePosted,
  })
  .step('review', reviewer, ctx => ({ task: `Review release ${ctx.unit.attributes.version}.` }), { afterCrash: 'askDriver' })
  .halt('approval', releaseApproval, {
    ask: ctx => `Ship ${ctx.unit.attributes.version}? Reviewer: ${ctx.steps.review.verdict}\n${ctx.steps.review.concerns.join('\n')}`,
  })
  .exit('rejected', ctx => ctx.steps.approval.approved === false)
  .job('summarize', H.batch(summarizer), ctx => ctx.unit.attributes.platforms.map(platform => ({
    task: `Summarize release ${ctx.unit.attributes.version} for ${platform} users. Review notes: ${ctx.steps.review.verdict}`,
  })))
  .spawn('smoke', smokeLane, ctx => ctx.unit.attributes.platforms.map(platform => ({ version: ctx.unit.attributes.version, platform })))
  .exit('released', ctx => ctx.steps.smoke.every(child => child.verdict === 'success'))
  .exit('smokeFailed');

const releaseLane = H.lane('releases', Release)
  .supply(H.operator)
  .handler(releaseFlow, { exits: { rejected: ReleaseRejected, released: Released, smokeFailed: ReleaseSmokeFailed } })
  .store(sqlite.store({ path: './release/store.sqlite' }))
  .retry({ maxAttempts: 1, exhausted: ReleaseFailed });

const supervisor = claudeCode.supervisor('release-manager', {
  port: H.slot.port(1),
  grants: [H.ops.workRead, H.ops.workCreate, H.ops.workCancel, H.ops.attemptsRecover, H.ops.resolve(releaseApproval), H.ops.telemetryRead],
});

export const harness = H.harness('release')
  .ledger(sqlite.ledger({ path: './release/ledger.sqlite' }))
  .lanes(releaseLane, smokeLane)
  .scheduler(H.scheduler('release').standard(releaseLane, smokeLane))
  .clients(supervisor)
  .observers(markdown.board({ path: './release/BOARD.md' }), markdown.telemetry({ path: './release/TELEMETRY.md' }));
