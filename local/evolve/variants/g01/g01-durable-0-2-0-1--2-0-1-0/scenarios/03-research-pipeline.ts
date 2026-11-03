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

const workstation = local.runner('research-box').slots(4);

const quota = sqlite.quota('research-quota', { path: '.harness/quota.sqlite' });
const apiAccount = anthropic.account('research-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });
const api = H.pool('research-api').accounts(apiAccount);

const haiku = anthropic.model('haiku', { id: 'claude-haiku-4-5' });
const opus = anthropic.model('opus', { id: 'claude-opus-4-1' });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });

const searcherRole = H.role('searcher')
  .intents('search', 'browse')
  .instructions('Search for the query and extract claims with their exact source URLs.');
const synthesizerRole = H.role('synthesizer')
  .intents('read', 'record')
  .instructions('Write a sourced report. Every claim cites one of the extracted sources.');

const priorFindings = H.memory('prior-findings', 'experience');
const sourceExperience = H.memory('source-experience', 'experience');

const priorFindingsJournal = H.journal('prior-findings', priorFindings)
  .store(
    pgvector.memoryStore({
      url: H.env('PGVECTOR_URL'),
      table: 'prior_findings',
      embedder: voyage.embedder('voyage', { id: 'voyage-3', apiKey: H.env('VOYAGE_API_KEY') }),
    }),
  )
  .recall({ by: 'similarity', limit: 8 })
  .readBy(synthesizerRole);

const sourceExperienceJournal = H.journal('source-experience', sourceExperience)
  .store(jsonl.memoryStore({ path: 'memory/sources.jsonl' }))
  .recall({ by: 'specificity', limit: 10 })
  .readBy(searcherRole, synthesizerRole)
  .recordedBy(synthesizerRole);

const synthesizerModel = H.policy.model('synthesizer-model', [opus, sonnet], ({ seat, metrics }) => {
  const window = { lastDays: 30 };
  const onOpus = metrics.rate(citationPass, { by: { seat, model: opus }, window });
  const onSonnet = metrics.rate(citationPass, { by: { seat, model: sonnet }, window });
  if (onOpus.samples < 25) return opus;
  if (onSonnet.samples < 25) return sonnet;
  return onSonnet.rate >= onOpus.rate ? sonnet : opus;
});

const searcher = H.seat('searcher')
  .role(searcherRole)
  .model(haiku)
  .pool(api)
  .output(z.object({ findings: z.array(z.object({ claim: z.string(), source: z.string() })) }));

const synthesizer = H.seat('synthesizer')
  .role(synthesizerRole)
  .model(synthesizerModel)
  .pool(api)
  .output(z.object({ report: z.string(), keyFindings: z.array(z.string()) }));

const planQueries = H.command('plan-queries')
  .input(z.object({ question: z.string() }))
  .argv((input) => ['./bin/plan-queries', '--count', '20', input.question])
  .output(z.object({ queries: z.array(z.string()) }))
  .runner(workstation);

const checkCitations = H.command('check-citations')
  .input(z.object({ report: z.string() }))
  .argv((input) => ['./bin/check-citations', '--report', input.report])
  .runner(workstation);

const topicSchema = z.object({ title: z.string(), question: z.string(), tags: z.array(z.string()) });

const research = H.flow('research')
  .input(topicSchema)
  .step('queries', planQueries, (ctx) => ({ question: ctx.unit.attributes.question }))
  .step('extract', searcher.batch(), (ctx) =>
    ctx.steps.queries.queries.map((query) => ({
      task: `Search and extract findings for: ${query}\nTopic question: ${ctx.unit.attributes.question}`,
    })),
  )
  .exit('parked', (ctx) => ctx.steps.extract.flatMap((result) => result.findings).length < 8)
  .step('synthesize', synthesizer, (ctx) => ({
    task: `Write a sourced report answering: ${ctx.unit.attributes.question}\nFindings: ${JSON.stringify(
      ctx.steps.extract.flatMap((result) => result.findings),
    )}`,
  }))
  .step('citeCheck', checkCitations, (ctx) => ({ report: ctx.steps.synthesize.report }))
  .exit('delivered');

