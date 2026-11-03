import { z } from 'zod';
import { H } from 'harness-dsl';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { sqlite } from 'harness-dsl/sqlite';
import { manual } from 'harness-dsl/supply';
import { runners } from 'harness-dsl/runners';
import { policies } from 'harness-dsl/policies';
import { observers } from 'harness-dsl/observers';

const local = runners.local({ name: 'release-host', slots: 2 });

const subscription = H.account('claude-max', claudeCode.driver({ configDir: '~/.claude' }));
const apiAccount = H.account('anthropic-api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') }));
const opus = H.model('claude-opus-4-1').pricing(anthropic.pricing());
const sonnet = H.model('claude-sonnet-4-5').pricing(anthropic.pricing());
const pool = H.pool('release', [subscription, apiAccount]).serves(opus, sonnet).policy(policies.soonestReset()).fallback(apiAccount);

const smokeSchema = z.object({ version: z.string(), platform: z.string() });
const smokeQueued = H.state('queued').pending();
const smokePassed = H.state('passed').terminal('success');
const smokeFailed = H.state('failed').terminal('failure');
const smoke = H.work('Smoke').schema(smokeSchema).states(smokeQueued, smokePassed, smokeFailed);

const smokeTest = H.command('smoke-test')
  .input(smokeSchema)
  .output(z.object({ ok: z.boolean() }))
  .runner(local)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec(['smoke', '--platform', input.platform, '--version', input.version]);
    return { ok: result.code === 0 };
  });

const smokeFlow = H.flow('smoke')
  .input(smokeSchema)
  .step('test', smokeTest, s => s.input)
  .when(s => !s.test.ok, f => f.exit('failed'))
  .exit('passed');

const smokeLane = H.lane('smoke').of(smoke)
  .store(sqlite.store('./.harness/smoke.sqlite'))
  .handle(smokeFlow, { exits: { passed: smokePassed, failed: smokeFailed }, retry: { retries: 1, exhausted: smokeFailed } })
  .wip(4);

const releaseSchema = z.object({ version: z.string(), changelog: z.string(), platforms: z.array(z.string()) });
const requested = H.state('requested').pending();
const released = H.state('released').terminal('success');
const rejected = H.state('rejected').terminal('failure');
const smokeRed = H.state('smoke-failed').terminal('failure');
const broken = H.state('broken').terminal('failure');
const release = H.work('Release').schema(releaseSchema).states(requested, released, rejected, smokeRed, broken);

const build = H.command('build')
  .input(z.object({ version: z.string() }))
  .output(z.object({ artifact: z.string() }))
  .runner(local)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec(['make', 'release', `VERSION=${input.version}`]);
    if (result.code !== 0) throw new Error(result.stderr);
    return { artifact: result.stdout.trim() };
  });

const announce = H.command('announce')
  .input(z.object({ version: z.string(), artifact: z.string() }))
  .output(z.object({ messageId: z.string() }))
  .runner(local)
  .effect('unrepeatable')
  .detect(async (input, ctx) => {
    const found = await ctx.exec(['chat', 'find', '--channel', 'releases', '--text', `Release ${input.version}`]);
    const id = found.stdout.trim();
    return found.code === 0 && id !== '' ? { messageId: id } : undefined;
  })
  .run(async (input, ctx) => {
    const posted = await ctx.exec(['chat', 'post', '--channel', 'releases', `Release ${input.version}: ${input.artifact}`]);
    return { messageId: posted.stdout.trim() };
  });

const reviewerRole = H.role('release-reviewer').prompt('Review the release changelog for risk.').intents(['read']);
const reviewSkill = H.skill('review-release').input(z.object({ version: z.string(), changelog: z.string() })).output(z.object({ notes: z.string(), risky: z.boolean() }));
const reviewer = H.seat('release-reviewer').role(reviewerRole).skill(reviewSkill).models(opus);

const summarizerRole = H.role('release-summarizer').prompt('Write release notes for customers.');
const summarizeSkill = H.skill('summarize-release').input(z.object({ version: z.string(), changelog: z.string(), notes: z.string() })).output(z.object({ summary: z.string() }));
const summarizer = H.seat('release-summarizer').role(summarizerRole).skill(summarizeSkill).models(sonnet);
const summarizeBatch = H.job('summarize').batch(summarizer);

const approval = H.halt('release-approval')
  .context(z.object({ version: z.string(), notes: z.string(), risky: z.boolean() }))
  .decision(z.object({ approved: z.boolean() }))
  .ask(c => `Ship ${c.version}?`);

const releaseFlow = H.flow('release')
  .input(releaseSchema)
  .step('build', build, s => ({ version: s.input.version }))
  .step('announce', announce, s => ({ version: s.input.version, artifact: s.build.artifact }))
  .step('review', reviewer, s => ({ version: s.input.version, changelog: s.input.changelog }))
  .halt('approval', approval, s => ({ version: s.input.version, notes: s.review.notes, risky: s.review.risky }))
  .when(s => !s.approval.approved, f => f.exit('rejected'))
  .step('summarize', summarizeBatch, s => [{ version: s.input.version, changelog: s.input.changelog, notes: s.review.notes }])
  .spawn('smoke', smokeLane, s => s.input.platforms.map(platform => ({ key: `${s.input.version}-${platform}`, data: { version: s.input.version, platform } })))
  .when(s => s.smoke.some(child => child.verdict !== 'success'), f => f.exit('smoke-failed'))
  .exit('released');

const releases = H.lane('releases').of(release)
  .from(manual('release-managers'))
  .store(sqlite.store('./.harness/releases.sqlite'))
  .handle(releaseFlow, { exits: { rejected, 'smoke-failed': smokeRed, released }, retry: { retries: 1, exhausted: broken } })
  .wip(1);

const releaseManager = claudeCode.client({ name: 'release-manager' });

export const harness = H.harness('release')
  .ledger(sqlite.ledger('./.harness/ledger.sqlite'))
  .pools(pool)
  .lanes(releases, smokeLane)
  .scheduler(H.policy.units('oldest-first', choice => [...choice.candidates].sort((a, b) => a.queuedAt.getTime() - b.queuedAt.getTime())))
  .grants(H.grant(releaseManager, H.ops.resolve(approval), H.ops.attempts.manage, H.ops.work.read, H.ops.work.write, H.ops.telemetry.read))
  .observe(observers.board({ path: './BOARD.md' }));
