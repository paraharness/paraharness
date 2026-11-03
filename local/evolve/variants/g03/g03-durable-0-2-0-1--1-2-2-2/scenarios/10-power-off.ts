import { z } from 'zod';
import { H } from 'harness-dsl';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { sqlite } from 'harness-dsl/sqlite';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const subscriptionQuota = sqlite.quota('release-subscription', { path: '/srv/release/quota.sqlite' });
const apiQuota = sqlite.quota('release-api', { path: '/srv/release/quota.sqlite' });

const subscription = claudeCode.subscription('release-max', { token: H.env('CLAUDE_TOKEN'), quota: subscriptionQuota });
const apiAccount = anthropic.account('release-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota: apiQuota });

const opus = claudeCode.model('opus', { id: 'claude-opus-4-1' });
const batchHaiku = anthropic.model('haiku-batch', { id: 'claude-haiku-4-5' });

const sessionPool = H.pool('release-sessions').accounts(subscription);
const batchPool = H.pool('release-batch').accounts(apiAccount);

const runner = local.runner('release').slots(3);

const reviewerRole = H.role('release-reviewer').intents('read', 'run').instructions('Review the release diff and list risks.');
const notesRole = H.role('release-notes').intents('read').instructions('Write release notes for end users.');

const reviewer = H.seat('reviewer').role(reviewerRole).model(opus).pool(sessionPool);
const notesWriter = H.seat('notes-writer').role(notesRole).model(batchHaiku).pool(batchPool);

const announceInput = z.object({ version: z.string(), channel: z.string() });

const build = H.command('build')
  .input(z.object({ version: z.string() }))
  .argv(i => ['make', 'release', `VERSION=${i.version}`])
  .runner(runner);

const announce = H.command('announce')
  .input(announceInput)
  .argv(i => ['chat', 'post', i.channel, `Releasing ${i.version}`])
  .runner(runner);

const announcementExists = H.command('announcement-exists')
  .input(announceInput)
  .argv(i => ['chat', 'search', i.channel, `Releasing ${i.version}`])
  .output(z.boolean())
  .runner(runner);

const smokeAttrs = z.object({ version: z.string(), platform: z.enum(['linux', 'macos', 'windows']) });

const SmokeQueued = H.state('smoke-queued', 'pending');
const SmokePassed = H.terminal('smoke-passed', 'success');
const SmokeRed = H.terminal('smoke-red', 'failure');
const SmokeUnrunnable = H.terminal('smoke-unrunnable', 'failure');

const smokeKind = H.kind('smoke')
  .attributes(smokeAttrs)
  .states(SmokeQueued, SmokePassed, SmokeRed, SmokeUnrunnable)
  .key(a => `${a.version}-${a.platform}`)
  .initial(SmokeQueued);

const runSmoke = H.command('smoke-test')
  .input(smokeAttrs)
  .argv(i => ['smoke', i.platform, i.version])
  .runner(runner)
  .acceptExitCodes(0, 1);

const smokeFlow = H.flow('smoke')
  .input(smokeAttrs)
  .step('run', runSmoke, ctx => ctx.unit.attributes, { afterCrash: 'rerun' })
  .exit('passed', ctx => ctx.steps.run.exitCode === 0)
  .exit('red');

const smoke = H.lane('smoke', smokeKind)
  .handler(smokeFlow, { exits: { passed: SmokePassed, red: SmokeRed } })
  .retry({ maxAttempts: 2, exhausted: SmokeUnrunnable });

const releaseAttrs = z.object({ version: z.string(), channel: z.string() });

const Requested = H.state('requested', 'pending');
const Released = H.terminal('released', 'success');
const NotApproved = H.terminal('not-approved', 'neutral');
const SmokeFailed = H.terminal('smoke-failed', 'failure');
const ReleaseBroken = H.terminal('release-broken', 'failure');

const releaseKind = H.kind('release')
  .attributes(releaseAttrs)
  .states(Requested, Released, NotApproved, SmokeFailed, ReleaseBroken)
  .key(a => a.version)
  .initial(Requested);

const approvalHalt = H.halt('release-approval').decision(z.object({ approved: z.boolean(), note: z.string() }));

const releaseFlow = H.flow('release')
  .input(releaseAttrs)
  .step('build', build, ctx => ({ version: ctx.unit.attributes.version }), { afterCrash: 'rerun' })
  .step('announce', announce, ctx => ({ version: ctx.unit.attributes.version, channel: ctx.unit.attributes.channel }), {
    afterCrash: 'park',
    alreadyDone: announcementExists,
  })
  .step('review', reviewer, ctx => ({ task: `Review release ${ctx.unit.attributes.version}` }), { afterCrash: 'askDriver' })
  .halt('approval', approvalHalt, { ask: ctx => `Ship ${ctx.unit.attributes.version}? Review:\n${ctx.steps.review}` })
  .exit('notApproved', ctx => !ctx.steps.approval.approved)
  .job('summarize', H.batch(notesWriter), ctx => [
    { task: `Write release notes for ${ctx.unit.attributes.version} from this review:\n${ctx.steps.review}` },
  ])
  .spawn('smoke', smoke, ctx => [
    { version: ctx.unit.attributes.version, platform: 'linux' },
    { version: ctx.unit.attributes.version, platform: 'macos' },
    { version: ctx.unit.attributes.version, platform: 'windows' },
  ])
  .exit('released', ctx => ctx.steps.smoke.every(child => child.verdict === 'success'))
  .exit('smokeFailed');

const releases = H.lane('releases', releaseKind)
  .supply(H.operator)
  .handler(releaseFlow, { exits: { notApproved: NotApproved, released: Released, smokeFailed: SmokeFailed } })
  .store(sqlite.store({ path: '/srv/release/store.sqlite' }))
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 120_000, exhausted: ReleaseBroken });

const releaseManager = claudeCode.supervisor('release-manager', {
  grants: [H.ops.workRead, H.ops.workCreate, H.ops.attemptsRecover, H.ops.resolve(approvalHalt), H.ops.telemetryRead],
  port: H.slot.port(1),
});

const harness = H.harness('release')
  .ledger(sqlite.ledger({ path: '/srv/release/ledger.sqlite' }))
  .lanes(releases, smoke)
  .scheduler(H.scheduler('release').standard(releases, smoke).wip(smoke, 3))
  .clients(releaseManager)
  .observers(markdown.board({ path: '/srv/release/board.md' }), markdown.telemetry({ path: '/srv/release/telemetry.md' }));

void harness.start();
