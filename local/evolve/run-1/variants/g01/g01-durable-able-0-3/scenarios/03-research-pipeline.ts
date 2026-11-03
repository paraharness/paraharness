import { z } from 'zod';
import { H, AnyMetric, ModelPolicy } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { pgvector } from 'harness-dsl/pgvector';
import { anthropic } from 'harness-dsl/anthropic';
import { local } from 'harness-dsl/local';
import { http } from 'harness-dsl/http';
import { markdown } from 'harness-dsl/markdown';

const Queued = H.state('Queued', 'pending');
const Searching = H.state('Searching', 'active');
const Synthesizing = H.state('Synthesizing', 'active');
const CheckingCitations = H.state('CheckingCitations', 'active');
const Delivered = H.state('Delivered', 'terminal', 'success');
const Parked = H.state('Parked', 'terminal', 'neutral');
const Cancelled = H.state('Cancelled', 'terminal', 'neutral');
const Failed = H.state('Failed', 'terminal', 'failure');

const topicAttrs = z.object({ slug: z.string(), title: z.string(), question: z.string(), tags: z.array(z.string()) });

const Topic = H.kind('Topic')
  .attributes(topicAttrs)
  .states(Queued, Searching, Synthesizing, CheckingCitations, Delivered, Parked, Cancelled, Failed)
  .key(a => a.slug);

const reopen = H.signal('reopen');

const apiAccount = anthropic.account('research-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const haiku = anthropic.model('haiku', { id: 'claude-haiku-4-5' });
const sonnet = anthropic.model('sonnet', { id: 'claude-sonnet-4-5' });
const opus = anthropic.model('opus', { id: 'claude-opus-4-1' });

const searcherRole = H.role('searcher').intents('search', 'browse').instructions('Find sources for one angle of the question and extract claims with URLs.');
const synthesizerRole = H.role('synthesizer').intents('read').instructions('Write a sourced report. Cite every claim. Say when sources are not enough.');

const Finding = H.memory('priorFinding').trust('experience');
const SourceExperience = H.memory('sourceExperience')
  .body(z.object({ do: z.string(), when: z.string(), because: z.string() }))
  .trust('experience');

const priorFindings = H.journal('priorFindings', Finding)
  .store(pgvector.memoryStore({ url: H.env('PGVECTOR_URL'), table: 'prior_findings', embeddingModel: 'text-embedding-3-small' }))
  .recall(H.recall('similarFindings', { by: 'similarity', limit: 10, minScore: 0.75 }))
  .readBy(synthesizerRole);

const sourceExperience = H.journal('sourceExperience', SourceExperience)
  .store(jsonl.memoryStore({ path: '.harness/memory/sources.jsonl' }))
  .recall(H.recall('specificSourceExperience', { by: 'specificity', limit: 8 }))
  .readBy(searcherRole, synthesizerRole)
  .writtenBy(synthesizerRole);

const synthesizerModel: ModelPolicy = H.policy.model('synthesizerModel', [opus, sonnet], ctx => {
  const opusPass = ctx.metrics.rate(citationPass, { group: opus.name, windowDays: 30 });
  const sonnetPass = ctx.metrics.rate(citationPass, { group: sonnet.name, windowDays: 30 });
  if (opusPass.samples < 15) return opus;
  if (sonnetPass.samples < 15) return sonnet;
  return opusPass.rate >= sonnetPass.rate ? opus : sonnet;
});

const searcher = H.agent('searcher')
  .role(searcherRole)
  .model(haiku)
  .output(z.object({ sources: z.array(z.object({ url: z.string(), claim: z.string() })) }));

const synthesizer = H.agent('synthesizer')
  .role(synthesizerRole)
  .model(synthesizerModel)
  .output(z.object({
    report: z.string(),
    citations: z.array(z.string()),
    enoughSources: z.boolean(),
    keyFinding: z.string(),
  }));

const citationCheck = H.command('citationCheck')
  .input(z.object({ citations: z.array(z.string()) }))
  .argv(i => ['./bin/check-citations', ...i.citations])
  .runner(local.runner('local'));

const researchFlow = H.flow('research')
  .input(topicAttrs)
  .step('search', searcher.batch(), ctx => Array.from({ length: 20 }, (_, i) => ({
    task: `Angle ${i + 1} of 20 on: ${ctx.unit.attributes.question}`,
  })))
  .step('synthesize', synthesizer, ctx => ({
    task: `Answer "${ctx.unit.attributes.question}" from these extracts:\n${JSON.stringify(ctx.steps.search)}`,
  }))
  .exit('parked', ctx => !ctx.steps.synthesize.enoughSources)
  .step('check', citationCheck, ctx => ({ citations: ctx.steps.synthesize.citations }))
  .exit('delivered');

const topicCeilingUsd = 3;

const topics = H.lane('topics', Topic)
  .supply(H.operator)
  .supply(H.clock('weeklyRecurring').weekly('mon', '07:00', { tz: 'Europe/London' }), (_tick, to) =>
    to.signal(reopen, unit => unit.state === 'Delivered' && unit.attributes.tags.includes('recurring'), {}))
  .store(sqlite.store({ path: '.harness/topics.sqlite' }))
  .handler(researchFlow, {
    during: { search: Searching, synthesize: Synthesizing, check: CheckingCitations },
    exits: { parked: Parked, delivered: Delivered },
    failure: Failed,
  })
  .on(reopen, { enter: Queued })
  .on(H.cancel, { enter: Cancelled })
  .ceiling({ maxUsd: topicCeilingUsd, onExceed: 'fail' });

const citationPass: AnyMetric = H.metric('citationPass')
  .from(H.when.step(topics, 'check'))
  .samples(e => [{ group: e.models.synthesize ?? 'unknown', success: e.ok }]);

const recordFinding = H.trigger('recordFinding')
  .on(H.when.step(topics, 'check', { if: e => e.ok }))
  .record(priorFindings, e => {
    const synthesis = e.steps.synthesize;
    return synthesis === undefined
      ? undefined
      : {
          body: { text: `When researching ${e.unit.attributes.title}, start from "${synthesis.keyFinding}", because a citation-checked report established it.` },
          when: { kinds: [Topic] },
        };
  });

const dailyBudget = H.budget('dailyResearch').maxUsd(40).per('day', { tz: 'Europe/London' }).lanes(topics);

const scheduler = H.scheduler('research')
  .priority(topics)
  .admit(topics, ctx => {
    const succeeded = ctx.metrics.meanCostUsd({ of: topics, verdict: 'success', windowDays: 30 });
    const projectedUsd = succeeded.samples === 0 ? topicCeilingUsd : succeeded.meanUsd;
    return projectedUsd <= ctx.budget(dailyBudget).remainingUsd;
  });

const operatorApi = http.controlApi('operator', {
  port: H.slot.port(1),
  token: H.env('CONTROL_API_TOKEN'),
  grants: [H.ops.workRead, H.ops.workCreate, H.ops.workCancel, H.ops.blockersResolve, H.ops.memoryRead, H.ops.telemetryRead],
});

export const researchPipeline = H.harness('research-pipeline')
  .ledger(sqlite.ledger({ path: '.harness/ledger.sqlite' }))
  .pool(H.pool('research').accounts(apiAccount))
  .lanes(topics)
  .journals(priorFindings, sourceExperience)
  .metrics(citationPass)
  .triggers(recordFinding)
  .budgets(dailyBudget)
  .scheduler(scheduler)
  .clients(operatorApi)
  .observers(markdown.board({ path: '.harness/BOARD.md' }), markdown.telemetry({ path: '.harness/TELEMETRY.md' }));
