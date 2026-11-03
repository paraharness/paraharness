import { z } from 'zod';
import { H } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { pgvector } from 'harness-dsl/pgvector';
import { voyage } from 'harness-dsl/voyage';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const topicCeilingUsd = 3;
const dailyBudgetUsd = 40;

const topicItem = z.object({ title: z.string(), question: z.string(), recurring: z.boolean() });

const Open = H.state('Open', 'pending');
const Delivered = H.terminal('Delivered', 'success');
const Parked = H.terminal('Parked', 'neutral');
const Cancelled = H.terminal('Cancelled', 'neutral');
const Failed = H.terminal('Failed', 'failure');

const Topic = H.kind('Topic')
  .attributes(topicItem)
  .states(Open, Delivered, Parked, Cancelled, Failed)
  .key(a => a.title)
  .initial(Open);

const researchQuota = sqlite.quota('research-api', { path: './.harness/quota.sqlite' });
const researchAccount = anthropic.account('research-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota: researchQuota });
const researchPool = H.pool('research').accounts(researchAccount);
const cheapModel = anthropic.model('haiku', { id: 'claude-haiku-4-5' });
const strongA = anthropic.model('opus', { id: 'claude-opus-4-1' });
const strongB = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });

const searcherRole = H.role('searcher')
  .intents('search', 'browse', 'read')
  .instructions('Search for sources on the angle given and extract claims, each with its source URL.');
const synthesizerRole = H.role('synthesizer')
  .intents('read')
  .instructions('Write a sourced report. Every claim cites a URL from the findings.');

const searcher = H.seat('searcher')
  .role(searcherRole)
  .model(cheapModel)
  .pool(researchPool)
  .output(z.object({ findings: z.array(z.object({ claim: z.string(), source: z.string() })) }));

const synthesizerChoice = H.policy.model('synthesizer-choice', [strongA, strongB], ctx => {
  const a = ctx.metrics.rate(citationPass, { model: strongA, window: { lastDays: 30 } });
  const b = ctx.metrics.rate(citationPass, { model: strongB, window: { lastDays: 30 } });
  if (a.samples < 20) return strongA;
  if (b.samples < 20) return strongB;
  return a.rate >= b.rate ? strongA : strongB;
});

const synthesizer = H.seat('synthesizer')
  .role(synthesizerRole)
  .model(synthesizerChoice)
  .pool(researchPool)
  .output(z.object({ report: z.string(), citations: z.array(z.string()), keyFinding: z.string() }));

const searchBatch = H.batch('search-extract', searcher);

const citationCheck = H.command('citation-check')
  .input(z.object({ citations: z.array(z.string()) }))
  .argv(i => ['./scripts/check-citations.sh', ...i.citations])
  .runner(local.runner('local'));

const angles = Array.from({ length: 20 }, (_, index) => index + 1);

const research = H.flow('research')
  .input(topicItem)
  .job('gather', searchBatch, ctx =>
    angles.map(angle => ({
      task: `Angle ${angle} of 20 on: ${ctx.unit.attributes.question}. Find sources and extract their claims.`,
    })),
  )
  .exit('parked', ctx => ctx.steps.gather.flatMap(result => result.findings).length < 5)
  .step('synthesize', synthesizer, ctx => ({
    task: `Write a sourced report on: ${ctx.unit.attributes.question}\n\nFindings:\n${ctx.steps.gather
      .flatMap(result => result.findings)
      .map(f => `- ${f.claim} (${f.source})`)
      .join('\n')}`,
  }))
  .step('cite', citationCheck, ctx => ({ citations: ctx.steps.synthesize.citations }), { afterCrash: 'rerun' })
  .exit('delivered');

const topicLane = H.lane('topics', Topic)
  .supply(H.operator)
  .handler(research, { exits: { parked: Parked, delivered: Delivered } })
  .store(sqlite.store({ path: './.harness/topics.sqlite' }))
  .retry({ maxAttempts: 2, backoff: 'fixed', initialDelayMs: 600000, exhausted: Failed })
  .ceiling({ maxUsd: topicCeilingUsd, onExceed: 'fail' })
  .on(H.cancel, { enter: Cancelled });

const citationPass = H.metric('citation-pass', H.when.step(topicLane, 'cite')).samples(e => [
  { hit: e.ok, model: e.modelOf(synthesizer) },
]);

const researchSpend = H.metric('research-spend', H.when.invocation({ lanes: [topicLane] })).amounts(e => [
  { amount: e.costUsd },
]);

const succeededAttemptCost = H.metric(
  'succeeded-attempt-cost',
  H.when.transition(topicLane, { to: [Delivered, Parked] }),
).amounts(e => (e.attempt === undefined ? [] : [{ amount: e.attempt.costUsd }]));

const weekly = H.clock('weekly-reopen').at('06:00', { on: 'mon', tz: 'UTC' });

const reopenRecurring = H.trigger('reopen-recurring')
  .on(H.when.tick(weekly, topicLane, { in: [Delivered, Parked] }))
  .create(topicLane, e => (e.unit.attributes.recurring ? e.unit.attributes : undefined));

const embedder = voyage.embedder('voyage', { id: 'voyage-3', apiKey: H.env('VOYAGE_API_KEY') });

const findingsJournal = H.journal('prior-findings', H.memory('prior-findings', 'experience'))
  .store(pgvector.memoryStore({ url: H.env('FINDINGS_DATABASE_URL'), table: 'findings', embedder }))
  .recall({ by: 'similarity', limit: 8 })
  .readBy(synthesizerRole);

const sourceJournal = H.journal('source-experience', H.memory('source-experience', 'experience'))
  .store(jsonl.memoryStore({ path: './memory/sources.jsonl' }))
  .recall({ by: 'specificity', limit: 10 })
  .readBy(searcherRole, synthesizerRole);

const recordFinding = H.trigger('record-finding')
  .on(H.when.step(topicLane, 'cite', { if: e => e.ok }))
  .record(findingsJournal, e => {
    const report = e.outputs.synthesize;
    return report === undefined
      ? undefined
      : {
          text: `When researching ${e.unit.attributes.title}, start from the finding "${report.keyFinding}", because the delivered report established it with checked citations.`,
          when: { kinds: [Topic] },
        };
  });

const scheduler = H.scheduler('research')
  .standard(topicLane)
  .admit(topicLane, ctx => {
    const spentToday = ctx.metrics.total(researchSpend, { window: { calendar: 'day', tz: 'UTC' } });
    const succeeded = ctx.metrics.total(succeededAttemptCost, { window: { lastDays: 30 } });
    const projected = succeeded.samples === 0 ? topicCeilingUsd : succeeded.total / succeeded.samples;
    return spentToday.total + projected <= dailyBudgetUsd;
  });

const supervisor = claudeCode.supervisor('research-supervisor', {
  grants: [H.ops.workRead, H.ops.workCreate, H.ops.workCancel, H.ops.memoryRead, H.ops.memoryWrite, H.ops.telemetryRead],
  port: H.slot.port(0),
});

export const researchHarness = H.harness('research-pipeline')
  .ledger(sqlite.ledger({ path: './.harness/ledger.sqlite' }))
  .lanes(topicLane)
  .journals(findingsJournal, sourceJournal)
  .triggers(reopenRecurring, recordFinding)
  .metrics(citationPass, researchSpend, succeededAttemptCost)
  .scheduler(scheduler)
  .clients(supervisor)
  .observers(markdown.board({ path: './BOARD.md' }), markdown.telemetry({ path: './TELEMETRY.md' }));

void researchHarness.start();
