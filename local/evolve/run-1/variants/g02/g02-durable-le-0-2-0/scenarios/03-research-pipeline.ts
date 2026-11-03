import { z } from 'zod';
import { H, MetricRef } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { jsonl } from 'harness-dsl/jsonl';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';
import { pgvector } from 'harness-dsl/pgvector';
import { sqlite } from 'harness-dsl/sqlite';

const topicSchema = z.object({
  title: z.string(),
  question: z.string(),
  tags: z.array(z.string()),
});

const Queued = H.state('Queued', 'pending');
const Searching = H.state('Searching', 'active');
const Synthesizing = H.state('Synthesizing', 'active');
const Checking = H.state('Checking', 'active');
const Delivered = H.terminal('Delivered', 'success');
const Parked = H.terminal('Parked', 'neutral');
const Cancelled = H.terminal('Cancelled', 'neutral');

const Topic = H.kind('Topic')
  .attributes(topicSchema)
  .states(Queued, Searching, Synthesizing, Checking, Delivered, Parked, Cancelled)
  .key(attrs => attrs.title)
  .initial(Queued)
  .onCancelled(Cancelled);

const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const apiPool = H.pool('api').accounts(apiAccount);
const haiku = anthropic.model('haiku', { id: 'claude-haiku-4-5' });
const opus = anthropic.model('opus', { id: 'claude-opus-4-1' });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });

const extractorRole = H.role('extractor')
  .intents('search', 'browse', 'read')
  .instructions('Search for sources on the angle given and extract claims with exact quotes and URLs.');

const synthesizerRole = H.role('synthesizer')
  .intents('read', 'record')
  .instructions('Write a sourced report. Every claim cites a URL from the extracted sources.');

const synthesizerModel = H.policy.model('synthesizer-model', [opus, sonnet], ctx => {
  const window = { lastDays: 30 };
  const opusRecord = ctx.metrics.rate(citationPass, { group: opus.name, window });
  const sonnetRecord = ctx.metrics.rate(citationPass, { group: sonnet.name, window });
  if (opusRecord.samples < 20 || sonnetRecord.samples < 20) {
    return opusRecord.samples <= sonnetRecord.samples ? opus : sonnet;
  }
  return opusRecord.rate >= sonnetRecord.rate ? opus : sonnet;
});

const extractor = H.agent('extractor')
  .role(extractorRole)
  .model(haiku)
  .pool(apiPool)
  .output(z.object({
    sources: z.array(z.object({ url: z.string(), claim: z.string(), quote: z.string() })),
  }));

const synthesizer = H.agent('synthesizer')
  .role(synthesizerRole)
  .model(synthesizerModel)
  .pool(apiPool)
  .output(z.object({
    report: z.string(),
    summary: z.string(),
    citations: z.array(z.string()),
  }));

const citationCheck = H.command('citation-check')
  .input(z.object({ citations: z.array(z.string()) }))
  .argv(input => ['./bin/check-citations', ...input.citations])
  .runner(local.runner('local'));

const searchAngles = 20;

const researchFlow = H.flow('research')
  .input(topicSchema)
  .step('extract', extractor.batch(), ctx =>
    Array.from({ length: searchAngles }, (_unused, index) => ({
      task: `Research question: ${ctx.unit.attributes.question}\nCover angle ${index + 1} of ${searchAngles} on "${ctx.unit.attributes.title}", distinct from the other angles.`,
    })),
  )
  .exit('parked', ctx => ctx.steps.extract.reduce((count, result) => count + result.sources.length, 0) < 5)
  .step('synthesize', synthesizer, ctx => ({
    task: `Write a sourced report answering: ${ctx.unit.attributes.question}\n\nSources:\n${JSON.stringify(ctx.steps.extract.flatMap(result => result.sources))}`,
  }))
  .step('cite-check', citationCheck, ctx => ({ citations: ctx.steps.synthesize.citations }))
  .exit('delivered');

const storePath = '.harness/research.db';

const topics = H.lane('topics', Topic)
  .supply(H.operator)
  .supply(
    sqlite.scan('recurring-topics', {
      path: storePath,
      kind: 'Topic',
      schedule: H.clock('weekly-reopen').at('06:00', { on: 'mon' }),
    }),
    (stored, to) => {
      const parsed = topicSchema.safeParse(stored.attributes);
      return parsed.success && parsed.data.tags.includes('recurring') ? to.create(parsed.data) : to.skip();
    },
  )
  .store(sqlite.store({ path: storePath }))
  .handler(researchFlow, {
    exits: { parked: Parked, delivered: Delivered },
    during: { extract: Searching, synthesize: Synthesizing, 'cite-check': Checking },
  })
  .ceiling({ maxUsd: 3, onExceed: 'fail' });

const citationPass: MetricRef<'rate'> = H.metric('citation-pass', H.when.step(topics, 'cite-check'))
  .samples(event => [{ group: event.models.synthesize ?? 'unknown', hit: event.ok }]);

const dailySpend = H.metric('daily-spend', H.when.invocation({ lanes: [topics] }))
  .amounts(event => [{ group: 'research', amount: event.costUsd }]);

const deliveredCost = H.metric('delivered-topic-cost', H.when.transition(topics, { to: Delivered }))
  .amounts(event => [{ group: 'research', amount: event.unit.costUsd }]);

const findings = H.journal('report-findings', H.memory('finding', 'experience'))
  .store(pgvector.memoryStore({ url: H.env('PGVECTOR_URL'), table: 'findings', embeddingModel: 'text-embedding-3-small' }))
  .recall({ by: 'similarity', limit: 8 })
  .readBy(synthesizerRole);

const sourceExperience = H.journal('source-experience', H.memory('source-experience', 'experience'))
  .store(jsonl.memoryStore({ path: 'memory/sources.jsonl' }))
  .recall({ by: 'specificity', limit: 10 })
  .readBy(extractorRole, synthesizerRole)
  .recordedBy(synthesizerRole);

const checkedReportBecomesFinding = H.trigger('checked-report-becomes-finding')
  .on(H.when.step(topics, 'cite-check', { if: event => event.ok }))
  .record(findings, event => {
    const synthesis = event.outputs.synthesize;
    return synthesis === undefined
      ? undefined
      : {
          text: `When researching ${event.unit.attributes.title}, start from: ${synthesis.summary}, because a report with resolving citations established it`,
          when: { kinds: [Topic] },
        };
  });

const dailyBudgetUsd = 40;
const topicCeilingUsd = 3;

const scheduler = H.scheduler('daily-budget')
  .priority(topics)
  .admit(topics, ctx => {
    const spent = ctx.metrics.total(dailySpend, { window: { calendar: 'day' } });
    const delivered = ctx.metrics.total(deliveredCost, { window: { lastDays: 30 } });
    const projected = delivered.samples === 0 ? topicCeilingUsd : delivered.total / delivered.samples;
    return spent.total + projected <= dailyBudgetUsd;
  });

const supervisor = claudeCode.supervisor('supervisor', {
  grants: [H.ops.workRead, H.ops.workCreate, H.ops.workCancel, H.ops.memoryRead, H.ops.telemetryRead],
});

export const harness = H.harness('research-pipeline')
  .ledger(sqlite.ledger({ path: '.harness/ledger.db' }))
  .lanes(topics)
  .journals(findings, sourceExperience)
  .triggers(checkedReportBecomesFinding)
  .metrics(citationPass, dailySpend, deliveredCost)
  .scheduler(scheduler)
  .clients(supervisor)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));

void harness.start();
