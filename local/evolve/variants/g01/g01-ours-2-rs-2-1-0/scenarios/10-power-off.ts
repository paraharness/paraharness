import { z } from 'zod';
import { H } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { sqlite } from 'harness-dsl/sqlite';
import { http } from 'harness-dsl/http';
import { manual } from 'harness-dsl/supply';
import { runners } from 'harness-dsl/runners';
import { observers } from 'harness-dsl/observers';

const local = runners.local({ name: 'local', slots: 2 }).env({ CHAT_TOKEN: H.env('CHAT_TOKEN') });
const platformRunners = {
  linux: runners.ssh({ name: 'smoke-linux', host: H.env('SMOKE_LINUX_HOST'), user: 'ci', slots: 1 }),
  macos: runners.ssh({ name: 'smoke-macos', host: H.env('SMOKE_MACOS_HOST'), user: 'ci', slots: 1 }),
  windows: runners.ssh({ name: 'smoke-windows', host: H.env('SMOKE_WINDOWS_HOST'), user: 'ci', slots: 1 }),
};

const api = H.account('api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') }));
const sonnet = H.model('claude-sonnet-4-5').pricing(anthropic.pricing());
const haiku = H.model('claude-haiku-4-5').pricing(anthropic.pricing());
const pool = H.pool('release', [api]).serves(sonnet, haiku);

const platform = z.enum(['linux', 'macos', 'windows']);
const platforms = platform.options;

const smokeData = z.object({ version: z.string(), platform });
const smokeQueued = H.state('queued').pending();
const smokePassed = H.state('passed').terminal('success');
const smokeFailed = H.state('failed').terminal('failure');
const smokeKind = H.work('Smoke').schema(smokeData).states(smokeQueued, smokePassed, smokeFailed);

const smokeTest = H.command('smoke-test')
  .input(smokeData)
  .output(z.object({ ok: z.boolean(), log: z.string() }))
  .runner(input => platformRunners[input.platform])
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec(['./scripts/smoke', input.version]);
    return { ok: result.code === 0, log: result.stdout };
  });

const smokeFlow = H.flow('smoke')
  .input(smokeData)
  .step('check', smokeTest, state => state.input)
  .when(state => state.check.ok === false, flow => flow.exit('failed'))
  .exit('passed');

const smoke = H.lane('smoke')
  .of(smokeKind)
  .store(sqlite.store('.harness/release.db'))
  .handle(smokeFlow, { exits: { passed: smokePassed, failed: smokeFailed }, retry: { retries: 1, backoff: 'none', exhausted: smokeFailed } })
  .wip(3);

const releaseData = z.object({ version: z.string(), channel: z.string(), notes: z.string() });
const requested = H.state('requested').pending();
const released = H.state('released').terminal('success');
const rejected = H.state('rejected').terminal('failure');
const smokeBroken = H.state('smoke-failed').terminal('failure');
const broken = H.state('broken').terminal('failure');
const releaseKind = H.work('Release').schema(releaseData).states(requested, released, rejected, smokeBroken, broken);

const build = H.command('build')
  .input(z.object({ version: z.string() }))
  .output(z.object({ artifact: z.string() }))
  .runner(local)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec(['make', 'release', `VERSION=${input.version}`]);
    return { artifact: result.stdout.trim() };
  });

const announce = H.command('announce')
  .input(z.object({ version: z.string(), channel: z.string() }))
  .output(z.object({ messageId: z.string() }))
  .runner(local)
  .effect('unrepeatable')
  .detect(async (input, ctx) => {
    const found = await ctx.exec(['./scripts/find-announcement', input.channel, input.version]);
    return found.code === 0 ? { messageId: found.stdout.trim() } : undefined;
  })
  .run(async (input, ctx) => {
    const posted = await ctx.exec(['./scripts/announce', input.channel, input.version]);
    return { messageId: posted.stdout.trim() };
  });

const releaseReviewer = H.role('release-reviewer').promptFile('prompts/release-review.md').intents(['read']);
const reviewRelease = H.skill('review-release')
  .input(z.object({ version: z.string(), notes: z.string() }))
  .output(z.object({ notes: z.string(), concerns: z.array(z.string()) }))
  .prompt(input => `Review release ${input.version}:\n${input.notes}`);
const reviewer = H.seat('reviewer').role(releaseReviewer).skill(reviewRelease).models(sonnet);

const summaryWriter = H.role('summary-writer').prompt('Write a short public summary of a release.');
const summarizeRelease = H.skill('summarize-release')
  .input(z.object({ version: z.string(), notes: z.string() }))
  .output(z.object({ summary: z.string() }))
  .prompt(input => `Summarise ${input.version}:\n${input.notes}`);
const summarizer = H.seat('summarizer').role(summaryWriter).skill(summarizeRelease).models(haiku);
const summaryBatch = H.job('release-summary').batch(summarizer);

const approval = H.halt('release-approval')
  .context(z.object({ version: z.string(), concerns: z.array(z.string()) }))
  .decision(z.object({ approved: z.boolean() }))
  .ask(context => `Ship ${context.version}? Concerns: ${context.concerns.join('; ') || 'none'}`);

const shipRelease = H.flow('ship-release')
  .input(releaseData)
  .step('build', build, state => ({ version: state.input.version }))
  .step('announce', announce, state => ({ version: state.input.version, channel: state.input.channel }))
  .step('review', reviewer, state => ({ version: state.input.version, notes: state.input.notes }))
  .halt('approval', approval, state => ({ version: state.input.version, concerns: state.review.concerns }))
  .when(state => state.approval.approved === false, flow => flow.exit('rejected'))
  .step('summarize', summaryBatch, state => [{ version: state.input.version, notes: state.review.notes }])
  .spawn('smoke', smoke, state => platforms.map(target => ({ key: `${state.input.version}-${target}`, data: { version: state.input.version, platform: target } })))
  .when(state => state.smoke.every(child => child.verdict === 'success') === false, flow => flow.exit('smoke-failed'))
  .exit('released');

const releases = H.lane('releases')
  .of(releaseKind)
  .from(manual('operator-releases'))
  .store(sqlite.store('.harness/release.db'))
  .handle(shipRelease, {
    exits: { rejected, 'smoke-failed': smokeBroken, released },
    retry: { retries: 1, backoff: { initial: '2m', factor: 2 }, exhausted: broken },
  })
  .wip(1);

const releaseOrder = H.policy.units('releases-then-smoke', choice =>
  [...choice.candidates].sort((a, b) => Number(a.lane === smoke.name) - Number(b.lane === smoke.name) || a.queuedAt.getTime() - b.queuedAt.getTime()),
);

const supervisor = claudeCode.client({ name: 'supervisor' });
const releaseManager = http.client({ name: 'release-manager', port: H.slot.port(0), token: H.env('RELEASE_MANAGER_TOKEN') });

export const harness = H.harness('release')
  .ledger(sqlite.ledger('.harness/release-ledger.db'))
  .pools(pool)
  .lanes(releases, smoke)
  .scheduler(releaseOrder)
  .grants(
    H.grant(supervisor, H.ops.work.read, H.ops.work.write, H.ops.attempts.manage, H.ops.telemetry.read),
    H.grant(releaseManager, H.ops.work.read, H.ops.resolve(approval)),
  )
  .observe(observers.board({ path: '.harness/board.md' }), observers.telemetry({ path: '.harness/telemetry.md' }));
