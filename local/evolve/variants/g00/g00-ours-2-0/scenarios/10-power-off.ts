import { z } from 'zod';
import { H } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { sqlite } from 'harness-dsl/sqlite';
import { supply } from 'harness-dsl/supply';
import { policies } from 'harness-dsl/policies';
import { observers } from 'harness-dsl/observers';

const apiAccount = H.account('anthropic-api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') }));
const sonnet = H.model('claude-sonnet-4-5').pricing(anthropic.pricing());
const haiku = H.model('claude-haiku-4-5').pricing(anthropic.pricing());
const apiPool = H.pool('api', [apiAccount]).serves(sonnet, haiku).policy(policies.soonestExpiring());

const buildBox = H.runner.local('build-box', { slots: 2 });
const deviceLab = H.runner.local('device-lab', { slots: 3 });
const store = sqlite.store('.harness/units.sqlite');

const requested = H.state('requested').pending();
const releasing = H.state('releasing').active();
const released = H.state('released').terminal('success');
const smokeFailed = H.state('smoke-failed').terminal('failure');
const rejected = H.state('rejected').terminal('neutral');
const releaseFailed = H.state('release-failed').terminal('failure');
const abandoned = H.state('abandoned').terminal('neutral');

const releaseSchema = z.object({ version: z.string(), channel: z.string() });
const releaseKind = H.work('Release').schema(releaseSchema).states(requested, releasing, released, smokeFailed, rejected, releaseFailed, abandoned);

const queuedSmoke = H.state('queued-smoke').pending();
const smoking = H.state('smoking').active();
const smokePassed = H.state('smoke-passed').terminal('success');
const smokeBroken = H.state('smoke-broken').terminal('failure');
const smokeSchema = z.object({ version: z.string(), platform: z.enum(['linux', 'macos', 'windows']) });
const smokeKind = H.work('Smoke').schema(smokeSchema).states(queuedSmoke, smoking, smokePassed, smokeBroken);

const chatApi = H.env('CHAT_API_URL');
const chatToken = H.env('CHAT_TOKEN');

const build = H.command('build')
  .input(releaseSchema)
  .output(z.object({ artifact: z.string() }))
  .runner(buildBox)
  .effect('repeatable')
  .run(async (i, ctx) => {
    const result = await ctx.sh(`make release VERSION=${i.version}`, { timeoutSeconds: 3600 });
    if (result.code !== 0) throw new Error(result.stderr);
    return { artifact: `dist/app-${i.version}.tar.gz` };
  });

const announce = H.command('announce')
  .input(releaseSchema)
  .output(z.object({ messageId: z.string() }))
  .effect('unrepeatable')
  .detect(async (i, ctx) => {
    const response = await fetch(`${ctx.resolve(chatApi)}/channels/${i.channel}/messages?tag=release-${i.version}`, {
      headers: { authorization: `Bearer ${ctx.resolve(chatToken)}` },
    });
    const found = z.array(z.object({ id: z.string() })).parse(await response.json());
    const first = found[0];
    return first ? { messageId: first.id } : undefined;
  })
  .run(async (i, ctx) => {
    const response = await fetch(`${ctx.resolve(chatApi)}/channels/${i.channel}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.resolve(chatToken)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: `Release ${i.version} is on its way.`, tag: `release-${i.version}` }),
    });
    return z.object({ id: z.string() }).transform((m) => ({ messageId: m.id })).parse(await response.json());
  });

const reviewerRole = H.role('release-reviewer').promptFile('prompts/release-reviewer.md').intents(['read', 'shell']);
const reviewer = H.agent('release-reviewer').role(reviewerRole).model(sonnet);
const reviewRelease = H.skill('review-release')
  .input(z.object({ version: z.string(), artifact: z.string() }))
  .output(z.object({ notes: z.string(), concerns: z.array(z.string()) }))
  .prompt((i) => `Review release ${i.version}, artifact ${i.artifact}.`);

const summarizerRole = H.role('release-summarizer').prompt('Write release notes for users.');
const summarizer = H.agent('release-summarizer').role(summarizerRole).model(haiku);
const summarizeRelease = H.skill('summarize-release')
  .input(z.object({ version: z.string(), notes: z.string() }))
  .output(z.object({ releaseNotes: z.string() }))
  .prompt((i) => `Release ${i.version}. Reviewer notes:\n${i.notes}`);

const releaseApproval = H.halt('release-approval')
  .context(z.object({ version: z.string(), notes: z.string(), concerns: z.array(z.string()) }))
  .ask((c) => `Ship ${c.version}?\n\n${c.notes}\n\nConcerns:\n${c.concerns.join('\n')}`)
  .decision(z.object({ approved: z.boolean(), comment: z.string() }));

const runSmoke = H.command('run-smoke')
  .input(smokeSchema)
  .output(z.object({ passed: z.boolean() }))
  .runner(deviceLab)
  .effect('repeatable')
  .run(async (i, ctx) => {
    const result = await ctx.sh(`./smoke.sh ${i.platform} ${i.version}`, { timeoutSeconds: 1800 });
    return { passed: result.code === 0 };
  });

const smokeTest = H.flow('smoke-test')
  .input(smokeSchema)
  .step('smoke', runSmoke)
  .exit((s) => (s.steps.smoke.passed ? 'passed' : 'broken'));

const smoke = H.lane('smoke')
  .of(smokeKind)
  .from(supply.manual())
  .store(store)
  .handle(smokeTest)
  .exits({ passed: smokePassed, broken: smokeBroken })
  .retry({ tries: 1, backoff: 'linear', delaySeconds: 60, exhausted: smokeBroken })
  .wip(3);

const platforms = smokeSchema.shape.platform.options;

const shipRelease = H.flow('ship-release')
  .input(releaseSchema)
  .step('build', build)
  .step('announce', announce)
  .step('review', reviewer.call(reviewRelease), (s) => ({ version: s.input.version, artifact: s.steps.build.artifact }))
  .halt('approval', releaseApproval, (s) => ({
    version: s.input.version,
    notes: s.steps.review.notes,
    concerns: s.steps.review.concerns,
  }))
  .when((s) => !s.steps.approval.approved, (f) => f.exit('rejected'))
  .batch('summarize', {
    items: (s) => [{ version: s.input.version, notes: s.steps.review.notes }],
    call: summarizer.call(summarizeRelease),
  })
  .spawn('smoke', smoke, (s) => platforms.map((platform) => ({ version: s.input.version, platform })))
  .exit((s) => (s.steps.smoke.every((child) => child.verdict === 'success') ? 'released' : 'smokeFailed'));

const releases = H.lane('releases')
  .of(releaseKind)
  .from(supply.manual())
  .store(store)
  .handle(shipRelease)
  .exits({ released, smokeFailed, rejected })
  .retry({ tries: 1, backoff: 'none', exhausted: releaseFailed })
  .wip(1);

export const release = H.harness('release')
  .ledger(sqlite.ledger('.harness/ledger.sqlite'))
  .pools(apiPool)
  .lanes(releases, smoke)
  .scheduler(H.scheduler().policy(H.policy.schedule('oldest-first', ({ candidates }) => [...candidates].sort((a, b) => b.waitingSeconds - a.waitingSeconds))))
  .grants(
    H.grant(
      claudeCode.client('release-manager', { session: 'release-manager' }),
      H.ops.work.read,
      H.ops.work.write,
      H.ops.resolve(releaseApproval),
      H.ops.telemetry.read,
    ),
  )
  .observe(observers.board({ path: '.harness/board.md' }));
