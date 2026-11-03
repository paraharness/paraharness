import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Model, PolicyCtx } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { pgvector } from 'harness-dsl/pgvector';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const Queued = H.state('Queued', 'pending');
const Researching = H.state('Researching', 'active');
const Synthesizing = H.state('Synthesizing', 'active');
const Checking = H.state('Checking', 'active');
const Delivered = H.state('Delivered', 'terminal', 'success');
const Parked = H.state('Parked', 'terminal', 'neutral');
const Cancelled = H.state('Cancelled', 'terminal', 'neutral');
const Failed = H.state('Failed', 'terminal', 'failure');

const topic = z.object({
  title: z.string(),
  question: z.string(),
  tags: z.array(z.string()),
});

const Topic = H.kind('Topic')
  .attributes(topic)
  .states(Queued, Researching, Synthesizing, Checking, Delivered, Parked, Cancelled, Failed)
  .key(attrs => attrs.title);

const reopen = H.signal('reopen');

const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const haiku = anthropic.model('haiku', { id: 'claude-haiku-4-5' });
const opus = anthropic.model('opus', { id: 'claude-opus-4-1' });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const apiPool = H.pool('api').accounts(apiAccount);

function chooseSynthesizer(ctx: PolicyCtx): Model {
  const opusRecord = ctx.metrics.rate(citationPass, { group: opus.name, windowDays: 30 });
  const sonnetRecord = ctx.metrics.rate(citationPass, { group: sonnet.name, windowDays: 30 });
  if (opusRecord.samples < 10) return opus;
  if (sonnetRecord.samples < 10) return sonnet;
  return sonnetRecord.rate >= opusRecord.rate ? sonnet : opus;
}

const searcherRole = H.role('searcher')
  .intents('search', 'browse')
  .instructions('Find sources for the question and extract each finding with its URL.');

const synthesizerRole = H.role('synthesizer')
  .intents('record')
  .instructions('Write a sourced report. Every claim cites a URL from the findings.');

const searcher = H.agent('searcher')
  .role(searcherRole)
  .model(haiku)
  .output(z.object({ sources: z.array(z.object({ url: z.string(), finding: z.string() })) }));

const synthesizer = H.agent('synthesizer')
  .role(synthesizerRole)
  .model(H.policy.model('synthesizer-model', [opus, sonnet], chooseSynthesizer))
  .output(z.object({
    report: z.string(),
    citations: z.array(z.string()),
    keyFindings: z.array(z.string()),
  }));

const checkCitations = H.command('check-citations')
  .input(z.object({ citations: z.array(z.string()) }))
  .argv(input => ['./scripts/check-citations.sh', ...input.citations])
  .runner(local.runner('local'));

const searchAngles = Array.from({ length: 20 }, (_, index) => index + 1);

const research = H.flow('research')
  .input(topic)
  .step('search', searcher.batch(), ctx =>
    searchAngles.map(angle => ({
      task: `Search angle ${angle} of 20. Find and extract sources for: ${ctx.unit.attributes.question}`,
      skills: ['search'],
    })),
  )
  .exit('parked', ctx => ctx.steps.search.flatMap(result => result.sources).length < 5)
  .step('synthesize', synthesizer, ctx => ({
    task: `Answer: ${ctx.unit.attributes.question}\n\nFindings:\n${ctx.steps.search
      .flatMap(result => result.sources)
      .map(source => `- ${source.finding} (${source.url})`)
      .join('\n')}`,
  }), { restart: 'ask' })
  .step('cite', checkCitations, ctx => ({ citations: ctx.steps.synthesize.citations }), { restart: 'rerun' })
  .exit('delivered');

const topics = H.lane('topics', Topic)
  .supply(H.operator)
  .supply(H.clock('weekly-recurring').weekly('mon', '06:00', { tz: 'Europe/Berlin' }), (_tick, to) =>
    to.signal(reopen, unit => unit.position === 'terminal' && unit.attributes.tags.includes('recurring'), {}),
  )
  .store(sqlite.store({ path: '.harness/topics.sqlite' }))
  .handler(research, {
    exits: { delivered: Delivered, parked: Parked },
    during: { search: Researching, synthesize: Synthesizing, cite: Checking },
    failure: Failed,
  })
  .on(H.cancel, { enter: Cancelled })
  .on(reopen, { enter: Queued })
  .ceiling({ maxUsd: 3, onExceed: 'fail' });

const citationPass = H.metric('citation-pass')
  .from(H.when.step(topics, 'cite'))
  .samples(event => [{ group: event.models.synthesize ?? 'unknown', hit: event.ok }]);

const priorFindings = H.memory('prior-findings');
const sourceExperience = H.memory('source-experience').trust('experience');

const findingsPlaybook = H.playbook('prior-findings', priorFindings)
  .store(pgvector.memoryStore({ url: H.env('FINDINGS_DATABASE_URL'), table: 'prior_findings', embeddingModel: 'text-embedding-3-small' }))
  .recall(H.recall('similar-findings', { by: 'similarity', limit: 6, minScore: 0.75 }))
  .readBy(synthesizerRole);

const sourcePlaybook = H.playbook('source-experience', sourceExperience)
  .store(jsonl.memoryStore({ path: '.harness/memory/sources.jsonl' }))
  .recall(H.recall('sources-by-specificity', { by: 'specificity', limit: 8 }))
  .readBy(searcherRole, synthesizerRole)
  .recordedBy(synthesizerRole);

const findingsFromReports = H.trigger('findings-from-checked-reports')
  .on(H.when.step(topics, 'cite', { if: event => event.ok }))
  .record(findingsPlaybook, event => {
    const synthesis = event.steps.synthesize;
    return synthesis === undefined
      ? undefined
      : {
          body: {
            text: `When researching ${event.unit.attributes.title}, start from: ${synthesis.keyFindings.join('; ')}, because a checked report established them`,
          },
          when: { skills: event.unit.attributes.tags },
        };
  });

const dailyBudget = H.budget('research-daily')
  .maxUsd(40)
  .per('day', { tz: 'Europe/Berlin' })
  .lanes(topics);

const scheduler = H.scheduler('research')
  .priority(topics)
  .admit(topics, ctx => {
    const projected = ctx.metrics.meanCostUsd({ of: topics, verdict: 'success', windowDays: 30 });
    const projectedUsd = projected.samples === 0 ? 3 : projected.meanUsd;
    return ctx.budget(dailyBudget).remainingUsd >= projectedUsd;
  });

const operatorConsole = claudeCode.supervisor('research-supervisor', {
  grants: [
    H.ops.workRead,
    H.ops.workCreate,
    H.ops.workCancel,
    H.ops.memoryRead,
    H.ops.memoryCurate,
    H.ops.telemetryRead,
  ],
});

export const researchPipeline = H.harness('research-pipeline')
  .ledger(sqlite.ledger({ path: '.harness/ledger.sqlite' }))
  .pools(apiPool)
  .lanes(topics)
  .playbooks(findingsPlaybook, sourcePlaybook)
  .metrics(citationPass)
  .triggers(findingsFromReports)
  .budgets(dailyBudget)
  .scheduler(scheduler)
  .clients(operatorConsole)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));
