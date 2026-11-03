import { H } from 'harness-dsl';
import { z } from 'zod';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const subscription = claudeCode.subscription('max-release', { token: H.env('CLAUDE_RELEASE_TOKEN') });
const apiAccount = anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const opus = claudeCode.model('claude-opus-4-1');
const haiku = anthropic.model('claude-haiku-4-5');
const releasePool = H.pool('release', [
  { account: subscription, share: 1 },
  { account: apiAccount, share: 1 }
]);
const localRunner = shell.local('local', { slots: 4 });

const platforms = z.enum(['linux', 'macos', 'windows']);

const requested = H.state('requested', 'pending');
const smoking = H.state('smoking', 'waiting');
const released = H.state('released', 'terminal', 'success');
const rejected = H.state('rejected', 'terminal', 'failure');
const smokeFailed = H.state('smoke-failed', 'terminal', 'failure');

const release = H.kind('Release')
  .data(z.object({ version: z.string(), platforms: z.array(platforms), summary: z.string().optional() }))
  .states(requested, smoking, released, rejected, smokeFailed);

const queued = H.state('queued', 'pending');
const passed = H.state('passed', 'terminal', 'success');
const failed = H.state('failed', 'terminal', 'failure');

const smoke = H.kind('Smoke').data(z.object({ release: z.string(), platform: platforms })).states(queued, passed, failed);

const versionInput = z.object({ version: z.string() });

const build = H.command('build')
  .input(versionInput)
  .argv(input => ['./release/build', input.version])
  .on(localRunner)
  .recovery('rerun');

const announcePosted = H.command('announce-posted')
  .input(versionInput)
  .output(z.boolean())
  .argv(input => ['./release/announce-posted', input.version])
  .on(localRunner);

const announce = H.command('announce')
  .input(versionInput)
  .argv(input => ['./release/announce', input.version])
  .on(localRunner)
  .recovery(announcePosted);

const reviewRole = H.role('release-reviewer')
  .input(z.object({ version: z.string(), artifacts: z.string() }))
  .output(z.object({ notes: z.string() }))
  .prompt(input => `Review release ${input.version}. Build output:\n${input.artifacts}`)
  .intents(['read']);

const summaryRole = H.role('release-summarizer')
  .input(z.object({ version: z.string(), notes: z.string() }))
  .output(z.object({ text: z.string() }))
  .prompt(input => `Write release notes for ${input.version} from this review:\n${input.notes}`);

const reviewer = H.seat('reviewer', reviewRole).model(opus).on(localRunner);
const summarizer = H.seat('summarizer', summaryRole).model(haiku);

const approval = H.halt('release-approval', z.object({ approve: z.boolean() })).about(versionInput);

const runSmoke = H.command('run-smoke')
  .input(z.object({ release: z.string(), platform: platforms }))
  .argv(input => ['./release/smoke', input.release, input.platform])
  .on(localRunner)
  .recovery('rerun');

const shipRelease = H.flow('ship-release')
  .for(release)
  .does(async ctx => {
    const version = ctx.unit.data.version;
    const built = await ctx.run(build, { version });
    if (!built.ok) return ctx.fail(built.error);
    const announced = await ctx.run(announce, { version });
    if (!announced.ok) return ctx.fail(announced.error);
    const reviewed = await ctx.run(reviewer, { version, artifacts: built.value });
    if (!reviewed.ok) return ctx.fail(reviewed.error);
    const decision = await ctx.halt(approval, reviewed.value.notes, { version });
    if (!decision.approve) return 'rejected';
    const summaries = await ctx.batch(summarizer, [{ version, notes: reviewed.value.notes }]);
    const summary = summaries.find(result => result.ok);
    if (!summary || !summary.ok) return ctx.fail('summary batch returned no result');
    await ctx.update({ summary: summary.value.text });
    const children = await ctx.spawn(
      smokeLane,
      ctx.unit.data.platforms.map(platform => ({ release: version, platform }))
    );
    const results = await ctx.wait('smoking', { children });
    return results.every(result => result.state === 'passed') ? 'released' : 'smoke-failed';
  });

const smokeTest = H.flow('smoke-test')
  .for(smoke)
  .does(async ctx => {
    const result = await ctx.run(runSmoke, { release: ctx.unit.data.release, platform: ctx.unit.data.platform });
    return result.ok ? 'passed' : 'failed';
  });

const releaseLane = H.lane('releases', release)
  .handler(shipRelease)
  .suppliers(H.operator)
  .store(sqlite.store(release, '.harness/releases.db'))
  .retry('never', 'rejected');
const smokeLane = H.lane('smoke', smoke).handler(smokeTest).store(sqlite.store(smoke, '.harness/smoke.db')).wip(3);

export const harness = H.harness('release')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(releaseLane, smokeLane)
  .pools(releasePool)
  .clients(
    claudeCode.supervisor({
      grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolve(approval), H.ops.resolveHalts, H.ops.readTelemetry]
    })
  )
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
