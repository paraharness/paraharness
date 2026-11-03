import { H } from 'harness-dsl';
import { z } from 'zod';
import { sqlite } from 'harness-dsl/sqlite';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const runner = local.runner('release-runner').slots(4);

const subscription = claudeCode.subscription('release-subscription', {
  token: H.env('CLAUDE_RELEASE_TOKEN'),
  quota: sqlite.quota('release-subscription', { path: './.harness/quota.sqlite' }),
});
const apiAccount = anthropic.account('release-api', {
  apiKey: H.env('ANTHROPIC_API_KEY'),
  quota: sqlite.quota('release-api', { path: './.harness/quota.sqlite' }),
});

const reviewer = H.seat('release-reviewer')
  .role(H.role('release-reviewer').intents('read', 'search'))
  .model(claudeCode.model('opus', { id: 'claude-opus-4-1' }))
  .pool(H.pool('review-pool').accounts(subscription));

const summarizer = H.seat('release-summarizer')
  .role(H.role('release-summarizer').intents('read'))
  .model(anthropic.model('haiku', { id: 'claude-haiku-4-5' }))
  .pool(H.pool('batch-pool').accounts(apiAccount));

const releaseAttrs = z.object({ version: z.string(), channel: z.string() });
const announceInput = z.object({ version: z.string(), channel: z.string() });

const Requested = H.state('Requested', 'pending');
const Released = H.terminal('Released', 'success');
const Rejected = H.terminal('Rejected', 'failure');
const SmokeFailed = H.terminal('SmokeFailed', 'failure');
const Abandoned = H.terminal('Abandoned', 'failure');

const Release = H.kind('Release')
  .attributes(releaseAttrs)
  .states(Requested, Released, Rejected, SmokeFailed, Abandoned)
  .key(a => a.version)
  .initial(Requested);

const smokeAttrs = z.object({ version: z.string(), platform: z.string() });
const SmokeQueued = H.state('SmokeQueued', 'pending');
const SmokePassed = H.terminal('SmokePassed', 'success');
const SmokeBroken = H.terminal('SmokeBroken', 'failure');

const Smoke = H.kind('Smoke')
  .attributes(smokeAttrs)
  .states(SmokeQueued, SmokePassed, SmokeBroken)
  .key(a => `${a.version}/${a.platform}`)
  .initial(SmokeQueued);

const build = H.command('build')
  .input(z.object({ version: z.string() }))
  .argv(i => ['make', 'release', `VERSION=${i.version}`])
  .runner(runner);

const announce = H.command('announce').input(announceInput).argv(i => ['./release/announce', i.channel, i.version]).runner(runner);

const announcementPosted = H.command('announcement-posted')
  .input(announceInput)
  .argv(i => ['./release/announced', i.channel, i.version])
  .output(z.boolean())
  .runner(runner);

const smokeTest = H.command('smoke-test')
  .input(smokeAttrs)
  .argv(i => ['./release/smoke', i.platform, i.version])
  .runner(runner);

const releaseApproval = H.halt('release-approval').decision(z.object({ approve: z.boolean(), note: z.string() }));

const smokeFlow = H.flow('smoke')
  .input(smokeAttrs)
  .step('smoke', smokeTest, ctx => ctx.unit.attributes, { afterCrash: 'rerun' })
  .exit('passed');

const smoke = H.lane('smoke', Smoke)
  .store(sqlite.store({ path: './.harness/units.sqlite' }))
  .handler(smokeFlow, {
    ends: { passed: SmokePassed },
    retry: { maxAttempts: 2, backoff: 'fixed', initialDelayMs: 60_000, exhausted: SmokeBroken },
  });

const platforms = ['linux', 'macos', 'windows'];

const releaseFlow = H.flow('release')
  .input(releaseAttrs)
  .step('build', build, ctx => ({ version: ctx.unit.attributes.version }), { afterCrash: 'rerun' })
  .step('announce', announce, ctx => ({ version: ctx.unit.attributes.version, channel: ctx.unit.attributes.channel }), {
    afterCrash: 'park',
    alreadyDone: announcementPosted,
  })
  .step('review', reviewer, ctx => ({ task: `Review release ${ctx.unit.attributes.version} for regressions.` }), {
    afterCrash: 'askDriver',
  })
  .halt('approval', releaseApproval, { ask: ctx => `Ship ${ctx.unit.attributes.version}?\n\n${ctx.steps.review}` })
  .exit('rejected', ctx => !ctx.steps.approval.approve)
  .job('summarize', summarizer.batch(), ctx => [
    { task: `Summarize release ${ctx.unit.attributes.version} for the changelog. Review notes:\n${ctx.steps.review}` },
  ])
  .spawn('smoke', smoke, ctx => platforms.map(platform => ({ version: ctx.unit.attributes.version, platform })))
  .exit('released', ctx => ctx.steps.smoke.every(child => child.verdict === 'success'))
  .exit('smokeFailed');

const releases = H.lane('releases', Release)
  .supply(H.operator)
  .store(sqlite.store({ path: './.harness/units.sqlite' }))
  .handler(releaseFlow, {
    ends: { rejected: Rejected, released: Released, smokeFailed: SmokeFailed },
    retry: { maxAttempts: 2, backoff: 'exponential', initialDelayMs: 300_000, exhausted: Abandoned },
  });

const releaseManager = claudeCode.supervisor('release-manager').client('release-control', {
  port: H.slot.port(1),
  grants: [H.ops.workRead, H.ops.workCreate, H.ops.attemptsRecover, H.ops.resolve(releaseApproval), H.ops.telemetryRead],
});

export const harness = H.harness('release')
  .ledger(sqlite.ledger({ path: './.harness/ledger.sqlite' }))
  .lanes(releases, smoke)
  .scheduler(H.scheduler('release-scheduler').priority(smoke, releases).wip(releases, 1))
  .clients(releaseManager)
  .observers(markdown.board({ path: './.harness/board.md' }));
