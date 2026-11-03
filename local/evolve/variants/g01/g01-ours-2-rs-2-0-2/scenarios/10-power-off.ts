import { z } from 'zod';
import { H } from 'harness-dsl';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { sqlite } from 'harness-dsl/sqlite';
import { supply } from 'harness-dsl/supply';
import { observers } from 'harness-dsl/observers';

const local = H.runner.local('release-box', { slots: 3 });
const channelUrl = H.env('RELEASE_CHANNEL_URL');
const channelToken = H.env('RELEASE_CHANNEL_TOKEN');

const subscription = H.account('claude-max', claudeCode.driver({ configDir: H.env('CLAUDE_CONFIG_DIR') }));
const apiAccount = H.account('anthropic-api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') }));
const sonnet = H.model('claude-sonnet-4-5').pricing(anthropic.pricing());
const subscriptionPool = H.pool('subscription', [subscription]).serves(sonnet).fallback(apiAccount);
const batchPool = H.pool('batch-api', [apiAccount]).serves(sonnet);

const requested = H.state('requested').pending();
const releasing = H.state('releasing').active();
const shipped = H.state('shipped').terminal('success');
const rejected = H.state('rejected').terminal('neutral');
const releaseFailed = H.state('release-failed').terminal('failure');

const releaseSchema = z.object({ releaseId: z.string(), version: z.string(), commit: z.string() });
const release = H.work('release').schema(releaseSchema).states(requested, releasing, shipped, rejected, releaseFailed);

const smokeQueued = H.state('smoke-queued').pending();
const smoking = H.state('smoking').active();
const smokePassed = H.state('smoke-passed').terminal('success');
const smokeFailed = H.state('smoke-failed').terminal('failure');

const smokeSchema = z.object({ releaseId: z.string(), version: z.string(), platform: z.string() });
const smokeTest = H.work('smoke-test').schema(smokeSchema).states(smokeQueued, smoking, smokePassed, smokeFailed);

const buildRelease = H.command('build')
  .input(releaseSchema)
  .output(z.object({ artifact: z.string() }))
  .runner(local)
  .effect('repeatable')
  .run(async (i, ctx) => {
    const result = await ctx.sh(`make release VERSION=${i.version} COMMIT=${i.commit}`);
    if (result.code !== 0) throw new Error(result.stderr);
    return { artifact: `dist/${i.version}.tar.gz` };
  });

const postedMessages = z.object({ messages: z.array(z.object({ id: z.string() })) });
const announceRelease = H.command('announce')
  .input(z.object({ releaseId: z.string(), version: z.string(), artifact: z.string() }))
  .output(z.object({ messageId: z.string() }))
  .runner(local)
  .effect('unrepeatable')
  .detect(async (i, ctx) => {
    const response = await fetch(`${ctx.resolve(channelUrl)}/messages?tag=${i.releaseId}`, {
      headers: { authorization: `Bearer ${ctx.resolve(channelToken)}` },
    });
    const first = postedMessages.parse(await response.json()).messages[0];
    return first === undefined ? undefined : { messageId: first.id };
  })
  .run(async (i, ctx) => {
    const response = await fetch(`${ctx.resolve(channelUrl)}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.resolve(channelToken)}` },
      body: JSON.stringify({ tag: i.releaseId, text: `Releasing ${i.version}: ${i.artifact}` }),
    });
    return z.object({ id: z.string() }).transform(m => ({ messageId: m.id })).parse(await response.json());
  });

const runSmoke = H.command('run-smoke')
  .input(smokeSchema)
  .output(z.object({ passed: z.boolean() }))
  .runner(local)
  .effect('repeatable')
  .run(async (i, ctx) => {
    const result = await ctx.sh(`make smoke VERSION=${i.version} PLATFORM=${i.platform}`);
    return { passed: result.code === 0 };
  });

const reviewerRole = H.role('release-reviewer').prompt('Review the release diff and list risks.').intents(['read']);
const summarizerRole = H.role('release-summarizer').prompt('Write release notes for users.');

const reviewRelease = H.skill('review-release')
  .input(z.object({ version: z.string(), commit: z.string() }))
  .output(z.object({ risks: z.array(z.string()), notes: z.string() }))
  .prompt(i => `Review release ${i.version} at ${i.commit}.`);
const summarizeRelease = H.skill('summarize-release')
  .input(z.object({ version: z.string(), notes: z.string() }))
  .output(z.object({ text: z.string() }))
  .prompt(i => `Release notes for ${i.version}:\n${i.notes}`);

const reviewer = H.seat('release-reviewer').role(reviewerRole).models(sonnet);
const summarizer = H.seat('release-summarizer').role(summarizerRole).models(sonnet);

const approval = H.halt('release-approval')
  .context(z.object({ version: z.string(), risks: z.array(z.string()) }))
  .ask(c => `Approve ${c.version}? Risks:\n${c.risks.join('\n')}`)
  .decision(z.object({ approved: z.boolean() }));

const platforms = ['linux', 'macos', 'windows'];

const smokeFlow = H.flow('smoke')
  .input(smokeSchema)
  .step('run', runSmoke)
  .exit(s => (s.steps.run.passed ? 'passed' : 'failed'));

const smoke = H.lane('smoke')
  .of(smokeTest)
  .wip(3)
  .handle(smokeFlow, {
    exits: { passed: smokePassed, failed: smokeFailed },
    retry: { tries: 2, backoff: 'linear', delaySeconds: 60, exhausted: smokeFailed },
  });

const releaseFlow = H.flow('release')
  .input(releaseSchema)
  .step('build', buildRelease)
  .step('announce', announceRelease, s => ({ releaseId: s.input.releaseId, version: s.input.version, artifact: s.steps.build.artifact }))
  .step('review', reviewer.call(reviewRelease), s => ({ version: s.input.version, commit: s.input.commit }))
  .halt('approval', approval, s => ({ version: s.input.version, risks: s.steps.review.risks }))
  .when(s => !s.steps.approval.approved, f => f.exit('rejected'))
  .step('summarize', summarizer.batch(summarizeRelease), s => [{ version: s.input.version, notes: s.steps.review.notes }])
  .spawn('smoke', smoke, s => platforms.map(platform => ({ releaseId: s.input.releaseId, version: s.input.version, platform })))
  .exit(s => (s.steps.smoke.every(child => child.verdict === 'success') ? 'shipped' : 'smoke-failed'));

const releases = H.lane('releases')
  .of(release)
  .from(supply.manual(releaseSchema).key(d => d.releaseId))
  .store(sqlite.store('.harness/units.db'))
  .wip(1)
  .handle(releaseFlow, {
    exits: { rejected, shipped, 'smoke-failed': releaseFailed },
    retry: { tries: 1, backoff: 'linear', delaySeconds: 300, exhausted: releaseFailed },
  });

const releasesFirst = H.policy.schedule('smoke-then-releases', ({ candidates }) => [
  ...candidates.filter(c => c.lane === smoke),
  ...candidates.filter(c => c.lane === releases),
]);

export default H.harness('release')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .pools(subscriptionPool, batchPool)
  .lanes(releases, smoke)
  .schedule(releasesFirst)
  .grants(
    H.grant(
      claudeCode.client('release-manager'),
      H.ops.work.read,
      H.ops.work.write,
      H.ops.resolve(approval),
      H.ops.telemetry.read,
    ),
  )
  .observe(observers.board({ path: '.harness/board.md' }));
