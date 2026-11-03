import { z } from 'zod';
import { H } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { sqlite } from 'harness-dsl/sqlite';
import { manual } from 'harness-dsl/supply';
import { runners } from 'harness-dsl/runners';
import { policies } from 'harness-dsl/policies';
import { observers } from 'harness-dsl/observers';

const api = H.account('anthropic-api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') }));
const sonnet = H.model('claude-sonnet-4-5').pricing(anthropic.pricing());
const haiku = H.model('claude-haiku-4-5').pricing(anthropic.pricing());
const buildHost = runners.local({ name: 'build-host', slots: 2 });

const releaseSchema = z.object({ version: z.string(), channel: z.string(), platforms: z.array(z.string()) });
const requested = H.state('requested').pending();
const shipped = H.state('shipped').terminal('success');
const rejected = H.state('rejected').terminal('failure');
const smokeFailed = H.state('smoke-failed').terminal('failure');
const releaseAbandoned = H.state('release-abandoned').terminal('failure');
const release = H.work('Release').schema(releaseSchema).states(requested, shipped, rejected, smokeFailed, releaseAbandoned);

const smokeSchema = z.object({ release: z.string(), platform: z.string() });
const smokeQueued = H.state('smoke-queued').pending();
const smokePassed = H.state('smoke-passed').terminal('success');
const smokeBroken = H.state('smoke-broken').terminal('failure');
const smoke = H.work('Smoke').schema(smokeSchema).states(smokeQueued, smokePassed, smokeBroken);

const build = H.command('build')
  .input(z.object({ version: z.string() }))
  .output(z.object({ artifact: z.string() }))
  .runner(buildHost)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const made = await ctx.exec(['make', 'release', `VERSION=${input.version}`]);
    if (made.code !== 0) throw new Error(made.stderr);
    return { artifact: `dist/release-${input.version}.tar.gz` };
  });

const announce = H.command('announce')
  .input(z.object({ version: z.string(), channel: z.string() }))
  .output(z.object({ messageId: z.string() }))
  .effect('unrepeatable')
  .detect(async (input, ctx) => {
    const found = await ctx.exec(['chat', 'find', input.channel, `Release ${input.version}`]);
    const id = found.stdout.trim();
    return found.code === 0 && id.length > 0 ? { messageId: id } : undefined;
  })
  .run(async (input, ctx) => {
    const posted = await ctx.exec(['chat', 'post', input.channel, `Release ${input.version} is rolling out`]);
    return { messageId: posted.stdout.trim() };
  });

const releaseReviewer = H.role('release-reviewer').promptFile('./prompts/release-reviewer.md').intents(['read']);
const reviewRelease = H.skill('review-release')
  .input(z.object({ version: z.string(), artifact: z.string() }))
  .output(z.object({ notes: z.string(), concerns: z.array(z.string()) }))
  .prompt(i => `Review release ${i.version} built as ${i.artifact}.`);
const reviewerSeat = H.seat('release-reviewer').role(releaseReviewer).skill(reviewRelease).models(sonnet);

const summaryWriter = H.role('summary-writer').prompt('Write release notes for customers.');
const summarizeRelease = H.skill('summarize-release')
  .input(z.object({ version: z.string(), notes: z.string() }))
  .output(z.object({ summary: z.string() }))
  .prompt(i => `Release ${i.version}. Reviewer notes:\n${i.notes}`);
const summarizerSeat = H.seat('summarizer').role(summaryWriter).skill(summarizeRelease).models(haiku);
const releaseSummary = H.job('release-summary').batch(summarizerSeat);

const approval = H.halt('release-approval')
  .context(z.object({ version: z.string(), notes: z.string(), concerns: z.array(z.string()) }))
  .decision(z.object({ approved: z.boolean() }));

const releaseFlow = H.flow('release')
  .input(releaseSchema)
  .step('build', build, s => ({ version: s.input.version }))
  .step('announce', announce, s => ({ version: s.input.version, channel: s.input.channel }))
  .step('review', reviewerSeat, s => ({ version: s.input.version, artifact: s.build.artifact }))
  .halt('approval', approval, s => ({ version: s.input.version, notes: s.review.notes, concerns: s.review.concerns }))
  .when(s => !s.approval.approved, f => f.exit('rejected'))
  .step('summarize', releaseSummary, s => [{ version: s.input.version, notes: s.review.notes }])
  .spawn('smoke', smokeLane(), s => s.input.platforms.map(p => ({ key: `${s.input.version}-${p}`, data: { release: s.input.version, platform: p } })))
  .when(s => s.smoke.some(r => r.verdict !== 'success'), f => f.exit('smokeFailed'))
  .exit('shipped');

const smokeTest = H.command('smoke-test')
  .input(smokeSchema)
  .output(z.object({ ok: z.boolean() }))
  .runner(buildHost)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const ran = await ctx.exec(['./scripts/smoke.sh', input.release, input.platform]);
    return { ok: ran.code === 0 };
  });
const smokeFlow = H.flow('smoke')
  .input(smokeSchema)
  .step('test', smokeTest, s => s.input)
  .when(s => !s.test.ok, f => f.exit('broken'))
  .exit('passed');

function smokeLane() {
  return smokes;
}
const smokes = H.lane('smoke')
  .of(smoke)
  .store(sqlite.store('./.harness/units.sqlite'))
  .handle(smokeFlow, {
    exits: { passed: smokePassed, broken: smokeBroken },
    retry: { retries: 1, backoff: { initial: '1m', factor: 2 }, exhausted: smokeBroken },
  })
  .wip(4);

const releases = H.lane('releases')
  .of(release)
  .from(manual('release-desk'))
  .store(sqlite.store('./.harness/units.sqlite'))
  .handle(releaseFlow, {
    exits: { shipped, rejected, smokeFailed },
    retry: { retries: 1, backoff: { initial: '5m', factor: 2 }, exhausted: releaseAbandoned },
  })
  .wip(1);

const pool = H.pool('api', [api]).serves(sonnet, haiku).policy(policies.soonestReset());

const releasesFirst = H.policy.units('releases-first', c => [
  ...c.candidates.filter(releases.holds),
  ...c.candidates.filter(x => !releases.holds(x)),
]);

export const releaseHarness = H.harness('release')
  .ledger(sqlite.ledger('./.harness/ledger.sqlite'))
  .pools(pool)
  .lanes(releases, smokes)
  .scheduler(releasesFirst)
  .grants(
    H.grant(
      claudeCode.client({ name: 'release-manager' }),
      H.ops.resolve(approval),
      H.ops.attempts.manage,
      H.ops.work.read,
      H.ops.work.write,
      H.ops.telemetry.read,
    ),
  )
  .observe(observers.board({ path: './BOARD.md' }), observers.telemetry({ path: './TELEMETRY.md' }));
