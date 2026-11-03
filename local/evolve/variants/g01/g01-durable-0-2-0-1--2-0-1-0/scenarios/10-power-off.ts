import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const quota = sqlite.quota('release-quota', { path: './.harness/quota.sqlite' });
const subscription = claudeCode.subscription('release-subscription', { token: H.env('CLAUDE_TOKEN'), quota });
const batchAccount = anthropic.account('batch-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });
const reviewModel = claudeCode.model('review-model', { id: 'claude-sonnet-4-5' });
const summaryModel = anthropic.model('summary-model', { id: 'claude-haiku-4-5' });

const firstEligible = H.policy.account('first-eligible', ctx =>
  ctx.candidates.find(c => c.cooldownUntil === undefined || c.cooldownUntil <= ctx.now),
);
const sessionPool = H.pool('session-pool').accounts(subscription).drain(firstEligible);
const batchPool = H.pool('batch-pool').accounts(batchAccount).drain(firstEligible);
const runner = local.runner('local');

const reviewerRole = H.role('release-reviewer').intents('read', 'run').instructions('Review the release candidate and list blocking findings.');
const summarizerRole = H.role('release-summarizer').intents('read').instructions('Write release notes from the changelog.');

const reviewer = H.seat('release-reviewer')
  .role(reviewerRole)
  .model(reviewModel)
  .pool(sessionPool)
  .output(z.object({ ready: z.boolean(), findings: z.array(z.string()) }));
const summarizer = H.seat('release-summarizer').role(summarizerRole).model(summaryModel).pool(batchPool);

const releaseApproval = H.halt('release-approval').decision(z.object({ approved: z.boolean(), note: z.string() }));

const build = H.command('build')
  .input(z.object({ version: z.string() }))
  .argv(i => ['./scripts/build', i.version])
  .runner(runner);

const announce = H.command('announce')
  .input(z.object({ version: z.string(), channel: z.string() }))
  .argv(i => ['./scripts/announce', i.channel, i.version])
  .runner(runner);

const announcementPosted = H.command('announcement-posted')
  .input(z.object({ version: z.string(), channel: z.string() }))
  .argv(i => ['./scripts/announcement-posted', i.channel, i.version])
  .output(z.boolean())
  .runner(runner);

const runSmoke = H.command('run-smoke')
  .input(z.object({ version: z.string(), platform: z.string() }))
  .argv(i => ['./scripts/smoke', i.platform, i.version])
  .runner(runner)
  .acceptExitCodes(0, 1);

const SmokeQueued = H.state('SmokeQueued', 'pending');
const SmokeRunning = H.state('SmokeRunning', 'active');
const SmokePassed = H.terminal('SmokePassed', 'success');
const SmokeBroken = H.terminal('SmokeBroken', 'failure');

const platform = z.enum(['linux', 'macos', 'windows']);

const Smoke = H.kind('Smoke')
  .attributes(z.object({ version: z.string(), platform }))
  .states(SmokeQueued, SmokeRunning, SmokePassed, SmokeBroken)
  .key(a => `${a.version}/${a.platform}`)
  .initial(SmokeQueued);

const smokeFlow = H.flow('smoke')
  .input(z.object({ version: z.string(), platform }))
  .step('run', runSmoke, ctx => ({ version: ctx.unit.attributes.version, platform: ctx.unit.attributes.platform }), { afterCrash: 'rerun' })
  .exit('passed', ctx => ctx.steps.run.exitCode === 0)
  .exit('broken');

const smokes = H.lane('smoke', Smoke)
  .store(sqlite.store({ path: './.harness/units.sqlite' }))
  .handler(smokeFlow, { exits: { passed: SmokePassed, broken: SmokeBroken }, during: { run: SmokeRunning } })
  .retry({ maxAttempts: 2, backoff: 'fixed', initialDelayMs: 60000, exhausted: SmokeBroken });

const Requested = H.state('Requested', 'pending');
const Building = H.state('Building', 'active');
const Announcing = H.state('Announcing', 'active');
const Reviewing = H.state('Reviewing', 'active');
const AwaitingApproval = H.state('AwaitingApproval', 'waiting');
const SmokeTesting = H.state('SmokeTesting', 'waiting');
const Released = H.terminal('Released', 'success');
const SmokeFailed = H.terminal('SmokeFailed', 'failure');
const ReleaseRejected = H.terminal('ReleaseRejected', 'neutral');
const ReleaseAbandoned = H.terminal('ReleaseAbandoned', 'failure');

const releaseAttrs = z.object({ version: z.string(), channel: z.string(), platforms: z.array(platform) });

const Release = H.kind('Release')
  .attributes(releaseAttrs)
  .states(Requested, Building, Announcing, Reviewing, AwaitingApproval, SmokeTesting, Released, SmokeFailed, ReleaseRejected, ReleaseAbandoned)
  .key(a => a.version)
  .initial(Requested);

const releaseFlow = H.flow('release')
  .input(releaseAttrs)
  .step('build', build, ctx => ({ version: ctx.unit.attributes.version }), { afterCrash: 'rerun' })
  .step('announce', announce, ctx => ({ version: ctx.unit.attributes.version, channel: ctx.unit.attributes.channel }), {
    afterCrash: 'park',
    alreadyDone: announcementPosted,
  })
  .step('review', reviewer, ctx => ({ task: `Review release candidate ${ctx.unit.attributes.version}` }), { afterCrash: 'askDriver' })
  .halt('approval', releaseApproval, {
    ask: ctx => `Release ${ctx.unit.attributes.version}? Findings: ${ctx.steps.review.findings.join('; ') || 'none'}`,
  })
  .exit('rejected', ctx => !ctx.steps.approval.approved)
  .step('summarize', summarizer.batch(), ctx => [
    { task: `Write user-facing release notes for ${ctx.unit.attributes.version}` },
    { task: `Write upgrade notes for ${ctx.unit.attributes.version}` },
  ])
  .spawn('smoke', smokes, ctx => ctx.unit.attributes.platforms.map(p => ({ version: ctx.unit.attributes.version, platform: p })))
  .exit('released', ctx => ctx.steps.smoke.every(c => c.verdict === 'success'))
  .exit('smokeFailed');

const releases = H.lane('releases', Release)
  .supply(H.operator)
  .store(sqlite.store({ path: './.harness/units.sqlite' }))
  .handler(releaseFlow, {
    exits: { rejected: ReleaseRejected, released: Released, smokeFailed: SmokeFailed },
    during: { build: Building, announce: Announcing, review: Reviewing, approval: AwaitingApproval, smoke: SmokeTesting },
  })
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 300000, exhausted: ReleaseAbandoned });

void H.harness('release')
  .ledger(sqlite.ledger({ path: './.harness/ledger.sqlite' }))
  .lanes(releases, smokes)
  .scheduler(H.scheduler('release').priority(releases, smokes).wip(releases, 1).wip(smokes, 3))
  .clients(
    claudeCode.supervisor('release-manager').client('release-supervisor', {
      grants: [H.ops.workRead, H.ops.workCreate, H.ops.attemptsRecover, H.ops.resolve(releaseApproval), H.ops.telemetryRead],
    }),
  )
  .observers(markdown.board({ path: './BOARD.md' }))
  .start();
