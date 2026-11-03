import { z } from 'zod';
import { H } from 'harness-dsl';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { sqlite } from 'harness-dsl/sqlite';
import { manual } from 'harness-dsl/supply';
import { runners } from 'harness-dsl/runners';
import { policies } from 'harness-dsl/policies';
import { observers } from 'harness-dsl/observers';

const api = H.account('anthropic-api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') }));
const sonnet = H.model('claude-sonnet-4-5').pricing(anthropic.pricing());
const haiku = H.model('claude-haiku-4-5').pricing(anthropic.pricing());
const pool = H.pool('api', [api]).serves(sonnet, haiku).policy(policies.soonestReset());

const local = runners.local({ name: 'release-local', slots: 4 }).env({ CHAT_TOKEN: H.env('CHAT_TOKEN') });

const platform = z.enum(['linux', 'macos', 'windows']);
const platforms: readonly z.infer<typeof platform>[] = ['linux', 'macos', 'windows'];

const smokeQueued = H.state('smoke-queued').pending();
const smoking = H.state('smoking').active();
const smokePassed = H.state('smoke-passed').terminal('success');
const smokeFailed = H.state('smoke-failed').terminal('failure');

const smokeSchema = z.object({ version: z.string(), platform });
const smoke = H.work('Smoke').schema(smokeSchema).states(smokeQueued, smoking, smokePassed, smokeFailed);

const smokeTest = H.command('smoke-test')
  .input(smokeSchema)
  .output(z.object({ ok: z.boolean(), log: z.string() }))
  .runner(local)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec(['./scripts/smoke', input.platform, input.version]);
    return { ok: result.code === 0, log: result.stdout };
  });

const smokeFlow = H.flow('smoke')
  .input(smokeSchema)
  .step('test', smokeTest, s => s.input)
  .when(s => !s.test.ok, f => f.exit('failed'))
  .exit('passed');

const smokeLane = H.lane('smoke')
  .of(smoke)
  .store(sqlite.store('./release/smoke.sqlite'))
  .handle(smokeFlow, {
    exits: { passed: smokePassed, failed: smokeFailed },
    retry: { retries: 1, backoff: { initial: '1m', factor: 2 }, exhausted: smokeFailed },
  })
  .wip(3);

const requested = H.state('requested').pending();
const releasing = H.state('releasing').active();
const stalled = H.state('stalled').waiting();
const released = H.state('released').terminal('success');
const rejected = H.state('rejected').terminal('neutral');
const smokeBroken = H.state('smoke-broken').terminal('failure');

const releaseSchema = z.object({ version: z.string(), commit: z.string(), channel: z.string() });
const release = H.work('Release').schema(releaseSchema).states(requested, releasing, stalled, released, rejected, smokeBroken);

const build = H.command('build')
  .input(z.object({ version: z.string(), commit: z.string() }))
  .output(z.object({ artifact: z.string() }))
  .runner(local)
  .effect('repeatable')
  .run(async (input, ctx) => {
    await ctx.exec(['./scripts/build', input.commit, '--version', input.version]);
    return { artifact: `dist/release-${input.version}.tar.gz` };
  });

const announce = H.command('announce')
  .input(z.object({ channel: z.string(), version: z.string() }))
  .output(z.object({ messageId: z.string() }))
  .runner(local)
  .effect('unrepeatable')
  .detect(async (input, ctx) => {
    const found = await ctx.exec(['release-notify', 'find', '--channel', input.channel, '--tag', input.version]);
    return found.code === 0 && found.stdout.trim() ? { messageId: found.stdout.trim() } : undefined;
  })
  .run(async (input, ctx) => {
    const posted = await ctx.exec(['release-notify', 'post', '--channel', input.channel, '--tag', input.version]);
    return { messageId: posted.stdout.trim() };
  });

const reviewerRole = H.role('release-reviewer').prompt('Review the release artifact and changelog for risk.').intents(['read', 'shell']);
const reviewSkill = H.skill('review-release')
  .input(z.object({ version: z.string(), artifact: z.string() }))
  .output(z.object({ approve: z.boolean(), notes: z.string() }))
  .prompt(i => `Review release ${i.version}, artifact ${i.artifact}.`);
const reviewer = H.seat('release-reviewer').role(reviewerRole).skill(reviewSkill).models(sonnet);

const writerRole = H.role('release-writer').prompt('Write release notes for users.');
const summarySkill = H.skill('summarize-release')
  .input(z.object({ version: z.string(), notes: z.string() }))
  .output(z.object({ summary: z.string() }))
  .prompt(i => `Summarise release ${i.version}:\n${i.notes}`);
const summarizer = H.seat('release-summarizer').role(writerRole).skill(summarySkill).models(haiku);
const summarizeBatch = H.job('summarize-release-batch').batch(summarizer);

const releaseApproval = H.halt('release-approval')
  .context(z.object({ version: z.string(), notes: z.string() }))
  .decision(z.object({ approved: z.boolean() }))
  .ask(c => `Ship ${c.version}?\n${c.notes}`);

const releaseFlow = H.flow('release')
  .input(releaseSchema)
  .step('build', build, s => ({ version: s.input.version, commit: s.input.commit }))
  .step('announce', announce, s => ({ channel: s.input.channel, version: s.input.version }))
  .step('review', reviewer, s => ({ version: s.input.version, artifact: s.build.artifact }))
  .when(s => !s.review.approve, f => f.exit('rejected'))
  .halt('approval', releaseApproval, s => ({ version: s.input.version, notes: s.review.notes }))
  .when(s => !s.approval.approved, f => f.exit('rejected'))
  .step('summarize', summarizeBatch, s => [{ version: s.input.version, notes: s.review.notes }])
  .spawn('smoke', smokeLane, s =>
    platforms.map(p => ({ key: `${s.input.version}-${p}`, data: { version: s.input.version, platform: p } })),
  )
  .when(s => s.smoke.some(child => child.verdict !== 'success'), f => f.exit('smokeFailed'))
  .exit('released');

const releases = H.lane('releases')
  .of(release)
  .from(manual('operator-releases'))
  .store(sqlite.store('./release/releases.sqlite'))
  .handle(releaseFlow, {
    exits: { released, rejected, smokeFailed: smokeBroken },
    retry: { retries: 1, backoff: { initial: '5m', factor: 2 }, exhausted: stalled },
  })
  .wip(1);

export const harness = H.harness('release')
  .ledger(sqlite.ledger('./release/ledger.sqlite'))
  .pools(pool)
  .lanes(releases, smokeLane)
  .grants(
    H.grant(
      claudeCode.client({ name: 'release-manager' }),
      H.ops.work.read,
      H.ops.work.write,
      H.ops.resolve(releaseApproval),
      H.ops.attempts.manage,
      H.ops.telemetry.read,
    ),
  )
  .observe(observers.board({ path: './release/BOARD.md' }), observers.telemetry({ path: './release/TELEMETRY.md' }));

export const running = harness.start();
