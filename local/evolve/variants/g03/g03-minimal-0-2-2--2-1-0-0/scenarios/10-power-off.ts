import { H } from 'harness-dsl';
import { z } from 'zod';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const local = shell.local('release-local', { slots: 2 });
const opus = anthropic.model('claude-opus-4-1');
const haiku = anthropic.model('claude-haiku-4-5');

const requested = H.state('requested', 'pending');
const smoking = H.state('smoking', 'waiting');
const released = H.state('released', 'terminal', 'success');
const rejected = H.state('rejected', 'terminal', 'neutral');
const smokeFailed = H.state('smoke-failed', 'terminal', 'failure');
const abandoned = H.state('abandoned', 'terminal', 'failure');

const release = H.kind('Release')
  .data(z.object({ version: z.string(), channel: z.string(), summary: z.string().optional() }))
  .states(requested, smoking, released, rejected, smokeFailed, abandoned);

const queued = H.state('queued', 'pending');
const passed = H.state('passed', 'terminal', 'success');
const failed = H.state('failed', 'terminal', 'failure');

const smoke = H.kind('Smoke')
  .data(z.object({ version: z.string(), platform: z.string() }))
  .states(queued, passed, failed);

const build = H.command('build')
  .input(z.object({ version: z.string() }))
  .output(z.object({ artifact: z.string(), notes: z.string() }))
  .argv((input) => ['make', 'release', `VERSION=${input.version}`])
  .on(local)
  .recovery('rerun');

const findAnnouncement = H.command('find-announcement')
  .input(z.object({ version: z.string(), channel: z.string() }))
  .output(z.boolean())
  .argv((input) => ['chat', 'search', input.channel, `Release ${input.version}`])
  .on(local)
  .recovery('rerun');

const announce = H.command('announce')
  .input(z.object({ version: z.string(), channel: z.string() }))
  .argv((input) => ['chat', 'post', input.channel, `Release ${input.version} is on its way`])
  .on(local)
  .recovery(findAnnouncement);

const reviewerRole = H.role('release-reviewer')
  .input(z.object({ version: z.string(), notes: z.string() }))
  .output(z.object({ verdict: z.string(), concerns: z.array(z.string()) }))
  .prompt((input) => `Review release ${input.version}. Build notes:\n${input.notes}`);

const summarizerRole = H.role('release-summarizer')
  .input(z.object({ version: z.string(), verdict: z.string() }))
  .output(z.object({ text: z.string() }))
  .prompt((input) => `Write release notes for ${input.version} given this review: ${input.verdict}`);

const reviewer = H.seat('release-reviewer', reviewerRole).model(opus).on(local);
const summarizer = H.seat('release-summarizer', summarizerRole).model(haiku);

const approval = H.halt('release-approval', z.object({ approved: z.boolean(), note: z.string().optional() })).about(
  z.object({ version: z.string(), concerns: z.array(z.string()) })
);

const smokeResult = z.object({ passed: z.boolean(), report: z.string() });

const submitSmoke = H.command('submit-smoke')
  .input(z.object({ version: z.string(), platform: z.string() }))
  .output(z.string())
  .argv((input) => ['ci', 'smoke', 'submit', input.version, input.platform])
  .on(local)
  .recovery('park');

const pollSmoke = H.command('poll-smoke')
  .input(z.string())
  .output(
    z.discriminatedUnion('status', [
      z.object({ status: z.literal('running') }),
      z.object({ status: z.literal('done'), result: smokeResult }),
      z.object({ status: z.literal('failed'), error: z.string() }),
    ])
  )
  .argv((jobId) => ['ci', 'smoke', 'status', jobId])
  .on(local)
  .recovery('rerun');

const smokeRun = H.job('smoke-run').output(smokeResult).submit(submitSmoke).collect(pollSmoke, { minutes: 2 });

const runSmoke = H.flow('run-smoke')
  .for(smoke)
  .does(async (ctx) => {
    const ran = await ctx.run(smokeRun, { version: ctx.unit.data.version, platform: ctx.unit.data.platform });
    if (!ran.ok) return ctx.fail(ran.error);
    return ran.value.passed ? 'passed' : 'failed';
  });

const smokes = H.lane('smoke', smoke).handler(runSmoke).retries(0, { exhausted: 'failed' }).wip(3);

const platforms = ['linux', 'macos', 'windows'];

const shipRelease = H.flow('ship-release')
  .for(release)
  .does(async (ctx) => {
    const version = ctx.unit.data.version;
    const built = await ctx.run(build, { version });
    if (!built.ok) return ctx.fail(built.error);
    const announced = await ctx.run(announce, { version, channel: ctx.unit.data.channel });
    if (!announced.ok) return ctx.fail(announced.error);
    const reviewed = await ctx.run(reviewer, { version, notes: built.value.notes });
    if (!reviewed.ok) return ctx.fail(reviewed.error);
    const decision = await ctx.halt(approval, reviewed.value.verdict, { version, concerns: reviewed.value.concerns });
    if (!decision.approved) return 'rejected';
    const [summary] = await ctx.batch(summarizer, [{ version, verdict: reviewed.value.verdict }]);
    if (!summary.ok) return ctx.fail(summary.error);
    await ctx.update({ summary: summary.value.text });
    const children = await ctx.spawn(smokes, platforms.map((platform) => ({ version, platform })));
    const results = await ctx.suspend('smoking', { children });
    return results.every((child) => child.state === 'passed') ? 'released' : 'smoke-failed';
  });

const releases = H.lane('releases', release)
  .handler(shipRelease)
  .retries(0, { exhausted: 'abandoned' })
  .suppliers(H.operator)
  .store(sqlite.store(release, 'release/.harness/units.sqlite'));

export const harness = H.harness('release')
  .ledger(sqlite.ledger('release/.harness/ledger.sqlite'))
  .pools(H.pool('release-accounts', [{ account: anthropic.account('release-api', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 }]).serves(opus, haiku))
  .lanes(releases, smokes)
  .scheduler(H.policy.scheduler('releases-first', (view) => ({ start: view.sorted((unit) => (unit.is(release) ? 0 : 1)) })))
  .clients(
    claudeCode.supervisor({
      grants: [
        H.ops.readWork,
        H.ops.writeWork,
        H.ops.readTelemetry,
        H.ops.resolve(approval, H.halts.interrupted, H.halts.definitionChanged),
      ],
    })
  )
  .observers(markdown.board('release/BOARD.md'), markdown.telemetry('release/TELEMETRY.md'));
