import { z } from 'zod';
import { H, type MetricRef } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { pgvector } from 'harness-dsl/pgvector';
import { voyage } from 'harness-dsl/voyage';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const storePath = '.harness/topics.db';
const topicCeilingUsd = 3;
const dailyBudgetUsd = 40;

const topicAttrs = z.object({ slug: z.string(), question: z.string(), tags: z.array(z.string()) });

const Queued = H.state('Queued', 'pending');
const Searching = H.state('Searching', 'active');
const Synthesizing = H.state('Synthesizing', 'active');
const Checking = H.state('Checking', 'active');
const Delivered = H.terminal('Delivered', 'success');
const Parked = H.terminal('Parked', 'neutral');
const Cancelled = H.terminal('Cancelled', 'neutral');
const Unresolvable = H.terminal('Unresolvable', 'failure');

const Topic = H.kind('Topic')
  .attributes(topicAttrs)
  .states(Queued, Searching, Synthesizing, Checking, Delivered, Parked, Cancelled, Unresolvable)
  .key((attrs) => attrs.slug)
  .initial(Queued)
  .onCancelled(Cancelled);

const searcherRole = H.role('searcher')
  .intents('search', 'browse')
  .instructions('Search for sources on one angle of the question and extract their claims.');
const synthesizerRole = H.role('synthesizer')
  .intents('read', 'record')
  .instructions(
    'Write a sourced report. State finding as "when researching X, start from Y, because Z". Set enoughSources false when the sources cannot support a report.',
  );

const apiAccount = anthropic.account('research-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const research = H.pool('research').accounts(apiAccount);

const haiku = anthropic.model('haiku', { id: 'claude-haiku-4-5' });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const opus = anthropic.model('opus', { id: 'claude-opus-4-1' });

const synthesizerModel = H.policy.model('synthesizer-by-citation-pass-rate', [opus, sonnet], (ctx) => {
  const opusPass = ctx.metrics.rate(citationPass, { group: opus.name, window: { lastDays: 30 } });
  const sonnetPass = ctx.metrics.rate(citationPass, { group: sonnet.name, window: { lastDays: 30 } });
  if (opusPass.samples < 15) return opus;
  if (sonnetPass.samples < 15) return sonnet;
  return opusPass.rate >= sonnetPass.rate ? opus : sonnet;
});

const extraction = z.object({ source: z.string(), claims: z.array(z.string()) });
const report = z.object({
  enoughSources: z.boolean(),
  report: z.string(),
  citations: z.array(z.string()),
  finding: z.string(),
});

const searcher = H.agent('search-and-extract').role(searcherRole).model(haiku).pool(research).output(extraction);
const synthesizer = H.agent('synthesizer').role(synthesizerRole).model(synthesizerModel).pool(research).output(report);

const localRunner = local.runner('local');

const citationCheck = H.command('citation-check')
  .input(z.object({ citations: z.array(z.string()) }))
  .argv((input) => ['./tools/check-citations.sh', ...input.citations])
  .runner(localRunner);

const researchFlow = H.flow('research')
  .input(topicAttrs)
  .step('search', searcher.batch(), (ctx) =>
    Array.from({ length: 20 }, (_, index) => ({
      task: `Search angle ${index + 1} of 20 for: ${ctx.unit.attributes.question}`,
      skills: [ctx.unit.attributes.slug],
    })),
  )
  .step('synthesize', synthesizer, (ctx) => ({
    task: `Write a sourced report on: ${ctx.unit.attributes.question}\n\nExtractions:\n${ctx.steps.search
      .map((found) => `${found.source}: ${found.claims.join('; ')}`)
      .join('\n')}`,
    skills: [ctx.unit.attributes.slug],
  }))
  .exit('parked', (ctx) => !ctx.steps.synthesize.enoughSources)
  .step('citeCheck', citationCheck, (ctx) => ({ citations: ctx.steps.synthesize.citations }), { afterCrash: 'rerun' })
  .exit('delivered');

const topics = H.lane('topics', Topic)
  .supply(H.operator)
  .supply(
    sqlite.scan('recurring-topics', {
      path: storePath,
      kind: 'Topic',
      schedule: H.clock('weekly').at('06:00', { on: 'mon', tz: 'UTC' }),
    }),
    (stored, to) => {
      const parsed = topicAttrs.safeParse(stored.attributes);
      return parsed.success && parsed.data.tags.includes('recurring') ? to.create(parsed.data) : to.skip();
    },
  )
  .store(sqlite.store({ path: storePath }))
  .handler(researchFlow, {
    exits: { parked: Parked, delivered: Delivered },
    during: { search: Searching, synthesize: Synthesizing, citeCheck: Checking },
  })
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 600_000, exhausted: Unresolvable })
  .ceiling({ maxUsd: topicCeilingUsd, onExceed: 'fail' });

