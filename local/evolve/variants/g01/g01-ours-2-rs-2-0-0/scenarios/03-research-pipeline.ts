import { z } from 'zod';
import { H } from 'harness-dsl';
import type { SeatPolicyInput, ModelRef } from 'harness-dsl/kernel';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { pgvector } from 'harness-dsl/pgvector';
import { supply } from 'harness-dsl/supply';
import { policies } from 'harness-dsl/policies';
import { observers } from 'harness-dsl/observers';

const queued = H.state('queued').pending();
const researching = H.state('researching').active();
const delivered = H.state('delivered').terminal('success');
const parked = H.state('parked').terminal('neutral');
const withdrawn = H.state('withdrawn').terminal('neutral');
const failed = H.state('failed').terminal('failure');

const topicSchema = z.object({ title: z.string(), question: z.string(), tags: z.array(z.string()) });
const topic = H.work('topic').schema(topicSchema).states(queued, researching, delivered, parked, withdrawn, failed);

const findingMemory = H.memory('prior-finding')
  .content(z.object({ topic: z.string(), claim: z.string(), source: z.string() }))
  .trust('experience');
const sourceLesson = H.memory('source-lesson')
  .content(z.object({ do: z.string(), when: z.string(), because: z.string() }))
  .trust('experience');

const findingsJournal = H.journal('prior-findings')
  .of(findingMemory)
  .store(pgvector.store({
    url: H.env('FINDINGS_DATABASE_URL'),
    table: 'findings',
    embeddingModel: 'text-embedding-3-small',
    embeddingKey: H.env('EMBEDDING_API_KEY'),
  }))
  .recall(policies.similarity({ limit: 12, minSimilarity: 0.75 }));
const sourceJournal = H.journal('source-lessons')
  .of(sourceLesson)
  .store(jsonl.store('memory/sources.jsonl'))
  .recall(policies.specificity({ limit: 8 }));

const haiku = H.model('claude-haiku-4-5').pricing(anthropic.pricing());
const opus = H.model('claude-opus-4-1').pricing(anthropic.pricing());
const sonnet = H.model('claude-sonnet-4-5').pricing(anthropic.pricing());

const apiAccount = H.account('api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') }));
const pool = H.pool('api', [apiAccount]).serves(haiku, opus, sonnet).policy(policies.soonestExpiring());

const extractorRole = H.role('extractor').promptFile('prompts/extractor.md').intents(['web']).recall(sourceLesson);
const synthesizerRole = H.role('synthesizer').promptFile('prompts/synthesizer.md').intents(['read']).recall(findingMemory, sourceLesson);

function chooseSynthesizer(input: SeatPolicyInput): readonly ModelRef[] {
  const readings = input.candidates.map(model => ({
    model,
    reading: input.metrics.read(citationPass, { window: '30d', where: { seat: input.seat, model } }),
  }));
  const unexplored = readings.filter(r => r.reading.samples < 20).sort((a, b) => a.reading.samples - b.reading.samples);
  if (unexplored.length > 0) return unexplored.map(r => r.model);
  return readings.slice().sort((a, b) => (b.reading.value ?? 0) - (a.reading.value ?? 0)).map(r => r.model);
}

const extractor = H.seat('extractor').role(extractorRole).models(haiku);
const synthesizer = H.seat('synthesizer')
  .role(synthesizerRole)
  .models(opus, sonnet)
  .policy(H.policy.seat('citation-pass-rate', chooseSynthesizer));

const searchExtract = H.skill('search-and-extract')
  .input(z.object({ question: z.string(), angle: z.number() }))
  .output(z.object({ findings: z.array(z.object({ claim: z.string(), url: z.string() })) }))
  .prompt(input => `Search angle ${input.angle} of 20 for: ${input.question}. Extract sourced claims.`);
const synthesize = H.skill('synthesize-report')
  .input(z.object({ question: z.string(), findings: z.array(z.object({ claim: z.string(), url: z.string() })) }))
  .output(z.object({ report: z.string(), citations: z.array(z.string()) }))
  .prompt(input => `Write a sourced report answering: ${input.question}\n\n${JSON.stringify(input.findings)}`);

const local = H.runner.local('local', { slots: 4 });

const citationCheck = H.command('citation-check')
  .input(z.object({ citations: z.array(z.string()) }))
  .output(z.object({ checked: z.number() }))
  .runner(local)
  .run(async input => {
    const unresolved: string[] = [];
    for (const url of input.citations) {
      const response = await fetch(url, { method: 'HEAD' });
      if (response.ok) continue;
      unresolved.push(url);
    }
    if (unresolved.length > 0) throw new Error(`unresolved citations: ${unresolved.join(', ')}`);
    return { checked: input.citations.length };
  });

