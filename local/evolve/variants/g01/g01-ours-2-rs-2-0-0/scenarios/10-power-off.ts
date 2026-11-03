import { z } from 'zod';
import { H } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { sqlite } from 'harness-dsl/sqlite';
import { supply } from 'harness-dsl/supply';
import { policies } from 'harness-dsl/policies';
import { observers } from 'harness-dsl/observers';

const chatUrl = H.env('CHAT_API_URL');
const chatToken = H.env('CHAT_TOKEN');

const local = H.runner.local('local', { slots: 4 });
const store = sqlite.store('./release/.harness/store.sqlite');

const opus = H.model('claude-opus-4-1').pricing(anthropic.pricing());
const haiku = H.model('claude-haiku-4-5').pricing(anthropic.pricing());

const subscription = H.account('max-1', claudeCode.driver({ configDir: H.env('CLAUDE_CONFIG_MAX_1') }));
const batchApi = H.account('batch-api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') }));

const platformSchema = z.enum(['linux', 'macos', 'windows']);

const releaseSchema = z.object({
  version: z.string(),
  commit: z.string(),
  channel: z.string(),
  platforms: z.array(platformSchema),
});
const smokeSchema = z.object({ version: z.string(), platform: platformSchema });

const requested = H.state('requested').pending();
const releasing = H.state('releasing').active();
const released = H.state('released').terminal('success');
const rejected = H.state('rejected').terminal('neutral');
const smokeFailed = H.state('smoke-failed').terminal('failure');
const releaseFailed = H.state('release-failed').terminal('failure');

const release = H.work('release').schema(releaseSchema).states(requested, releasing, released, rejected, smokeFailed, releaseFailed);

const smokeQueued = H.state('smoke-queued').pending();
const smoking = H.state('smoking').active();
const smokePassed = H.state('smoke-passed').terminal('success');
const smokeBroken = H.state('smoke-broken').terminal('failure');

const smoke = H.work('smoke').schema(smokeSchema).states(smokeQueued, smoking, smokePassed, smokeBroken);

const runSmoke = H.command('run-smoke')
  .input(smokeSchema)
  .runner(local)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.sh(`./bin/smoke --platform ${input.platform} --version ${input.version}`);
    if (result.code !== 0) throw new Error(result.stdout);
  });

const smokeFlow = H.flow('smoke').input(smokeSchema).step('smoke', runSmoke).exit('passed');

const smokes = H.lane(
  'smoke',
  H.handler('smoke')
    .of(smoke)
    .flow(smokeFlow)
    .exits({ passed: smokePassed })
    .retry({ tries: 2, backoff: 'linear', delaySeconds: 60, exhausted: smokeBroken }),
)
  .store(store)
  .wip(3);

const build = H.command('build')
  .input(z.object({ version: z.string(), commit: z.string() }))
  .output(z.object({ artifact: z.string() }))
  .runner(local)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.sh(`make release VERSION=${input.version} COMMIT=${input.commit}`);
    if (result.code !== 0) throw new Error(result.stderr);
    return { artifact: `dist/release-${input.version}.tar.gz` };
  });

const channelMessages = z.object({ messages: z.array(z.object({ id: z.string(), text: z.string() })) });
const postedMessage = z.object({ id: z.string() });

