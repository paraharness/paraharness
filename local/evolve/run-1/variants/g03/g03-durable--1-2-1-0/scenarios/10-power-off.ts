import { z } from 'zod';
import { H } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as sqlite from 'harness-dsl/sqlite';
import * as local from 'harness-dsl/local';
import * as markdown from 'harness-dsl/markdown';

const platforms: readonly string[] = ['linux', 'macos', 'windows'];
const stalled = H.state('stalled', 'waiting');

const requested = H.state('requested', 'pending');
const releasing = H.state('releasing', 'active');
const awaitingApproval = H.state('awaitingApproval', 'active');
const smokeTesting = H.state('smokeTesting', 'active');
const released = H.state('released', 'terminal', 'success');
const rejected = H.state('rejected', 'terminal', 'failure');

const Release = H.work('release')
  .attributes({ version: z.string(), channel: z.string() })
  .states([requested, releasing, awaitingApproval, smokeTesting, released, rejected, stalled])
  .key((u) => u.attributes.version);

const smokeQueued = H.state('smokeQueued', 'pending');
const smokeRunning = H.state('smokeRunning', 'active');
const passed = H.state('passed', 'terminal', 'success');
const broken = H.state('broken', 'terminal', 'failure');

const Smoke = H.work('smoke')
  .attributes({ version: z.string(), platform: z.string() })
  .states([smokeQueued, smokeRunning, passed, broken])
  .failsTo(broken)
  .key((u) => `${u.attributes.version}/${u.attributes.platform}`);

const apiAccount = anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const reviewModel = claudeCode.model('claude-opus-4-1');
const batchModel = anthropic.model('claude-haiku-4-5', { batch: true });

const build = H.command('build', ['make', 'release']);
const announce = H.command('announce', ['node', 'ops/announce.js']);
const announcePosted = H.command('announce-posted', ['node', 'ops/announce-posted.js']).parses({ done: z.boolean() });
const smokeTest = H.command('smoke-test', ['node', 'ops/smoke.js']);

const reviewer = H.agent(
  'release-reviewer',
  H.role('release-reviewer')
    .intents(['read', 'execute'])
    .instructions('Review the release build and changelog for anything that should block shipping.')
    .input({ version: z.string(), buildLog: z.string() })
    .output({ verdict: z.enum(['ship', 'hold']), notes: z.string() }),
)
  .model(reviewModel)
  .pool(apiAccount);

const summarizer = H.agent(
  'release-summarizer',
  H.role('release-summarizer')
    .instructions('Write release notes for end users.')
    .input({ version: z.string(), review: z.string() })
    .output({ notes: z.string() }),
)
  .model(batchModel)
  .pool(apiAccount);

const approval = H.decision('release-approval', { approved: z.boolean(), note: z.string() });

const releaseFlow = H.flow('release')
  .requires({ version: z.string(), channel: z.string() })
  .step('build', build, (c) => ({ args: [c.input.version] }), { restart: 'rerun' })
  .step('announce', announce, (c) => ({ args: [c.input.channel, c.input.version] }), {
    restart: { probe: announcePosted },
  })
  .step('review', reviewer, (c) => ({ version: c.input.version, buildLog: c.out.build.stdout }), { restart: 'ask' })
  .halt('approval', approval, { ask: (c) => `Ship ${c.input.version}? Review: ${c.out.review.verdict}. ${c.out.review.notes}` })
  .exit('rejected', (c) => !c.out.approval.approved)
  .batch('summarize', summarizer, (c) => [{ version: c.input.version, review: c.out.review.notes }])
  .spawn('smoke', {
    child: { version: z.string(), platform: z.string() },
    items: (c) => platforms.map((platform) => ({ version: c.input.version, platform })),
  })
  .ends(['released', 'smokeFailed'], (c) => (c.out.smoke.every((s) => s.verdict === 'success') ? 'released' : 'smokeFailed'));

const smokeFlow = H.flow('smoke')
  .requires({ version: z.string(), platform: z.string() })
  .step('test', smokeTest, (c) => ({ args: [c.input.platform, c.input.version] }), { restart: 'rerun' })
  .ends(['passed'], () => 'passed');

const shell = local.shell({ slots: 4 });

const smokes = H.lane('smoke', Smoke)
  .store(sqlite.store(Smoke, 'release/units.sqlite'))
  .runner(shell)
  .handler(smokeFlow, { opens: smokeRunning, ends: { passed } });

const releases = H.lane('releases', Release)
  .supply([H.supply.operator()])
  .store(sqlite.store(Release, 'release/units.sqlite'))
  .runner(shell)
  .wip(1)
  .handler(releaseFlow, {
    opens: releasing,
    during: { approval: awaitingApproval, smoke: smokeTesting },
    ends: { released, rejected, smokeFailed: stalled },
    exhausted: stalled,
    spawns: { smoke: (child) => smokes.unit({ attributes: child }) },
  });

const releaseManager = H.access('release-manager').allows([
  H.ops.readWork,
  H.ops.createWork,
  H.ops.resolveBlocks,
  H.ops.manageAttempts,
  H.ops.readTelemetry,
]);

export const releaseHarness = H.harness('release')
  .ledger(sqlite.ledger('release/ledger.sqlite'))
  .lanes([releases, smokes])
  .schedule(
    H.policy.schedule('smoke-then-release', (c) => ({
      start: c.order((x) => (x.is(smokes) ? 0 : 1), (x) => x.enqueuedAt),
    })),
  )
  .clients([claudeCode.supervisor('release-manager', releaseManager, { port: H.slot.port(0) })])
  .projections([markdown.board('release/board.md'), markdown.telemetry('release/telemetry.md')]);
