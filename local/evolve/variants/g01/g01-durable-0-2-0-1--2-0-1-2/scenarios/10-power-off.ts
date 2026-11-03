import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const quota = sqlite.quota('release-quota', { path: './.harness/quota.sqlite' });
const subscription = claudeCode.subscription('max-1', { token: H.env('CLAUDE_MAX_1_TOKEN'), quota });
const apiAccount = anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });
const opus = claudeCode.model('opus', { id: 'claude-opus-4-1' });
const batchSonnet = anthropic.model('batch-sonnet', { id: 'claude-sonnet-4-5' });
const pool = H.pool('release-pool').accounts(subscription, apiAccount);

const runner = local.runner('local').slots(2);

const platforms = ['linux', 'macos', 'windows'];

const releaseAttrs = z.object({ version: z.string(), channel: z.string() });

const requested = H.state('Requested', 'pending');
const released = H.terminal('Released', 'success');
const smokeFailed = H.terminal('SmokeFailed', 'failure');
const rejected = H.terminal('Rejected', 'neutral');
const abandoned = H.terminal('Abandoned', 'failure');
const withdrawn = H.terminal('Withdrawn', 'neutral');

const release = H.kind('Release')
  .attributes(releaseAttrs)
  .states(requested, released, smokeFailed, rejected, abandoned, withdrawn)
  .key(a => a.version)
  .initial(requested);

const smokeAttrs = z.object({ version: z.string(), platform: z.string() });

const smokeQueued = H.state('Queued', 'pending');
const smokePassed = H.terminal('Passed', 'success');
const smokeBroke = H.terminal('Broke', 'failure');
const smokeDropped = H.terminal('Dropped', 'neutral');

const smoke = H.kind('Smoke')
  .attributes(smokeAttrs)
  .states(smokeQueued, smokePassed, smokeBroke, smokeDropped)
  .key(a => `${a.version}-${a.platform}`)
  .initial(smokeQueued);

const build = H.command('build')
  .input(z.object({ version: z.string() }))
  .argv(input => ['make', 'release', `VERSION=${input.version}`])
  .runner(runner);

const announcement = z.object({ version: z.string(), channel: z.string() });

const announce = H.command('announce')
  .input(announcement)
  .argv(input => ['chat-post', input.channel, `Release ${input.version} is on its way`])
  .runner(runner);

const announced = H.command('announcement-posted')
  .input(announcement)
  .argv(input => ['chat-history', input.channel, '--contains', `Release ${input.version}`])
  .output(z.boolean())
  .runner(runner);

const smokeTest = H.command('smoke-test')
  .input(smokeAttrs)
  .argv(input => ['smoke', input.platform, input.version])
  .runner(runner);

const reviewerRole = H.role('release-reviewer').intents('read', 'search').instructions('Review the release diff and list concerns.');
const summarizerRole = H.role('release-summarizer').intents('read').instructions('Write the release notes summary.');

const reviewSeat = H.seat('release-reviewer')
  .role(reviewerRole)
  .model(opus)
  .pool(pool)
  .output(z.object({ concerns: z.array(z.string()) }));

const summarizerSeat = H.seat('release-summarizer').role(summarizerRole).model(batchSonnet).pool(pool);

const releaseApproval = H.halt('release-approval').decision(z.object({ approved: z.boolean() }));

const smokeFlow = H.flow('smoke')
  .input(smokeAttrs)
  .step('smoke', smokeTest, ctx => ctx.unit.attributes, { afterCrash: 'rerun' })
  .exit('passed');

const smokes = H.lane('smoke', smoke)
  .handler(smokeFlow, { exits: { passed: smokePassed } })
  .store(sqlite.store({ path: './.harness/units.sqlite' }))
  .retry({ maxAttempts: 2, backoff: 'fixed', initialDelayMs: 60000, exhausted: smokeBroke })
  .on(H.cancel, { enter: smokeDropped });

const releaseFlow = H.flow('release')
  .input(releaseAttrs)
  .step('build', build, ctx => ({ version: ctx.unit.attributes.version }), { afterCrash: 'rerun' })
  .step('announce', announce, ctx => ({ version: ctx.unit.attributes.version, channel: ctx.unit.attributes.channel }), {
    afterCrash: 'park',
    alreadyDone: announced,
  })
  .step('review', reviewSeat, ctx => ({ task: `Review release ${ctx.unit.attributes.version}` }), { afterCrash: 'askDriver' })
  .halt('approval', releaseApproval, {
    ask: ctx => `Approve release ${ctx.unit.attributes.version}? Concerns: ${ctx.steps.review.concerns.join('; ') || 'none'}`,
  })
  .exit('rejected', ctx => !ctx.steps.approval.approved)
  .job('summarize', summarizerSeat.batch(), ctx => [
    { task: `Summarise release ${ctx.unit.attributes.version}. Reviewer concerns: ${ctx.steps.review.concerns.join('; ')}` },
  ])
  .spawn('smoke', smokes, ctx => platforms.map(platform => ({ version: ctx.unit.attributes.version, platform })))
  .exit('released', ctx => ctx.steps.smoke.every(child => child.verdict === 'success'))
  .exit('smokeFailed');

const releases = H.lane('releases', release)
  .supply(H.operator)
  .handler(releaseFlow, { exits: { rejected, released, smokeFailed } })
  .store(sqlite.store({ path: './.harness/units.sqlite' }))
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 300000, exhausted: abandoned })
  .on(H.cancel, { enter: withdrawn });

const supervisor = claudeCode.supervisor('release-supervisor', {
  port: H.slot.port(1),
  grants: [
    H.ops.workRead,
    H.ops.workCreate,
    H.ops.workCancel,
    H.ops.attemptsRecover,
    H.ops.resolve(releaseApproval),
    H.ops.telemetryRead,
  ],
});

export const harness = H.harness('release')
  .ledger(sqlite.ledger({ path: './.harness/ledger.sqlite' }))
  .lanes(releases, smokes)
  .scheduler(H.scheduler('release-scheduler').standard(releases, smokes).wip(releases, 1).wip(smokes, 3))
  .clients(supervisor)
  .observers(
    markdown.board({ path: './.harness/board.md' }),
    markdown.telemetry({ path: './.harness/telemetry.md' }),
  );
