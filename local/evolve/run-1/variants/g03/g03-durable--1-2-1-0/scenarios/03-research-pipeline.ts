import { H } from 'harness-dsl';
import { z } from 'zod';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as lancedb from 'harness-dsl/lancedb';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as markdown from 'harness-dsl/markdown';
import * as local from 'harness-dsl/local';

const Queued = H.state('Queued', 'pending');
const Researching = H.state('Researching', 'active');
const Delivered = H.state('Delivered', 'terminal', 'success');
const Parked = H.state('Parked', 'terminal', 'neutral');
const Cancelled = H.state('Cancelled', 'terminal', 'neutral');
const Failed = H.state('Failed', 'terminal', 'failure');

const Topic = H.work('topic')
  .attributes({ title: z.string(), question: z.string(), recurring: z.boolean(), cycle: z.number() })
  .states([Queued, Researching, Delivered, Parked, Cancelled, Failed])
  .events({ cancel: { reason: z.string() } })
  .key(u => `${u.attributes.title}#${u.attributes.cycle}`);

const apiAccount = anthropic.account('research-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const haikuBatch = anthropic.model('claude-haiku-4-5', { batch: true });
const sonnet = anthropic.model('claude-sonnet-4-5');
const opus = anthropic.model('claude-opus-4-1');

const similarFindings = H.policy.recall('similar-findings', c =>
  c.candidates
    .filter(x => (x.similarity ?? 0) >= 0.75)
    .sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0) || b.track.succeeded - a.track.succeeded)
    .slice(0, c.limit));

const specificThenProven = H.policy.recall('specific-then-proven', c =>
  c.candidates
    .slice()
    .sort((a, b) => b.specificity - a.specificity || b.track.succeeded - a.track.succeeded)
    .slice(0, c.limit));

const findings = H.playbook('report-findings', H.memory.experience('report-findings'))
  .store(lancedb.memory('.harness/memory/findings.lance', { embedding: 'voyage-3', table: 'findings' }))
  .recall(similarFindings);

const sourceExperience = H.playbook('source-experience', H.memory.experience('source-experience').curated())
  .store(jsonl.memory('.harness/memory/sources.jsonl'))
  .recall(specificThenProven);

const gatherSources = H.command('gather-sources', ['research', 'search', '--limit', '20'])
  .parses({ sources: z.array(z.object({ url: z.string(), title: z.string(), excerpt: z.string() })) });

const citationCheck = H.command('citation-check', ['research', 'check-citations']);
const publishReport = H.command('publish-report', ['research', 'publish']);

const citationPass = H.metric('citation-pass').of(citationCheck).hit(result => result.exitCode === 0);

const synthesizerModel = H.policy.model('synthesizer-by-citation-pass', [sonnet, opus], (c, options) => {
  const reads = options.map(model => ({
    model,
    rate: c.metrics.read(citationPass, { kind: Topic, model, window: { days: 30 } }),
  }));
  const thin = reads.filter(r => r.rate.n < 30)[0];
  if (thin) return thin.model;
  return reads.reduce((best, r) => (r.rate.rate ?? 0) > (best.rate.rate ?? 0) ? r : best).model;
});

const extractorRole = H.role('extractor')
  .intents(['read'])
  .instructions('Extract the claims in this source that bear on the question.')
  .input({ question: z.string(), url: z.string(), excerpt: z.string() })
  .output({ url: z.string(), relevant: z.boolean(), claims: z.array(z.string()) });

const synthesizerRole = H.role('synthesizer')
  .intents(['read'])
  .instructions('Write a sourced report. Cite every claim by URL. State the findings a future report should start from.')
  .input({ question: z.string(), extracts: z.array(z.object({ url: z.string(), claims: z.array(z.string()) })) })
  .output({
    report: z.string(),
    citations: z.array(z.string()),
    findings: z.array(z.object({ rule: z.string(), because: z.string() })),
  });

const extractor = H.agent('extractor', extractorRole).model(haikuBatch).pool(apiAccount).recalls([sourceExperience]);