const citationPass: MetricRef<'rate'> = H.metric(
  'citation-pass-by-synthesizer-model',
  H.when.step(topics, 'citeCheck'),
).samples((event) => [{ group: event.models.synthesize ?? 'unknown', hit: event.ok }]);

const researchSpend = H.metric('research-spend', H.when.invocation({ lanes: [topics] })).amounts((event) => [
  { group: 'all', amount: event.costUsd },
]);

const deliveredAttemptCost = H.metric(
  'delivered-attempt-cost',
  H.when.transition(topics, { to: Delivered }),
).amounts((event) => [{ group: 'all', amount: event.attempt?.costUsd ?? 0 }]);

const embedder = voyage.embedder('findings-embedder', { id: 'voyage-3', apiKey: H.env('VOYAGE_API_KEY') });

const findings = H.journal('report-findings', H.memory('finding', 'experience'))
  .store(pgvector.memoryStore({ url: H.env('RESEARCH_DATABASE_URL'), table: 'findings', embedder }))
  .recall({ by: 'similarity', limit: 6 })
  .readBy(synthesizerRole);

const sourceExperience = H.journal('source-experience', H.memory('source-experience', 'experience'))
  .store(jsonl.memoryStore({ path: '.harness/source-experience.jsonl' }))
  .recall({ by: 'specificity', limit: 10 })
  .readBy(searcherRole, synthesizerRole)
  .recordedBy(synthesizerRole);

const deliveredReportBecomesFinding = H.trigger('delivered-report-becomes-finding')
  .on(H.when.step(topics, 'citeCheck', { if: (event) => event.ok }))
  .record(findings, (event) => {
    const synthesis = event.outputs.synthesize;
    return synthesis === undefined
      ? undefined
      : {
          text: synthesis.finding,
          when: { kinds: [Topic], roles: [synthesizerRole], skills: [event.unit.attributes.slug] },
        };
  });

const scheduler = H.scheduler('research')
  .priority(topics)
  .admit(topics, (ctx) => {
    const spentToday = ctx.metrics.total(researchSpend, { window: { calendar: 'day', tz: 'UTC' } });
    const delivered = ctx.metrics.total(deliveredAttemptCost, { window: { lastDays: 30 } });
    const projectedUsd = delivered.samples === 0 ? topicCeilingUsd : delivered.total / delivered.samples;
    return spentToday.total + projectedUsd <= dailyBudgetUsd;
  });

const supervisor = claudeCode.supervisor('research-supervisor', {
  grants: [
    H.ops.workRead,
    H.ops.workCreate,
    H.ops.workCancel,
    H.ops.attemptsRecover,
    H.ops.memoryRead,
    H.ops.memoryCurate,
    H.ops.telemetryRead,
  ],
});

export const researchPipeline = H.harness('research-pipeline')
  .ledger(sqlite.ledger({ path: '.harness/ledger.db' }))
  .lanes(topics)
  .journals(findings, sourceExperience)
  .triggers(deliveredReportBecomesFinding)
  .metrics(citationPass, researchSpend, deliveredAttemptCost)
  .scheduler(scheduler)
  .clients(supervisor)
  .observers(markdown.board({ path: '.harness/BOARD.md' }), markdown.telemetry({ path: '.harness/TELEMETRY.md' }));

void researchPipeline.start();
