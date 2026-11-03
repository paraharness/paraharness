import { z } from 'zod';
import { H } from 'harness-dsl';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { sqlite } from 'harness-dsl/sqlite';
import { http } from 'harness-dsl/http';
import { supply } from 'harness-dsl/supply';
import { observers } from 'harness-dsl/observers';

const chatUrl = H.env('CHAT_URL');
const chatToken = H.env('CHAT_TOKEN');

const buildHost = H.runner.local('build-host', { slots: 2 });
const sshKey = H.env('SMOKE_SSH_KEY');
const platformRunners = {
  linux: H.runner.ssh('smoke-linux', { host: H.env('SMOKE_LINUX_HOST'), user: 'ci', key: sshKey, slots: 1 }),
  macos: H.runner.ssh('smoke-macos', { host: H.env('SMOKE_MACOS_HOST'), user: 'ci', key: sshKey, slots: 1 }),
  windows: H.runner.ssh('smoke-windows', { host: H.env('SMOKE_WINDOWS_HOST'), user: 'ci', key: sshKey, slots: 1 }),
};

const subscription = H.account('claude-subscription', claudeCode.driver({ configDir: H.env('CLAUDE_CONFIG_DIR') }));
const api = H.account('anthropic-api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') }));
const opus = H.model('claude-opus-4-1').pricing(anthropic.pricing());
const haiku = H.model('claude-haiku-4-5').pricing(anthropic.pricing());

const platform = z.enum(['linux', 'macos', 'windows']);
const releaseSchema = z.object({ version: z.string(), notes: z.string(), channel: z.string(), platforms: z.array(platform) });
const smokeSchema = z.object({ version: z.string(), platform, artifact: z.string() });

const requested = H.state('requested').pending();
const releasing = H.state('releasing').active();
const released = H.state('released').terminal('success');
const rejected = H.state('rejected').terminal('neutral');
const smokeFailed = H.state('smoke-failed').terminal('failure');
const releaseBroken = H.state('release-broken').terminal('failure');
const release = H.work('release').schema(releaseSchema).states(requested, releasing, released, rejected, smokeFailed, releaseBroken);

const smokeQueued = H.state('smoke-queued').pending();
const smoking = H.state('smoking').active();
const smokePassed = H.state('smoke-passed').terminal('success');
const smokeBroken = H.state('smoke-broken').terminal('failure');
const smoke = H.work('smoke').schema(smokeSchema).states(smokeQueued, smoking, smokePassed, smokeBroken);

const build = H.command('build')
  .input(z.object({ version: z.string() }))
  .output(z.object({ artifact: z.string() }))
  .runner(buildHost)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.sh(`./scripts/build.sh ${input.version}`);
    if (result.code === 0) return { artifact: result.stdout.trim() };
    throw new Error(result.stderr);
  });

const chatMessages = z.object({ messages: z.array(z.object({ id: z.string(), text: z.string() })) });
const chatPosted = z.object({ id: z.string() });