const synthesizer = H.agent('synthesizer', synthesizerRole)
  .model(synthesizerModel)
  .pool(apiAccount)
  .recalls([findings, sourceExperience]);

const researchFlow = H.flow('research')
  .requires({ title: z.string(), question: z.string() })
  .step('gather', gatherSources, c => ({ args: [c.input.question] }), { restart: 'rerun' })
  .batch('extract', extractor, c => c.out.gather.data.sources.map(source => ({
    question: c.input.question,
    url: source.url,
    excerpt: source.excerpt,
  })))
  .exit('parked', c => c.out.extract.filter(x => x.relevant).length < 5)
  .step('synthesize', synthesizer, c => ({
    question: c.input.question,
    extracts: c.out.extract.filter(x => x.relevant).map(x => ({ url: x.url, claims: x.claims })),
  }))
  .step('check', citationCheck, c => ({
    stdin: JSON.stringify({ report: c.out.synthesize.report, citations: c.out.synthesize.citations }),
  }), { restart: 'rerun' })
  .step('deliver', publishReport, c => ({ args: [c.input.title], stdin: c.out.synthesize.report }))
  .ends(['delivered'], () => 'delivered');

const weekMs = 7 * 24 * 60 * 60 * 1000;

const topics = H.lane('topics', Topic)
  .supply([
    H.supply.operator(),
    H.supply.schedule(Topic, H.time.weekly('mon', '06:00', 'UTC'), (c, s) => {
      const recurring = c.units.filter(u => u.attributes.recurring);
      const titles = recurring.map(u => u.attributes.title);
      return recurring
        .filter((u, i) => titles.indexOf(u.attributes.title) === i)
        .map(u => s.create({
          attributes: {
            title: u.attributes.title,
            question: u.attributes.question,
            recurring: true,
            cycle: Math.floor(c.now / weekMs),
          },
        }));
    }),
  ])
  .store(sqlite.store(Topic, '.harness/topics.db'))
  .runner(local.shell({ slots: 2 }))
  .budget({ maxUsdPerUnit: 3, onExceed: 'fail' })
  .retry(H.retry.fixed({ maxRetries: 1, delayMs: 600_000 }))
  .reacts({ cancel: H.reaction(Cancelled).from([Queued, Researching]).cancels() })
  .handler(researchFlow, {
    opens: Researching,
    ends: { delivered: Delivered, parked: Parked },
    exhausted: Failed,
  });

const deliveredReportsTeach = H.trigger('delivered-reports-become-findings', H.on.transition(topics, { to: [Delivered] }))
  .records(findings, e => (e.outputs.synthesize ? e.outputs.synthesize.findings : []).map(f => ({
    rule: f.rule,
    because: `${f.because} (report on ${e.unit.attributes.title})`,
    when: { kinds: [Topic] },
  })));

const dailyBudgetUsd = 40;

const schedule = H.policy.schedule('within-daily-budget', c => {
  const projected = c.metrics.cost({ kind: Topic, verdict: 'success', window: { days: 30 } }).meanUsd ?? 3;
  const committed = c.open
    .filter(o => o.is(topics))
    .reduce((sum, o) => sum + Math.max(projected - o.costUsd, 0), 0);
  let remaining = dailyBudgetUsd - c.metrics.spentUsd({ sinceMs: c.clock.startOfDay('UTC') }) - committed;
  return {
    start: c.order(x => x.enqueuedAt).filter(() => {
      if (projected > remaining) return false;
      remaining -= projected;
      return true;
    }),
  };
});

const operatorAccess = H.access('research-operator').allows([
  H.ops.readWork,
  H.ops.createWork,
  H.ops.sendEvents,
  H.ops.resolveBlocks,
  H.ops.readMemory,
  H.ops.curateMemory,
  H.ops.readTelemetry,
]);

export const harness = H.harness('research-pipeline')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes([topics])
  .triggers([deliveredReportsTeach])
  .schedule(schedule)
  .clients([claudeCode.supervisor('operator', operatorAccess, { port: H.slot.port(0) })])
  .projections([markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md')]);
