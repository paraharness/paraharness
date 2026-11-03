import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { local } from 'harness-dsl/local';
import { ssh } from 'harness-dsl/ssh';
import { markdown } from 'harness-dsl/markdown';

const workstation = local.runner('release-box').slots(2);
const quota = sqlite.quota('release-quota', { path: './.harness/quota.sqlite' });

const subscription = claudeCode.subscription('release-subscription', { token: H.env('CLAUDE_TOKEN'), quota });
const api = anthropic.account('release-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });

const sessionPool = H.pool('release-sessions').accounts(subscription);
const batchPool = H.pool('release-batch').accounts(api);

const reviewModel = claudeCode.model('review-opus', { id: 'claude-opus-4-1' });
const summaryModel = anthropic.model('summary-haiku', { id: 'claude-haiku-4-5' });

const NeedsOwner = H.state('NeedsOwner', 'waiting');

const Requested = H.state('Requested', 'pending');
const Released = H.terminal('Released', 'success');
const Rejected = H.terminal('Rejected', 'neutral');
const SmokeFailed = H.terminal('SmokeFailed', 'failure');

const releaseAttrs = z.object({ version: z.string(), channel: z.string() });
const release = H.kind('Release').attributes(releaseAttrs).states(Requested, NeedsOwner, Released, Rejected, SmokeFailed).key(a => a.version);

const platformSchema = z.enum(['linux', 'macos', 'windows']);
const platforms = platformSchema.options;

const Queued = H.state('Queued', 'pending');
const Passed = H.terminal('Passed', 'success');
const Broken = H.terminal('Broken', 'failure');

const smokeAttrs = z.object({ version: z.string(), platform: platformSchema });
const smoke = H.kind('Smoke').attributes(smokeAttrs).states(Queued, Passed, Broken).key(a => `${a.version}/${a.platform}`);

const smokeHosts = {
  linux: ssh.host('smoke-linux', { host: 'smoke-linux.internal', user: 'ci', key: H.env('SMOKE_SSH_KEY') }),
  macos: ssh.host('smoke-macos', { host: 'smoke-macos.internal', user: 'ci', key: H.env('SMOKE_SSH_KEY') }),
  windows: ssh.host('smoke-windows', { host: 'smoke-windows.internal', user: 'ci', key: H.env('SMOKE_SSH_KEY') }),
};

const smokeTest = H.command('smoke-test')
  .input(smokeAttrs)
  .argv(i => ['./scripts/smoke.sh', i.version])
  .output(z.object({ passed: z.boolean() }))
  .runner(i => smokeHosts[i.platform]);

const smokeFlow = H.flow('smoke')
  .input(smokeAttrs)
  .step('run', smokeTest, ctx => ctx.unit.attributes, { afterCrash: 'rerun' })
  .exit('passed', ctx => ctx.steps.run.passed)
  .exit('broken');

const smokes = H.lane('smoke', smoke)
  .store(sqlite.store({ path: './.harness/units.sqlite' }))
  .handler(smokeFlow, { exits: { passed: Passed, broken: Broken } })
  .retry({ maxAttempts: 2, exhausted: Broken });

const build = H.command('build')
  .input(z.object({ version: z.string() }))
  .argv(i => ['./scripts/build.sh', i.version])
  .output(z.object({ artifact: z.string() }))
  .runner(workstation);

const announcement = z.object({ version: z.string(), channel: z.string() });

const announce = H.command('announce')
  .input(announcement)
  .argv(i => ['./scripts/post-announcement.sh', i.channel, i.version])
  .runner(workstation);

const announcementPosted = H.command('announcement-posted')
  .input(announcement)
  .argv(i => ['./scripts/find-announcement.sh', i.channel, i.version])
  .output(z.boolean())
  .runner(workstation);

const reviewerRole = H.role('release-reviewer')
  .intents('read', 'search')
  .instructions('Review the release artifact and its changelog for blocking problems.');
const summarizerRole = H.role('release-summarizer')
  .intents('read')
  .instructions('Write the release notes summary for customers.');

const reviewer = H.seat('release-reviewer')
  .role(reviewerRole)
  .model(reviewModel)
  .pool(sessionPool)
  .output(z.object({ blocking: z.array(z.string()), notes: z.string() }));

const summarizer = H.seat('release-summarizer')
  .role(summarizerRole)
  .model(summaryModel)
  .pool(batchPool)
  .output(z.object({ summary: z.string() }));

const approval = H.halt('release-approval').decision(z.object({ approved: z.boolean(), notes: z.string() }));

const releaseFlow = H.flow('release')
  .input(releaseAttrs)
  .step('build', build, ctx => ({ version: ctx.unit.attributes.version }), { afterCrash: 'rerun' })
  .step('announce', announce, ctx => ({ version: ctx.unit.attributes.version, channel: ctx.unit.attributes.channel }), {
    afterCrash: 'park',
    alreadyDone: announcementPosted,
  })
  .step('review', reviewer, ctx => ({ task: `Review release ${ctx.unit.attributes.version}, artifact ${ctx.steps.build.artifact}.` }), {
    afterCrash: 'askDriver',
  })
  .halt('approval', approval, {
    ask: ctx => `Approve release ${ctx.unit.attributes.version}?\n\nBlocking: ${ctx.steps.review.blocking.join('; ') || 'none'}\n${ctx.steps.review.notes}`,
  })
  .exit('rejected', ctx => !ctx.steps.approval.approved)
  .job('summarize', summarizer, ctx => [{ task: `Summarise release ${ctx.unit.attributes.version}.\n\n${ctx.steps.review.notes}` }])
  .spawn('smoke', smokes, ctx => platforms.map(platform => ({ version: ctx.unit.attributes.version, platform })))
  .exit('released', ctx => ctx.steps.smoke.every(child => child.verdict === 'success'))
  .exit('smokeFailed');

const releases = H.lane('releases', release)
  .supply(H.operator)
  .store(sqlite.store({ path: './.harness/units.sqlite' }))
  .handler(releaseFlow, { exits: { rejected: Rejected, released: Released, smokeFailed: SmokeFailed } })
  .retry({ maxAttempts: 1, exhausted: NeedsOwner });

const releaseManager = claudeCode.supervisor('release-manager', {
  port: H.slot.port(0),
  grants: [H.ops.workRead, H.ops.workCreate, H.ops.resolve(approval), H.ops.attemptsRecover, H.ops.telemetryRead],
});

export default H.harness('release')
  .ledger(sqlite.ledger({ path: './.harness/ledger.sqlite' }))
  .lanes(releases, smokes)
  .scheduler(H.scheduler('release-scheduler').standard(releases, smokes).wip(releases, 1))
  .clients(releaseManager)
  .observers(markdown.board({ path: './.harness/BOARD.md' }));
