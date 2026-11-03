import { z } from 'zod';
import { H } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claude from 'harness-dsl/claude-code';
import * as sqlite from 'harness-dsl/sqlite';
import * as local from 'harness-dsl/local';
import * as markdown from 'harness-dsl/markdown';

const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const reviewModel = anthropic.model('claude-opus-4');
const batchModel = anthropic.model('claude-haiku-4', { batch: true });
const runner = local.shell({ slots: 4, cwd: '.' });

const platforms = ['linux', 'macos', 'windows'];

const SmokeQueued = H.state('SmokeQueued', 'pending');
const Testing = H.state('Testing', 'active');
const Passed = H.state('Passed', 'terminal', 'success');
const SmokeBroken = H.state('SmokeBroken', 'terminal', 'failure');

const Smoke = H.work('Smoke')
  .attributes({ platform: z.string(), version: z.string() })
  .states([SmokeQueued, Testing, Passed, SmokeBroken])
  .key((unit) => `${unit.attributes.version}-${unit.attributes.platform}`);

const smokeTest = H.command('smoke-test', ['scripts/smoke.sh']);

const smokeFlow = H.flow('smoke')
  .requires({ platform: z.string(), version: z.string() })
  .mark('testing')
  .step('smoke', smokeTest, (c) => ({ args: [c.input.version, c.input.platform] }), { onRestart: 'rerun' })
  .ends(['passed', 'broken'], (c) => (c.out.smoke.exitCode === 0 ? 'passed' : 'broken'));

const smokes = H.lane('smoke', Smoke)
  .handler(smokeFlow, { states: { testing: Testing, passed: Passed, broken: SmokeBroken, failed: SmokeBroken } })
  .runner(runner)
  .wip(3);

const Requested = H.state('Requested', 'pending');
const Releasing = H.state('Releasing', 'active');
const Released = H.state('Released', 'terminal', 'success');
const Rejected = H.state('Rejected', 'terminal', 'failure');
const SmokeFailed = H.state('SmokeFailed', 'terminal', 'failure');
const ReleaseFailed = H.state('ReleaseFailed', 'terminal', 'failure');

const Release = H.work('Release')
  .attributes({ version: z.string() })
  .states([Requested, Releasing, Released, Rejected, SmokeFailed, ReleaseFailed])
  .key((unit) => unit.attributes.version);

const build = H.command('build', ['scripts/build.sh']);
const announce = H.command('announce', ['scripts/announce.sh']);
const announcementPosted = H.command('announcement-posted', ['scripts/find-announcement.sh']);

const releaseReviewer = H.role('release-reviewer')
  .intents(['read', 'search'])
  .instructions('Review the build log and changelog for release blockers.')
  .input({ version: z.string(), buildLog: z.string() })
  .output({ ok: z.boolean(), findings: z.array(z.string()) });

const releaseSummarizer = H.role('release-summarizer')
  .intents(['read'])
  .instructions('Write the release summary for the changelog.')
  .input({ version: z.string(), findings: z.array(z.string()) })
  .output({ summary: z.string() });

const reviewer = H.agent('release-reviewer', releaseReviewer).model(reviewModel).pool(apiAccount);
const summarizer = H.agent('release-summarizer', releaseSummarizer).model(batchModel).pool(apiAccount);

const SmokeChild = z.object({ platform: z.string(), version: z.string() });

const releaseFlow = H.flow('release')
  .requires({ version: z.string() })
  .mark('releasing')
  .step('build', build, (c) => ({ args: [c.input.version] }), { onRestart: 'rerun' })
  .step('announce', announce, (c) => ({ args: [c.input.version] }), {
    onRestart: 'park',
    confirm: announcementPosted,
  })
  .step('review', reviewer, (c) => ({ version: c.input.version, buildLog: c.out.build.stdout }), { onRestart: 'ask' })
  .halt('approval', {
    ask: (c) => `Release ${c.input.version}? Review: ${c.out.review.ok ? 'clean' : c.out.review.findings.join('; ')}`,
    decision: { approved: z.boolean(), note: z.string() },
  })
  .exit('rejected', (c) => !c.out.approval.approved)
  .batch('summarize', summarizer, (c) => [{ version: c.input.version, findings: c.out.review.findings }])
  .spawn('smoke', {
    outlet: 'smoke',
    child: SmokeChild.shape,
    items: (c) => platforms.map((platform) => ({ platform, version: c.input.version })),
  })
  .ends(['released', 'smokeFailed'], (c) =>
    c.out.smoke.every((child) => child.verdict === 'success') ? 'released' : 'smokeFailed',
  );

const releases = H.lane('releases', Release)
  .supply([H.supply.operator()])
  .store(sqlite.store(Release, 'release-store.sqlite'))
  .handler(releaseFlow, {
    states: {
      releasing: Releasing,
      rejected: Rejected,
      released: Released,
      smokeFailed: SmokeFailed,
      failed: ReleaseFailed,
    },
    spawns: {
      smoke: H.child(smokes, (child: z.infer<typeof SmokeChild>) => ({
        attributes: { platform: child.platform, version: child.version },
      })),
    },
  })
  .runner(runner)
  .wip(1);

const releaseManagerAccess = H.access('release-manager').allows([
  H.ops.readWork,
  H.ops.createWork,
  H.ops.resolveBlocks,
  H.ops.readTelemetry,
]);

export const releaseHarness = H.harness('release')
  .ledger(sqlite.ledger('release-ledger.sqlite', { writerTtlMs: 15_000 }))
  .lanes([releases, smokes])
  .schedule(H.policy.schedule('releases-then-smoke', (c) => ({
    start: [...c.candidates].sort((a, b) => (a.is(smokes) ? 0 : 1) - (b.is(smokes) ? 0 : 1)),
  })))
  .clients([claude.supervisor('release-supervisor', releaseManagerAccess, { port: H.slot.port(0) })])
  .projections([markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md')]);
