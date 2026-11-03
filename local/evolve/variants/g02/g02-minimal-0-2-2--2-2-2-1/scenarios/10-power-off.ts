import { z } from 'zod';
import { H } from 'harness-dsl';
import * as cc from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const local = shell.local('local', { slots: 4 });
const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const opus = anthropic.model('claude-opus-4-1');
const haiku = anthropic.model('claude-haiku-4-5');
const store = 'release/.harness/store.sqlite';

const requested = H.state('requested', 'pending');
const smoking = H.state('smoking', 'waiting');
const released = H.state('released', 'terminal', 'success');
const smokeFailed = H.state('smoke-failed', 'terminal', 'failure');
const rejected = H.state('rejected', 'terminal', 'neutral');
const abandoned = H.state('abandoned', 'terminal', 'failure');

const release = H.kind('release')
  .data(z.object({
    version: z.string(),
    channel: z.string(),
    platforms: z.array(z.string()),
    summary: z.string().optional(),
  }))
  .states(requested, smoking, released, smokeFailed, rejected, abandoned);

const queued = H.state('queued', 'pending');
const passed = H.state('passed', 'terminal', 'success');
const failed = H.state('failed', 'terminal', 'failure');
const smoke = H.kind('smoke')
  .data(z.object({ version: z.string(), platform: z.string() }))
  .states(queued, passed, failed);

const build = H.command('build')
  .input(z.object({ version: z.string() }))
  .output(z.object({ artifact: z.string() }))
  .argv(i => ['make', 'release', `VERSION=${i.version}`])
  .on(local)
  .recovery('rerun');

const announcement = z.object({ version: z.string(), channel: z.string() });
const announcementPosted = H.command('announcement-posted')
  .input(announcement)
  .output(z.boolean())
  .argv(i => ['./release/announced.sh', i.channel, i.version])
  .on(local);
const announce = H.command('announce')
  .input(announcement)
  .argv(i => ['./release/announce.sh', i.channel, i.version])
  .on(local)
  .recovery(announcementPosted);

const reviewerRole = H.role('release-reviewer')
  .input(z.object({ version: z.string(), artifact: z.string() }))
  .output(z.object({ notes: z.string() }))
  .prompt(i => `Review release ${i.version} built as ${i.artifact}. Report risks.`);
const reviewer = H.seat('release-reviewer', reviewerRole).model(opus);

const summarizerRole = H.role('release-summarizer')
  .input(z.object({ version: z.string(), notes: z.string() }))
  .output(z.object({ summary: z.string() }))
  .prompt(i => `Write release notes for ${i.version} from:\n${i.notes}`);
const summarizer = H.seat('release-summarizer', summarizerRole).model(haiku);
const summarize = H.batch('summarize', summarizer);

const approval = H.halt('release-approval', z.object({ release: z.boolean() }))
  .about(z.object({ version: z.string(), notes: z.string() }));

const smokeTest = H.command('smoke-test')
  .input(z.object({ version: z.string(), platform: z.string() }))
  .argv(i => ['./release/smoke.sh', i.platform, i.version])
  .on(local)
  .recovery('rerun');

const runSmoke = H.flow('run-smoke').for(smoke).does(async ctx => {
  const result = await ctx.call(smokeTest, ctx.unit.data);
  return result.ok ? 'passed' : 'failed';
});

const smokes = H.lane('smoke', smoke)
  .handler(runSmoke)
  .store(sqlite.store(smoke, store))
  .wip(4);

const shipRelease = H.flow('ship-release').for(release).does(async ctx => {
  const d = ctx.unit.data;
  const built = await ctx.call(build, { version: d.version });
  if (!built.ok) return ctx.fail(built.error);
  const posted = await ctx.call(announce, { version: d.version, channel: d.channel });
  if (!posted.ok) return ctx.fail(posted.error);
  const reviewed = await ctx.call(reviewer, { version: d.version, artifact: built.value.artifact });
  if (!reviewed.ok) return ctx.fail(reviewed.error);
  const approved = await ctx.halt(approval, `Approve release ${d.version}?`, { version: d.version, notes: reviewed.value.notes });
  if (!approved.release) return 'rejected';
  const summaries = await ctx.call(summarize, [{ version: d.version, notes: reviewed.value.notes }]);
  if (!summaries.ok) return ctx.fail(summaries.error);
  const first = summaries.value[0];
  if (first === undefined || !first.ok) return ctx.fail('release summary missing');
  await ctx.update({ summary: first.value.summary });
  const children = await ctx.spawn(smokes, d.platforms.map(platform => ({ version: d.version, platform })));
  const finished = await ctx.wait('smoking', { children });
  return finished.every(child => child.state === 'passed') ? 'released' : 'smoke-failed';
});

const releases = H.lane('releases', release)
  .handler(shipRelease)
  .suppliers(H.operator)
  .store(sqlite.store(release, store))
  .wip(1)
  .retry(H.retry('release-retry', { retries: 1, backoff: { initialMs: 300_000 } }), 'abandoned');

export const releaseHarness = H.harness('release')
  .ledger(sqlite.ledger('release/.harness/ledger.sqlite'))
  .lanes(releases, smokes)
  .pools(H.pool('api', [{ account: apiAccount, share: 1 }]))
  .clients(cc.supervisor({
    grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolve(approval, H.parked), H.ops.readTelemetry],
  }))
  .observers(markdown.board('release/BOARD.md'), markdown.telemetry('release/TELEMETRY.md'));
