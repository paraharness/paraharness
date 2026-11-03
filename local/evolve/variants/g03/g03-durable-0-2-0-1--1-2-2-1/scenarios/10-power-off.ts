import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const localRunner = local.runner('local');
const harnessStore = sqlite.store({ path: '.harness/store.db' });
const quota = sqlite.quota('release-quota', { path: '.harness/quota.db' });

const subscription = claudeCode.subscription('release-max', { token: H.env('CLAUDE_MAX_TOKEN'), quota });
const sessionPool = H.pool('release-sessions').accounts(subscription);
const opus = claudeCode.model('opus', { id: 'claude-opus-4-1' });

const apiAccount = anthropic.account('release-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });
const batchPool = H.pool('release-batch').accounts(apiAccount);
const haiku = anthropic.model('haiku', { id: 'claude-haiku-4-5' });

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
  .argv(i => ['./scripts/smoke', i.platform, i.version])
  .runner(localRunner);

const smokeFlow = H.flow('smoke')
  .input(smokeSchema)
  .step('smoke', smokeTest, ctx => ctx.unit.attributes, { afterCrash: 'rerun' })
  .exit('passed');

const smokeLane = H.lane('smoke', smokeKind)
  .handler(smokeFlow, { exits: { passed: SmokePassed } })
  .store(harnessStore)
  .retry({ maxAttempts: 2, exhausted: SmokeFailed });

const releaseSchema = z.object({ version: z.string(), commit: z.string(), channel: z.string() });

const Requested = H.state('Requested', 'pending');
const Released = H.terminal('Released', 'success');
const Rejected = H.terminal('Rejected', 'neutral');
const SmokeBlocked = H.terminal('SmokeBlocked', 'failure');
const Abandoned = H.terminal('Abandoned', 'failure');
const releaseKind = H.kind('Release')
  .attributes(releaseSchema)
  .states(Requested, Released, Rejected, SmokeBlocked, Abandoned)
  .key(a => a.version)
  .initial(Requested);

const build = H.command('build')
  .input(z.object({ version: z.string(), commit: z.string() }))
  .argv(i => ['./scripts/build', i.commit, i.version])
  .runner(localRunner);

const announce = H.command('announce')
  .input(z.object({ version: z.string(), channel: z.string() }))
  .argv(i => ['./scripts/announce', i.channel, i.version])
  .runner(localRunner);

const announcementPosted = H.command('announcement-posted')
  .input(z.object({ version: z.string(), channel: z.string() }))
  .argv(i => ['./scripts/announcement-posted', i.channel, i.version])
  .output(z.boolean())
  .runner(localRunner);

const reviewerRole = H.role('release-reviewer').intents('read', 'run').instructions('Review the release diff and changelog for risk.');
const reviewer = H.seat('release-reviewer')
  .role(reviewerRole)
  .model(opus)
  .pool(sessionPool)
  .output(z.object({ approve: z.boolean(), notes: z.string() }));

const summarizerRole = H.role('release-summarizer').intents('read').instructions('Write release notes for users.');
const summarizer = H.seat('release-summarizer').role(summarizerRole).model(haiku).pool(batchPool);
const summarizeBatch = H.batch(summarizer);

const approvalHalt = H.halt('releaseApproval').decision(z.object({ approved: z.boolean(), note: z.string() }));

const ship = H.flow('ship')
  .input(releaseSchema)
  .step('build', build, ctx => ({ version: ctx.unit.attributes.version, commit: ctx.unit.attributes.commit }), { afterCrash: 'rerun' })
  .step('announce', announce, ctx => ({ version: ctx.unit.attributes.version, channel: ctx.unit.attributes.channel }), {
    afterCrash: 'park',
    alreadyDone: announcementPosted,
  })
  .step('review', reviewer, ctx => ({ task: `Review release ${ctx.unit.attributes.version} at ${ctx.unit.attributes.commit}` }), { afterCrash: 'askDriver' })
  .halt('approval', approvalHalt, { ask: ctx => `Ship ${ctx.unit.attributes.version}? Reviewer: ${ctx.steps.review.notes}` })
  .exit('rejected', ctx => !ctx.steps.approval.approved)
  .job('summarize', summarizeBatch, ctx => [
    { task: `Write user-facing notes for ${ctx.unit.attributes.version}: ${ctx.steps.review.notes}` },
    { task: `Write operator-facing notes for ${ctx.unit.attributes.version}: ${ctx.steps.review.notes}` },
  ])
  .spawn('smoke', smokeLane, ctx => platform.options.map(p => ({ version: ctx.unit.attributes.version, platform: p })))
  .exit('smokeFailed', ctx => ctx.steps.smoke.some(c => c.verdict !== 'success'))
  .exit('released');

const releaseLane = H.lane('releases', releaseKind)
  .supply(H.operator)
  .handler(ship, { exits: { released: Released, rejected: Rejected, smokeFailed: SmokeBlocked } })
  .store(harnessStore)
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 120_000, exhausted: Abandoned });

const supervisor = claudeCode.supervisor('release-supervisor', {
  grants: [
    H.ops.workRead,
    H.ops.workCreate,
    H.ops.attemptsRecover,
    H.ops.resolve(approvalHalt),
    H.ops.telemetryRead,
  ],
  port: H.slot.port(1),
});

export const harness = H.harness('release')
  .ledger(sqlite.ledger({ path: '.harness/ledger.db' }))
  .lanes(smokeLane, releaseLane)
  .scheduler(H.scheduler('release-scheduler')
    .standard(releaseLane, smokeLane)
    .wip(releaseLane, 1)
    .wip(smokeLane, 3))
  .clients(supervisor)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));

void harness.start();
