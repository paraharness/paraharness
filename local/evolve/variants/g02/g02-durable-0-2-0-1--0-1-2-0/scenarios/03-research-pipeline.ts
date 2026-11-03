import { z } from 'zod';
import { H } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { pgvector } from 'harness-dsl/pgvector';
import { voyage } from 'harness-dsl/voyage';
import { local } from 'harness-dsl/local';
import { http } from 'harness-dsl/http';
import { markdown } from 'harness-dsl/markdown';

const topic = z.object({ title: z.string(), question: z.string(), recurring: z.boolean() });

const Open = H.state('Open', 'pending');
const Delivered = H.terminal('Delivered', 'success');
const Parked = H.terminal('Parked', 'neutral');
const Cancelled = H.terminal('Cancelled', 'neutral');
const Failed = H.terminal('Failed', 'failure');
const Topic = H.kind('Topic').attributes(topic).states(Open, Delivered, Parked, Cancelled, Failed).key(a => a.title);

const quota = sqlite.quota('research-quota', { path: '.harness/quota.db' });
const apiAccount = anthropic.account('research-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });
const api = H.pool('research-api').accounts(apiAccount);
const haiku = anthropic.model('haiku', { id: 'claude-haiku-4-5' });
const opus = anthropic.model('opus', { id: 'claude-opus-4-5' });
const opusPrior = anthropic.model('opus-prior', { id: 'claude-opus-4-1' });

const searcher = H.role('searcher').intents('search', 'browse').instructions('Search for sources on the angle given and extract claims with their source URLs.');
const synthesizer = H.role('synthesizer').intents('read').instructions('Write a sourced report. Cite every claim. Say when sources are insufficient.');

const synthesizerModel = H.policy.model('synthesizer-model', [opus, opusPrior], ({ seat, metrics }) => {
  const window = { lastDays: 60 };
  const current = metrics.rate(citationPass, { seat, model: opus, window });
  const rival = metrics.rate(citationPass, { seat, model: opusPrior, window });
  if (current.samples < 20) return opus;
  if (rival.samples < 20) return opusPrior;
  return rival.rate > current.rate ? opusPrior : opus;
});

const searcherSeat = H.seat('searcher')
  .role(searcher)
  .model(haiku)
  .pool(api)
  .output(z.object({ findings: z.array(z.object({ claim: z.string(), source: z.string() })) }));

const synthesizerSeat = H.seat('synthesizer')
  .role(synthesizer)
  .model(synthesizerModel)
  .pool(api)
  .output(z.object({
    sufficientSources: z.boolean(),
    report: z.string(),
    citations: z.array(z.string()),
    keyFindings: z.array(z.string()),
  }));

const citationCheck = H.command('check-citations')
  .input(z.object({ citations: z.array(z.string()) }))
  .argv(i => ['./bin/check-citations', ...i.citations])
  .runner(local.runner('local'));

const research = H.flow('research')
  .input(topic)
  .job('search', searcherSeat, ctx => Array.from({ length: 20 }, (_, index) => ({
    task: `Search angle ${index + 1} of 20 for: ${ctx.unit.attributes.question}`,
  })))
  .step('synthesize', synthesizerSeat, ctx => ({
    task: `Write a sourced report answering: ${ctx.unit.attributes.question}\n\n${ctx.steps.search
      .map(result => result.findings.map(f => `- ${f.claim} (${f.source})`).join('\n'))
      .join('\n')}`,
  }))
  .exit('parked', ctx => !ctx.steps.synthesize.sufficientSources)
  .step('citations', citationCheck, ctx => ({ citations: ctx.steps.synthesize.citations }))
  .exit('delivered');

const topicCost = H.halt('topic-cost').decision(H.ceilingDecision);

const topics = H.lane('topics', Topic)
  .supply(H.operator)
  .store(sqlite.store({ path: '.harness/topics.db' }))
  .handler(research, { exits: { parked: Parked, delivered: Delivered } })
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 300000, exhausted: Failed })
  .ceiling({ maxUsd: 3, halt: topicCost })
  .on(H.cancel, { enter: Cancelled });

const citationPass = H.metric('citation-check-pass', H.when.step(topics, 'citations')).samples(event => [
  { hit: event.ok, seat: synthesizerSeat, model: event.modelOf(synthesizerSeat) },
]);
const researchSpend = H.metric('research-spend', H.when.invocation({ lanes: [topics] })).amounts(event => [
  { amount: event.costUsd },
]);
const succeededAttemptCost = H.metric('succeeded-topic-attempt-cost', H.when.transition(topics, { to: [Delivered, Parked] }))
  .amounts(event => (event.attempt ? [{ amount: event.attempt.costUsd }] : []));

const findingsJournal = H.journal('prior-findings', H.memory('report-findings', 'experience'))
  .store(pgvector.memoryStore({
    url: H.env('PGVECTOR_URL'),
    table: 'report_findings',
    embedder: voyage.embedder('voyage', { id: 'voyage-3', apiKey: H.env('VOYAGE_API_KEY') }),
  }))
  .recall({ by: 'similarity', limit: 8 })
  .readBy(synthesizer);

const sourceJournal = H.journal('source-lessons', H.memory('source-experience', 'experience'))
  .store(jsonl.memoryStore({ path: '.harness/sources.jsonl' }))
  .recall({ by: 'specificity', limit: 10 })
  .readBy(searcher, synthesizer);

const recordFindings = H.trigger('report-findings-become-memory')
  .on(H.when.step(topics, 'synthesize', { if: event => event.ok }))
  .record(findingsJournal, event =>
    event.output
      ? {
          text: `When researching a topic like "${event.unit.attributes.title}", start from these findings, because an earlier report established them: ${event.output.keyFindings.join('; ')}`,
          when: { kinds: [Topic] },
        }
      : undefined);

const reopenRecurring = H.trigger('reopen-recurring-topics')
  .on(H.when.timer(topics, {
    in: [Delivered, Parked],
    at: unit => (unit.attributes.recurring ? H.nextTime('08:00', { on: 'mon', tz: 'UTC', after: unit.createdAt }) : undefined),
  }))
  .create(topics, event => event.unit.attributes);

const scheduler = H.scheduler('research')
  .standard(topics)
  .admit(topics, ({ metrics }) => {
    const spentToday = metrics.total(researchSpend, { window: { calendar: 'day', tz: 'UTC' } });
    const succeeded = metrics.total(succeededAttemptCost, { window: { lastDays: 30 } });
    const projected = succeeded.samples > 0 ? succeeded.total / succeeded.samples : 3;
    return spentToday.total + projected <= 40;
  });

const operatorApi = http.controlApi('operator', {
  port: H.slot.port(1),
  token: H.env('RESEARCH_CONTROL_TOKEN'),
  grants: [
    H.ops.workRead,
    H.ops.workCreate,
    H.ops.workCancel,
    H.ops.resolve(topicCost),
    H.ops.memoryRead,
    H.ops.memoryWrite,
    H.ops.telemetryRead,
  ],
});

const harness = H.harness('research-pipeline')
  .ledger(sqlite.ledger({ path: '.harness/ledger.db' }))
  .lanes(topics)
  .journals(findingsJournal, sourceJournal)
  .triggers(recordFindings, reopenRecurring)
  .metrics(citationPass, researchSpend, succeededAttemptCost)
  .scheduler(scheduler)
  .clients(operatorApi)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));

void harness.start();
