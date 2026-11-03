import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const quota = sqlite.quota('release-quota', { path: './.harness/quota.sqlite' });
const subscription = claudeCode.subscription('release-subscription', { token: H.env('CLAUDE_TOKEN'), quota });
const api = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });
const reviewModel = claudeCode.model('opus', { id: 'claude-opus-4-1' });
const batchModel = anthropic.model('haiku-batch', { id: 'claude-haiku-4-5' });
const sessionPool = H.pool('session-pool').accounts(subscription);
const batchPool = H.pool('batch-pool').accounts(api);
const localRunner = local.runner('local').slots(2);

const platform = z.enum(['linux', 'macos', 'windows']);

const releaseAttrs = z.object({ version: z.string(), channel: z.string() });
const smokeAttrs = z.object({ version: z.string(), platform });

const Requested = H.state('requested', 'pending');
const Released = H.terminal('released', 'success');
const SmokeFailed = H.terminal('smoke-failed', 'failure');
const Rejected = H.terminal('rejected', 'failure');
const Abandoned = H.terminal('abandoned', 'failure');

const release = H.kind('Release')
  .attributes(releaseAttrs)
  .states(Requested, Released, SmokeFailed, Rejected, Abandoned)
  .key(a => a.version)
  .initial(Requested);

const SmokeQueued = H.state('smoke-queued', 'pending');
const SmokePassed = H.terminal('smoke-passed', 'success');
const SmokeBroken = H.terminal('smoke-broken', 'failure');

const smoke = H.kind('Smoke')
  .attributes(smokeAttrs)
  .states(SmokeQueued, SmokePassed, SmokeBroken)
  .key(a => `${a.version}:${a.platform}`)
  .initial(SmokeQueued);

const smokeTest = H.command('smoke-test')
  .input(smokeAttrs)
  .argv(i => ['make', 'smoke', `VERSION=${i.version}`, `PLATFORM=${i.platform}`])
  .runner(localRunner);

const runSmoke = H.flow('run-smoke')
  .input(smokeAttrs)
  .step('smoke', smokeTest, ctx => ({ version: ctx.unit.attributes.version, platform: ctx.unit.attributes.platform }), { afterCrash: 'rerun' })
  .exit('passed');

const smokes = H.lane('smoke', smoke)
  .store(sqlite.store({ path: './.harness/units.sqlite' }))
  .handler(runSmoke, { exits: { passed: SmokePassed } })
  .retry({ maxAttempts: 2, exhausted: SmokeBroken });

const versionInput = z.object({ version: z.string() });
const announceInput = z.object({ version: z.string(), channel: z.string() });

const build = H.command('build')
  .input(versionInput)
  .argv(i => ['make', 'release', `VERSION=${i.version}`])
  .runner(localRunner);

const announce = H.command('announce')
  .input(announceInput)
  .argv(i => ['release-bot', 'post', i.channel, `Releasing ${i.version}`])
  .runner(localRunner);

const announcementPosted = H.command('announcement-posted')
  .input(announceInput)
  .argv(i => ['release-bot', 'has-post', i.channel, i.version])
  .output(z.boolean())
  .runner(localRunner);

const reviewerRole = H.role('release-reviewer').intents('read', 'search').instructions('Review the release for risk.');
const notesRole = H.role('release-notes').intents('read').instructions('Summarize the release for the changelog.');

const reviewer = H.seat('release-reviewer').role(reviewerRole).model(reviewModel).pool(sessionPool);
const summarizer = H.seat('release-summarizer').role(notesRole).model(batchModel).pool(batchPool);

const approvalHalt = H.halt('release-approval').decision(z.object({ approve: z.boolean(), note: z.string() }));

const releaseFlow = H.flow('release')
  .input(releaseAttrs)
  .step('build', build, ctx => ({ version: ctx.unit.attributes.version }), { afterCrash: 'rerun' })
  .step('announce', announce, ctx => ({ version: ctx.unit.attributes.version, channel: ctx.unit.attributes.channel }), {
    afterCrash: 'park',
    alreadyDone: announcementPosted,
  })
  .step('review', reviewer, ctx => ({ task: `Review release ${ctx.unit.attributes.version}. Build log:\n${ctx.steps.build.stdout}` }), {
    afterCrash: 'askDriver',
  })
  .halt('approval', approvalHalt, { ask: ctx => `Ship ${ctx.unit.attributes.version}?\n${ctx.steps.review}` })
  .exit('rejected', ctx => !ctx.steps.approval.approve)
  .job('summarize', H.batch(summarizer), ctx => [{ task: `Write the changelog entry for ${ctx.unit.attributes.version}.\n${ctx.steps.review}` }])
  .spawn('smoke', smokes, ctx => platform.options.map(p => ({ version: ctx.unit.attributes.version, platform: p })))
  .exit('released', ctx => ctx.steps.smoke.every(child => child.verdict === 'success'))
  .exit('smokeFailed');

const releases = H.lane('releases', release)
  .supply(H.operator)
  .store(sqlite.store({ path: './.harness/units.sqlite' }))
  .handler(releaseFlow, { exits: { rejected: Rejected, released: Released, smokeFailed: SmokeFailed } })
  .retry({ maxAttempts: 2, backoff: 'fixed', initialDelayMs: 300_000, exhausted: Abandoned });

const releaseManager = claudeCode.supervisor('release-manager', {
  port: H.slot.port(1),
  grants: [H.ops.workRead, H.ops.workCreate, H.ops.resolve(approvalHalt), H.ops.attemptsRecover, H.ops.telemetryRead],
});

void H.harness('release')
  .ledger(sqlite.ledger({ path: './.harness/ledger.sqlite' }))
  .lanes(releases, smokes)
  .scheduler(H.scheduler('release').standard(releases, smokes).wip(smokes, 3))
  .clients(releaseManager)
  .observers(markdown.board({ path: './.harness/board.md' }), markdown.telemetry({ path: './.harness/telemetry.md' }))
  .start();