const announce = H.command('announce')
  .input(z.object({ version: z.string(), channel: z.string() }))
  .output(z.object({ messageId: z.string() }))
  .runner(local)
  .effect('unrepeatable')
  .detect(async (input, ctx) => {
    const response = await fetch(
      `${ctx.resolve(chatUrl)}/channels/${input.channel}/messages?search=${encodeURIComponent(input.version)}`,
      { headers: { authorization: `Bearer ${ctx.resolve(chatToken)}` } },
    );
    const found = channelMessages.parse(await response.json()).messages.find(m => m.text.includes(`Release ${input.version}`));
    return found === undefined ? undefined : { messageId: found.id };
  })
  .run(async (input, ctx) => {
    const response = await fetch(`${ctx.resolve(chatUrl)}/channels/${input.channel}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.resolve(chatToken)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: `Release ${input.version} is on its way.` }),
    });
    if (!response.ok) throw new Error(`chat answered ${response.status}`);
    return { messageId: postedMessage.parse(await response.json()).id };
  });

const reviewerRole = H.role('release-reviewer')
  .prompt('Review the release artifact and changelog for risk. Be specific.')
  .intents(['read', 'shell']);

const reviewSkill = H.skill('review-release')
  .input(z.object({ version: z.string(), artifact: z.string() }))
  .output(z.object({ risk: z.enum(['low', 'medium', 'high']), notes: z.string() }))
  .prompt(i => `Review release ${i.version}; artifact at ${i.artifact}.`);

const summarizerRole = H.role('release-summarizer').prompt('Write release notes for users.').intents([]);

const summarySkill = H.skill('summarize-release')
  .input(z.object({ version: z.string(), notes: z.string() }))
  .output(z.object({ text: z.string() }))
  .prompt(i => `Release ${i.version}. Reviewer notes:\n${i.notes}`);

const reviewer = H.seat('release-reviewer').role(reviewerRole).models(opus);
const summarizer = H.seat('release-summarizer').role(summarizerRole).models(haiku);

const approval = H.halt('release-approval')
  .context(z.object({ version: z.string(), risk: z.string(), notes: z.string() }))
  .ask(c => `Ship ${c.version}? Risk ${c.risk}.\n${c.notes}`)
  .decision(z.object({ approved: z.boolean() }));

type ReleaseExit = 'released' | 'smoke-failed';

const releaseFlow = H.flow('release')
  .input(releaseSchema)
  .step('build', build, s => ({ version: s.input.version, commit: s.input.commit }))
  .step('announce', announce, s => ({ version: s.input.version, channel: s.input.channel }))
  .step('review', reviewer.call(reviewSkill), s => ({ version: s.input.version, artifact: s.steps.build.artifact }))
  .halt('approval', approval, s => ({ version: s.input.version, risk: s.steps.review.risk, notes: s.steps.review.notes }))
  .when(s => !s.steps.approval.approved, f => f.exit('rejected'))
  .batch('summarize', {
    items: s => [{ version: s.input.version, notes: s.steps.review.notes }],
    call: summarizer.call(summarySkill),
  })
  .spawn('smoke', smokes, s => s.input.platforms.map(platform => ({ version: s.input.version, platform })))
  .exit((s): ReleaseExit => (s.steps.smoke.every(child => child.verdict === 'success') ? 'released' : 'smoke-failed'));

const releases = H.lane(
  'releases',
  H.handler('release')
    .of(release)
    .flow(releaseFlow)
    .exits({ rejected, released, 'smoke-failed': smokeFailed })
    .retry({ tries: 1, backoff: 'none', exhausted: releaseFailed }),
)
  .from(supply.manual())
  .store(store)
  .wip(1);

export const releaseHarness = H.harness('release')
  .ledger(sqlite.ledger('./release/.harness/ledger.sqlite'))
  .pools(
    H.pool('review', [subscription]).serves(opus).policy(policies.soonestExpiring()),
    H.pool('batch', [batchApi]).serves(haiku),
  )
  .lanes(releases, smokes)
  .scheduler(H.scheduler().policy(H.policy.schedule('smoke-before-releases', input => [...input.of(smokes), ...input.of(releases)])))
  .grants(
    H.grant(
      claudeCode.client('release-manager', { session: 'release' }),
      H.ops.resolve(approval),
      H.ops.work.read,
      H.ops.work.write,
      H.ops.telemetry.read,
    ),
  )
  .observe(observers.board({ path: './release/BOARD.md' }), observers.telemetry({ path: './release/TELEMETRY.md' }));