const Queued = H.state('Queued', 'pending');
const Researching = H.state('Researching', 'active');
const AwaitingBatch = H.state('AwaitingBatch', 'waiting');
const Synthesizing = H.state('Synthesizing', 'active');
const Delivered = H.terminal('Delivered', 'success');
const Parked = H.terminal('Parked', 'neutral');
const Cancelled = H.terminal('Cancelled', 'neutral');
const Failed = H.terminal('Failed', 'failure');

const Topic = H.kind('Topic')
  .attributes(topicSchema)
  .states(Queued, Researching, AwaitingBatch, Synthesizing, Delivered, Parked, Cancelled, Failed)
  .key((topic) => topic.title)
  .initial(Queued);

const weekly = H.clock('weekly').at('06:00', { on: 'mon', tz: 'UTC' });

const topics = H.lane('topics', Topic)
  .supply(H.operator)
  .supply(
    sqlite.scan('recurring-topics', { path: '.harness/store.sqlite', kind: 'Topic', schedule: weekly }),
    (stored, to) => {
      const parsed = topicSchema.safeParse(stored.attributes);
      return parsed.success &&
        parsed.data.tags.includes('recurring') &&
        (stored.state === 'Delivered' || stored.state === 'Parked')
        ? to.create(parsed.data)
        : to.skip();
    },
  )
  .store(sqlite.store({ path: '.harness/store.sqlite' }))
  .handler(research, {
    exits: { parked: Parked, delivered: Delivered },
    during: {
      queries: Researching,
      extract: AwaitingBatch,
      synthesize: Synthesizing,
      citeCheck: Synthesizing,
    },
  })
  .retry({ maxAttempts: 2, backoff: 'fixed', initialDelayMs: 600_000, exhausted: Failed })
  .on(H.cancel, { enter: Cancelled })
  .ceiling({ maxUsd: 3, onExceed: 'fail' });

const citationPass = H.metric('citation-check-pass', H.when.step(topics, 'citeCheck')).samples((event) => [
  { hit: event.ok, by: { seat: synthesizer, model: event.invocations.synthesize?.model } },
]);

const dailySpend = H.metric('daily-model-spend', H.when.invocation({ lanes: [topics] })).amounts((event) => [
  { amount: event.costUsd },
]);

const succeededAttemptCost = H.metric(
  'succeeded-topic-attempt-cost',
  H.when.transition(topics, { to: Delivered }),
).amounts((event) => (event.attempt === undefined ? [] : [{ amount: event.attempt.costUsd }]));

const findingsRemembered = H.trigger('passed-reports-become-prior-findings')
  .on(H.when.step(topics, 'citeCheck', { if: (event) => event.ok }))
  .record(priorFindingsJournal, (event) => {
    const synthesis = event.outputs.synthesize;
    return synthesis === undefined
      ? undefined
      : {
          text: `When researching "${event.unit.attributes.title}" or a similar question, start from these findings because they passed citation check: ${synthesis.keyFindings.join('; ')}`,
          status: 'active',
          when: { kinds: [Topic], roles: [synthesizerRole] },
        };
  });

const dailyBudgetUsd = 40;

const scheduler = H.scheduler('research')
  .priority(topics)
  .admit(topics, ({ metrics }) => {
    const spent = metrics.total(dailySpend, { window: { calendar: 'day', tz: 'UTC' } }).total;
    const succeeded = metrics.total(succeededAttemptCost, { window: { lastDays: 30 } });
    const projected = succeeded.samples === 0 ? 3 : succeeded.total / succeeded.samples;
    return spent + projected <= dailyBudgetUsd;
  });

const lead = claudeCode.supervisor('research-lead').client('research-supervisor', {
  grants: [
    H.ops.workRead,
    H.ops.workCreate,
    H.ops.workCancel,
    H.ops.memoryRead,
    H.ops.memoryCurate,
    H.ops.telemetryRead,
  ],
  port: H.slot.port(1),
});

export const harness = H.harness('research-pipeline')
  .ledger(sqlite.ledger({ path: '.harness/ledger.sqlite' }))
  .lanes(topics)
  .journals(priorFindingsJournal, sourceExperienceJournal)
  .triggers(findingsRemembered)
  .metrics(citationPass, dailySpend, succeededAttemptCost)
  .scheduler(scheduler)
  .clients(lead)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));

void harness.start();