const publishReport = H.command('publish-report')
  .input(z.object({ title: z.string(), report: z.string(), findings: z.array(z.object({ claim: z.string(), url: z.string() })) }))
  .runner(local)
  .run(async (input, ctx) => {
    await ctx.sh(`mkdir -p reports && cat > "reports/${input.title}.md"`, { stdin: input.report });
    for (const finding of input.findings) {
      await ctx.record(findingsJournal, {
        content: { topic: input.title, claim: finding.claim, source: finding.url },
        when: { kinds: [topic] },
      });
    }
  });

const research = H.flow('research')
  .input(topicSchema)
  .batch('extract', {
    items: s => Array.from({ length: 20 }, (_, index) => ({ question: s.input.question, angle: index + 1 })),
    call: extractor.call(searchExtract),
  })
  .when(s => s.steps.extract.filter(result => result.findings.length > 0).length < 5, f => f.exit('notEnoughSources'))
  .step('synthesize', synthesizer.call(synthesize), s => ({
    question: s.input.question,
    findings: s.steps.extract.flatMap(result => result.findings),
  }))
  .step('cite', citationCheck, s => ({ citations: s.steps.synthesize.citations }))
  .step('publish', publishReport, s => ({
    title: s.input.title,
    report: s.steps.synthesize.report,
    findings: s.steps.extract.flatMap(result => result.findings),
  }))
  .exit('delivered');

const citationPass = H.metric('citation-pass-rate').rate(
  H.events.steps(research, 'cite', { outcome: 'succeeded' }),
  H.events.steps(research, 'cite'),
);
const dailySpend = H.metric('daily-spend').sum(H.events.attempts(), 'costUsd');
const succeededCost = H.metric('succeeded-attempt-cost').mean(H.events.attempts({ outcome: 'succeeded' }), 'costUsd');

const researchTopic = H.handler('research-topic')
  .of(topic)
  .flow(research)
  .exits({ delivered, notEnoughSources: parked })
  .retry({ tries: 1, backoff: 'linear', delaySeconds: 600, exhausted: failed });

const topics = H.lane('topics', researchTopic)
  .from(supply.manual())
  .store(sqlite.store('.harness/topics.db'))
  .ceiling({ maxUsd: 3, onExceed: 'fail' });

const nextMondayMorning = (after: Date): Date => {
  const next = new Date(after);
  next.setHours(6, 0, 0, 0);
  const days = (8 - next.getDay()) % 7;
  next.setDate(next.getDate() + (days === 0 ? 7 : days));
  return next;
};

const weeklyReopen = H.trigger('recurring-topics-reopen-weekly')
  .on(topics.due(unit => (unit.position === 'terminal' && unit.data.tags.includes('recurring') ? nextMondayMorning(unit.updatedAt) : undefined)))
  .do(topics.move(queued));

const dailyBudgetUsd = 40;
const topicCeilingUsd = 3;

const withinDailyBudget = H.policy.schedule('daily-budget', input => {
  const startOfDay = new Date(input.now.getFullYear(), input.now.getMonth(), input.now.getDate());
  const spent = input.metrics.read(dailySpend, { window: { since: startOfDay } }).value ?? 0;
  const projection = input.metrics.read(succeededCost, { window: '30d', where: { kind: topic } });
  const perTopic = projection.samples < 5 ? topicCeilingUsd : projection.value ?? topicCeilingUsd;
  const committed = input.running.length * perTopic;
  const affordable = Math.max(0, Math.floor((dailyBudgetUsd - spent - committed) / perTopic));
  return input.of(topics).slice().sort((a, b) => b.waitingSeconds - a.waitingSeconds).slice(0, affordable);
});

const operator = claudeCode.client('operator');
const operatorGrant = H.grant(
  operator,
  H.ops.work.read,
  H.ops.work.write,
  H.ops.memory.write(sourceJournal),
  H.ops.memory.curate(findingsJournal, sourceJournal),
  H.ops.telemetry.read,
);

export const harness = H.harness('research-pipeline')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .pools(pool)
  .lanes(topics)
  .journals(findingsJournal, sourceJournal)
  .triggers(weeklyReopen)
  .scheduler(H.scheduler().policy(withinDailyBudget))
  .grants(operatorGrant)
  .metrics(citationPass, dailySpend, succeededCost)
  .observe(observers.board({ path: 'BOARD.md' }), observers.telemetry({ path: 'TELEMETRY.md' }));

void harness.start();
