import { z } from 'zod';
import { H } from 'harness-dsl';
import * as sqlite from 'harness-dsl/sqlite';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as local from 'harness-dsl/local';
import * as markdown from 'harness-dsl/markdown';

const platforms: readonly string[] = ['linux', 'macos', 'windows'];
const runner = local.shell({ slots: 4, cwd: 'release' });

const SmokeQueued = H.state('smokeQueued', 'pending');
const SmokeRunning = H.state('smokeRunning', 'active');
const SmokePassed = H.state('smokePassed', 'terminal', 'success');
const SmokeFailed = H.state('smokeFailed', 'terminal', 'failure');

const Smoke = H.work('Smoke')
  .attributes({ release: z.string(), platform: z.string() })
  .states([SmokeQueued, SmokeRunning, SmokePassed, SmokeFailed])
  .failsTo(SmokeFailed)
  .key(unit => `${unit.attributes.release}:${unit.attributes.platform}`);

const smokeTest = H.command('smokeTest', ['./scripts/smoke.sh']);
const smokeFlow = H.flow('smoke')
  .requires({ release: z.string(), platform: z.string() })
  .step('smokeTest', smokeTest, c => ({ args: [c.input.release, c.input.platform] }), { restart: 'rerun' })
  .ends(['passed', 'failed'], c => (c.out.smokeTest.exitCode === 0 ? 'passed' : 'failed'));

const smokes = H.lane('smoke', Smoke)
  .runner(runner)
  .handler(smokeFlow, { opens: SmokeRunning, ends: { passed: SmokePassed, failed: SmokeFailed } });

const Requested = H.state('requested', 'pending');
const Building = H.state('building', 'active');
const AwaitingApproval = H.state('awaitingApproval', 'waiting');
const AwaitingSmoke = H.state('awaitingSmoke', 'waiting');
const Released = H.state('released', 'terminal', 'success');
const Rejected = H.state('rejected', 'terminal', 'neutral');
const ReleaseBroken = H.state('releaseBroken', 'terminal', 'failure');
const ReleaseAbandoned = H.state('releaseAbandoned', 'terminal', 'failure');

const Release = H.work('Release')
  .attributes({ version: z.string() })
  .states([Requested, Building, AwaitingApproval, AwaitingSmoke, Released, Rejected, ReleaseBroken, ReleaseAbandoned])
  .failsTo(ReleaseAbandoned)
  .key(unit => unit.attributes.version);

const build = H.command('build', ['./scripts/build.sh']);
const announce = H.command('announce', ['./scripts/announce.sh']);
const announcePosted = H.command('announcePosted', ['./scripts/announce-posted.sh']).parses({ done: z.boolean() });

const account = anthropic.account('release', { apiKey: H.env('ANTHROPIC_API_KEY') });
const reviewRole = H.role('releaseReviewer')
  .intents(['read'])
  .instructions('Review the build log and changelog. Say whether the release is ready and why.')
  .input({ version: z.string(), buildLog: z.string() })
  .output({ ready: z.boolean(), verdict: z.string() });
const summaryRole = H.role('releaseSummarizer')
  .intents(['read'])
  .instructions('Write release notes for users from the review.')
  .input({ version: z.string(), review: z.string() })
  .output({ notes: z.string() });

const reviewer = H.agent('releaseReviewer', reviewRole).model(claudeCode.model('claude-opus-4-1')).pool(account);
const summarizer = H.agent('releaseSummarizer', summaryRole)
  .model(anthropic.model('claude-haiku-4-5', { batch: true }))
  .pool(account);
const releaseApproval = H.decision('releaseApproval', { approved: z.boolean(), note: z.string() });

const releaseFlow = H.flow('release')
  .requires({ version: z.string() })
  .step('build', build, c => ({ args: [c.input.version] }), { restart: 'rerun' })
  .step('announce', announce, c => ({ args: [c.input.version] }), { restart: { probe: announcePosted } })
  .step('review', reviewer, c => ({ version: c.input.version, buildLog: c.out.build.stdout }), { restart: 'ask' })
  .halt('approval', releaseApproval, {
    ask: c => `Ship ${c.input.version}? Reviewer says ready=${c.out.review.ready}: ${c.out.review.verdict}`,
  })
  .exit('rejected', c => !c.out.approval.approved)
  .batch('summarize', summarizer, c => [{ version: c.input.version, review: c.out.review.verdict }])
  .spawn('smoke', {
    child: { release: z.string(), platform: z.string() },
    items: c => platforms.map(platform => ({ release: c.input.version, platform })),
  })
  .ends(['released', 'smokeFailed'], c =>
    c.out.smoke.every(child => child.state.verdict === 'success') ? 'released' : 'smokeFailed',
  );

const releases = H.lane('releases', Release)
  .supply([H.supply.operator()])
  .runner(runner)
  .wip(1)
  .handler(releaseFlow, {
    opens: Building,
    progress: { build: Building, smoke: AwaitingSmoke },
    halts: { approval: AwaitingApproval },
    spawns: { smoke: child => smokes.unit({ attributes: { release: child.release, platform: child.platform } }) },
    ends: { released: Released, rejected: Rejected, smokeFailed: ReleaseBroken },
  });

const releaseManagerAccess = H.access('releaseManager').allows([
  H.ops.readWork,
  H.ops.createWork,
  H.ops.resolveBlocks,
  H.ops.manageAttempts,
  H.ops.readTelemetry,
]);

const releasesFirst = H.policy.schedule('releasesFirst', c => ({
  start: c.order(candidate => (candidate.is(smokes) ? 0 : 1), candidate => candidate.enqueuedAt),
}));

const harness = H.harness('release')
  .ledger(sqlite.ledger('.harness/ledger.sqlite'))
  .lanes([releases, smokes])
  .schedule(releasesFirst)
  .clients([claudeCode.supervisor('releaseManager', releaseManagerAccess, { port: H.slot.port(0) })])
  .projections([markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md')]);

void harness.start();
