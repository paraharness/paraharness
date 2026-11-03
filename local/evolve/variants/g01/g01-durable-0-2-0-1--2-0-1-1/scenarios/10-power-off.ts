import { z } from 'zod';
import { H } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { sqlite } from 'harness-dsl/sqlite';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const subscription = claudeCode.subscription('claude-max', { token: H.env('CLAUDE_MAX_TOKEN') });
const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const reviewModel = claudeCode.model('opus', { id: 'claude-opus-4-1' });
const batchModel = anthropic.model('haiku-batch', { id: 'claude-haiku-4-5' });
const sessionPool = H.pool('sessions').accounts(subscription);
const apiPool = H.pool('api').accounts(apiAccount);
const buildHost = local.runner('build-host').slots(2);
const store = sqlite.store({ path: '.harness/units.sqlite' });

const platformName = z.enum(['linux', 'macos', 'windows']);

const smokeAttributes = z.object({ version: z.string(), platform: platformName });
const smokeQueued = H.state('queued', 'pending');
const smoking = H.state('smoking', 'active');
const passed = H.terminal('passed', 'success');
const smokeFailed = H.terminal('smokeFailed', 'failure');
const smokeWithdrawn = H.terminal('withdrawn', 'neutral');

const smokeKind = H.kind('Smoke')
  .attributes(smokeAttributes)
  .states(smokeQueued, smoking, passed, smokeFailed, smokeWithdrawn)
  .key(a => `${a.version}-${a.platform}`)
  .initial(smokeQueued);

const runSmoke = H.command('run-smoke')
  .input(smokeAttributes)
  .argv(i => ['./scripts/smoke.sh', i.version, i.platform])
  .runner(buildHost);

const smokeFlow = H.flow('smoke')
  .input(smokeAttributes)
  .step('run', runSmoke, ctx => ctx.unit.attributes, { afterCrash: 'rerun' })
  .exit('passed');

const smoke = H.lane('smoke', smokeKind)
  .store(store)
  .handler(smokeFlow, { exits: { passed }, during: { run: smoking }, cancelled: smokeWithdrawn })
  .retry({ maxAttempts: 2, backoff: 'fixed', initialDelayMs: 60000, exhausted: smokeFailed });

const releaseAttributes = z.object({ version: z.string(), channel: z.string(), platforms: z.array(platformName) });

const requested = H.state('requested', 'pending');
const building = H.state('building', 'active');
const announcing = H.state('announcing', 'active');
const inReview = H.state('inReview', 'active');
const awaitingApproval = H.state('awaitingApproval', 'waiting');
const summarizing = H.state('summarizing', 'waiting');
const awaitingSmoke = H.state('awaitingSmoke', 'waiting');
const released = H.terminal('released', 'success');
const smokeBroke = H.terminal('smokeBroke', 'failure');
const rejected = H.terminal('rejected', 'failure');
const releaseFailed = H.terminal('releaseFailed', 'failure');
const withdrawn = H.terminal('withdrawn', 'neutral');

const releaseKind = H.kind('Release')
  .attributes(releaseAttributes)
  .states(requested, building, announcing, inReview, awaitingApproval, summarizing, awaitingSmoke, released, smokeBroke, rejected, releaseFailed, withdrawn)
  .key(a => a.version)
  .initial(requested);

const build = H.command('build')
  .input(z.object({ version: z.string() }))
  .argv(i => ['make', 'release', `VERSION=${i.version}`])
  .runner(buildHost);

const announceInput = z.object({ version: z.string(), channel: z.string() });

const announce = H.command('announce')
  .input(announceInput)
  .argv(i => ['chat-post', i.channel, `Release ${i.version} is on its way`])
  .runner(buildHost);

const announcementPosted = H.command('announcement-posted')
  .input(announceInput)
  .argv(i => ['chat-search', i.channel, `Release ${i.version} is on its way`])
  .output(z.boolean())
  .runner(buildHost);

const reviewerRole = H.role('release-reviewer').intents('read', 'search').instructions('Review the release diff for anything that should block shipping.');
const reviewer = H.seat('release-reviewer')
  .role(reviewerRole)
  .model(reviewModel)
  .pool(sessionPool)
  .output(z.object({ verdict: z.enum(['ship', 'hold']), notes: z.string() }));

const notesRole = H.role('release-notes').intents('read').instructions('Write user-facing release notes.');
const notesWriter = H.seat('release-notes').role(notesRole).model(batchModel).pool(apiPool).output(z.object({ notes: z.string() }));

const approval = H.halt('release-approval').decision(z.object({ approved: z.boolean(), note: z.string() }));

const releaseFlow = H.flow('release')
  .input(releaseAttributes)
  .step('build', build, ctx => ({ version: ctx.unit.attributes.version }), { afterCrash: 'rerun' })
  .step('announce', announce, ctx => ({ version: ctx.unit.attributes.version, channel: ctx.unit.attributes.channel }), {
    afterCrash: 'park',
    alreadyDone: announcementPosted,
  })
  .step('review', reviewer, ctx => ({ task: `Review release ${ctx.unit.attributes.version} before it ships.` }), { afterCrash: 'askDriver' })
  .halt('approval', approval, {
    ask: ctx => `Ship ${ctx.unit.attributes.version}? Reviewer says ${ctx.steps.review.verdict}: ${ctx.steps.review.notes}`,
  })
  .exit('notApproved', ctx => !ctx.steps.approval.approved)
  .step('summarize', notesWriter.batch(), ctx =>
    ctx.unit.attributes.platforms.map(platform => ({ task: `Release notes for ${ctx.unit.attributes.version} on ${platform}.` })),
  )
  .spawn('smoke', smoke, ctx => ctx.unit.attributes.platforms.map(platform => ({ version: ctx.unit.attributes.version, platform })))
  .exit('smokeFailed', ctx => ctx.steps.smoke.some(child => child.verdict !== 'success'))
  .exit('shipped');

const releases = H.lane('releases', releaseKind)
  .supply(H.operator)
  .store(store)
  .handler(releaseFlow, {
    exits: { notApproved: rejected, smokeFailed: smokeBroke, shipped: released },
    during: {
      build: building,
      announce: announcing,
      review: inReview,
      approval: awaitingApproval,
      summarize: summarizing,
      smoke: awaitingSmoke,
    },
    cancelled: withdrawn,
  })
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 120000, exhausted: releaseFailed });

const releaseManager = H.client('release-manager', {
  transport: claudeCode.mcp('release-mcp', { port: H.slot.port(1) }),
  grants: [H.ops.workRead, H.ops.workCreate, H.ops.workCancel, H.ops.attemptsRecover, H.ops.telemetryRead, H.ops.resolve(approval)],
});

export const harness = H.harness('release')
  .ledger(sqlite.ledger({ path: '.harness/ledger.sqlite' }))
  .lanes(releases, smoke)
  .scheduler(H.scheduler('release').priority(releases, smoke).wip(releases, 1).wip(smoke, 3))
  .clients(releaseManager)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));