const announce = H.command('announce')
  .input(z.object({ version: z.string(), channel: z.string() }))
  .output(z.object({ messageId: z.string() }))
  .runner(buildHost)
  .effect('unrepeatable')
  .detect(async (input, ctx) => {
    const res = await fetch(`${ctx.resolve(chatUrl)}/channels/${input.channel}/messages?search=${encodeURIComponent(input.version)}`, {
      headers: { authorization: `Bearer ${ctx.resolve(chatToken)}` },
    });
    const match = chatMessages.parse(await res.json()).messages.find(m => m.text.includes(`release ${input.version}`));
    return match === undefined ? undefined : { messageId: match.id };
  })
  .run(async (input, ctx) => {
    const res = await fetch(`${ctx.resolve(chatUrl)}/channels/${input.channel}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.resolve(chatToken)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: `Starting release ${input.version}` }),
    });
    return { messageId: chatPosted.parse(await res.json()).id };
  });

const smokeTest = H.command('smoke-test')
  .input(smokeSchema)
  .runner(input => platformRunners[input.platform])
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.sh(`./scripts/smoke.sh ${input.artifact}`);
    if (result.code === 0) return;
    throw new Error(result.stderr);
  });

const reviewerRole = H.role('release-reviewer').promptFile('./prompts/release-reviewer.md').intents(['read', 'shell']);
const summarizerRole = H.role('release-summarizer').prompt('You write release summaries for customers.').intents(['read']);
const reviewer = H.seat('release-reviewer').role(reviewerRole).models(opus);
const summarizer = H.seat('release-summarizer').role(summarizerRole).models(haiku);

const reviewRelease = H.skill('review-release')
  .input(z.object({ version: z.string(), notes: z.string(), artifact: z.string() }))
  .output(z.object({ concerns: z.array(z.string()), recommend: z.boolean() }))
  .prompt(i => `Review release ${i.version} (${i.artifact}).\n\n${i.notes}`);

const summarizeRelease = H.skill('summarize-release')
  .input(z.object({ version: z.string(), notes: z.string(), concerns: z.array(z.string()) }))
  .output(z.object({ summary: z.string() }))
  .prompt(i => `Summarise release ${i.version}:\n${i.notes}\n\nKnown concerns:\n${i.concerns.join('\n')}`);

const approval = H.halt('release-approval')
  .context(z.object({ version: z.string(), concerns: z.array(z.string()), recommend: z.boolean() }))
  .ask(c => `Approve release ${c.version}? Reviewer ${c.recommend ? 'recommends' : 'does not recommend'} it.`)
  .decision(z.object({ approved: z.boolean(), note: z.string().optional() }));

const smokeFlow = H.flow('smoke').input(smokeSchema).step('smoke', smokeTest).exit('passed');

const smokes = H.lane('smoke')
  .of(smoke)
  .store(sqlite.store('./release/.harness/units.sqlite'))
  .handle(smokeFlow)
  .exits({ passed: smokePassed, failed: { tries: 2, backoff: 'linear', delaySeconds: 60, then: smokeBroken } });

const releaseFlow = H.flow('release')
  .input(releaseSchema)
  .step('build', build, s => ({ version: s.input.version }))
  .step('announce', announce, s => ({ version: s.input.version, channel: s.input.channel }))
  .step('review', reviewer.call(reviewRelease), s => ({ version: s.input.version, notes: s.input.notes, artifact: s.steps.build.artifact }))
  .halt('approval', approval, s => ({ version: s.input.version, concerns: s.steps.review.concerns, recommend: s.steps.review.recommend }))
  .when(s => s.steps.approval.approved === false, f => f.exit('rejected'))
  .batch('summarize', {
    items: s => [{ version: s.input.version, notes: s.input.notes, concerns: s.steps.review.concerns }],
    call: summarizer.call(summarizeRelease),
  })
  .spawn('smoke', smokes, s => s.input.platforms.map(p => ({ version: s.input.version, platform: p, artifact: s.steps.build.artifact })))
  .exit(s => (s.steps.smoke.every(c => c.verdict === 'success') ? 'released' : 'smokeFailed'));

const releases = H.lane('releases')
  .of(release)
  .from(supply.manual<z.infer<typeof releaseSchema>>().key(d => d.version))
  .store(sqlite.store('./release/.harness/units.sqlite'))
  .handle(releaseFlow)
  .exits({ released, rejected, smokeFailed, failed: { tries: 1, backoff: 'none', then: releaseBroken } })
  .wip(1);

const releaseManager = http.client('release-desk', { port: 8740, token: H.env('RELEASE_DESK_TOKEN') });
const supervisor = claudeCode.client('release-supervisor', { session: 'release' });

export const harness = H.harness('release')
  .ledger(sqlite.ledger('./release/.harness/ledger.sqlite'))
  .pools(
    H.pool('subscription', [subscription]).serves(opus),
    H.pool('api', [api]).serves(haiku),
  )
  .lanes(releases, smokes)
  .grants(
    H.grant(releaseManager, H.ops.resolve(approval), H.ops.work.read),
    H.grant(supervisor, H.ops.work.read, H.ops.work.write, H.ops.telemetry.read),
  )
  .observe(observers.board({ path: './release/BOARD.md' }), observers.telemetry({ path: './release/TELEMETRY.md' }));
