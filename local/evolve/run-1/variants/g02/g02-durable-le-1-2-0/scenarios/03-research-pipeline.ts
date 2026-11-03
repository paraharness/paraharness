import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Candidate, RecallCandidate } from 'harness-dsl/kernel';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as lancedb from 'harness-dsl/lancedb';
import * as markdown from 'harness-dsl/markdown';
import * as local from 'harness-dsl/local';

export const Queued = H.state('Queued', 'pending');
export const Researching = H.state('Researching', 'active');
export const Delivered = H.state('Delivered', 'terminal', 'success');
export const Parked = H.state('Parked', 'terminal', 'neutral');
export const Cancelled = H.state('Cancelled', 'terminal', 'neutral');

export const Topic = H.work('Topic')
  .attributes({ slug: z.string(), question: z.string(), recurring: z.boolean(), openedAt: z.number() })
  .states([Queued, Researching, Delivered, Parked, Cancelled])
  .events({ cancel: { reason: z.string() } })
  .key(u => `${u.attributes.slug}@${u.attributes.openedAt}`);

export const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
export const haikuBatch = anthropic.model('claude-haiku-4-5', { batch: true });
export const opus = anthropic.model('claude-opus-4-1');
export const sonnet = anthropic.model('claude-sonnet-4-5');

const finding = z.object({ claim: z.string(), source: z.string() });
type Finding = z.infer<typeof finding>;

const gather = (extracts: readonly { readonly findings: readonly Finding[] }[]) =>
  extracts.reduce<Finding[]>((all, extract) => all.concat(extract.findings), []);

const proven = (x: RecallCandidate) => x.track.succeeded / Math.max(1, x.track.present);

export const nearestFindings = H.policy.recall('nearest-findings', c =>
  [...c.candidates]
    .filter(x => x.similarity !== null && x.similarity >= 0.75)
    .sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0) || proven(b) - proven(a))
    .slice(0, c.limit),
);
export const specificThenProven = H.policy.recall('specific-then-proven', c =>
  [...c.candidates].sort((a, b) => b.specificity - a.specificity || proven(b) - proven(a)).slice(0, c.limit),
);

export const ReportFindings = H.memory.experience('report-findings');
export const SourceExperience = H.memory.experience('source-experience');

export const findingsJournal = H.journal('report-findings', ReportFindings)
  .store(lancedb.memory('memory/findings.lance', { embedding: 'text-embedding-3-small', table: 'findings' }))
  .recall(nearestFindings);
export const sourceJournal = H.journal('source-experience', SourceExperience)
  .store(jsonl.memory('memory/sources.jsonl'))
  .recall(specificThenProven);

export const planQueries = H.command('plan-queries', ['./bin/plan-queries', '--count', '20']).parses({
  queries: z.array(z.string()),
});
export const citationCheck = H.command('citation-check', ['./bin/check-citations']);

export const citationPass = H.metric('citation-pass').of(citationCheck).hit(result => result.exitCode === 0);

export const extractorRole = H.role('extractor')
  .intents(['search', 'browse', 'read'])
  .instructions('Search for the query and extract sourced findings relevant to the question.')
  .input({ question: z.string(), query: z.string() })
  .output({ findings: z.array(finding) });

export const synthesizerRole = H.role('synthesizer')
  .intents(['read', 'remember'])
  .instructions('Write a sourced report from the findings. Cite every claim.')
  .input({ question: z.string(), findings: z.array(finding) })
  .output({ report: z.string(), citations: z.array(z.string()), keyFindings: z.array(z.string()) });

export const synthesizerModel = H.policy.model('synthesizer-model', [opus, sonnet], c => {
  const a = c.metrics.read(citationPass, { model: opus, kind: Topic, window: { days: 30 } });
  const b = c.metrics.read(citationPass, { model: sonnet, kind: Topic, window: { days: 30 } });
  if (a.n < 20 || b.n < 20) return a.n <= b.n ? opus : sonnet;
  return (a.rate ?? 0) >= (b.rate ?? 0) ? opus : sonnet;
});

export const extractor = H.agent('extractor', extractorRole).model(haikuBatch).pool(apiAccount).recalls([sourceJournal]);
export const synthesizer = H.agent('synthesizer', synthesizerRole)
  .model(synthesizerModel)
  .pool(apiAccount)
  .recalls([findingsJournal, sourceJournal])
  .records(sourceJournal);

export const researchFlow = H.flow('research')
  .requires({ question: z.string() })
  .step('queries', planQueries, c => ({ args: [c.input.question] }), { restart: 'rerun' })
  .batch('extract', extractor, c =>
    c.out.queries.data.queries.slice(0, 20).map(query => ({ question: c.input.question, query })),
  )
  .exit('parked', c => gather(c.out.extract).length < 5)
  .step('synthesize', synthesizer, c => ({ question: c.input.question, findings: gather(c.out.extract) }))
  .step('citations', citationCheck, c => ({ stdin: JSON.stringify(c.out.synthesize.citations) }), { restart: 'rerun' })
  .ends(['delivered'], () => 'delivered');

export const topics = H.lane('topics', Topic)
  .supply([
    H.supply.operator(),
    H.supply.schedule(Topic, H.time.weekly('mon', '07:00'), c => {
      const open = new Set<string>();
      const recurring = new Map<string, string>();
      for (const unit of c.units) {
        if (unit.position !== 'terminal') open.add(unit.attributes.slug);
        if (unit.attributes.recurring) recurring.set(unit.attributes.slug, unit.attributes.question);
      }
      return Array.from(recurring.entries())
        .filter(([slug]) => open.has(slug) === false)
        .map(([slug, question]) => ({
          create: { attributes: { slug, question, recurring: true, openedAt: c.now } },
        }));
    }),
  ])
  .store(sqlite.store(Topic, '.harness/topics.db'))
  .handler(researchFlow, { outcomes: { parked: Parked, delivered: Delivered } })
  .runner(local.shell({ slots: 2 }))
  .budget({ maxUsdPerUnit: 3, onExceed: 'halt' })
  .retry(H.retry.fixed({ maxRetries: 1, delayMs: 600000 }))
  .reacts({ cancel: H.reaction(Cancelled).from([Queued, Researching]) });

export const deliveredFindingsRemembered = H.trigger(
  'delivered-findings-remembered',
  H.on.transition(topics, { to: [Delivered] }),
).records(findingsJournal, e =>
  (e.outputs.synthesize === undefined ? [] : e.outputs.synthesize.keyFindings).map(keyFinding => ({
    rule: `When researching a question like "${e.unit.attributes.question}", start from this finding: ${keyFinding}`,
    because: `the report on ${e.unit.attributes.slug} established it with resolving citations`,
    when: { kinds: [Topic] },
  })),
);

const dailyBudgetUsd = 40;
const topicCeilingUsd = 3;

export const withinDailyBudget = H.policy.schedule('within-daily-budget', c => {
  const spent = c.metrics.spentUsd({ sinceMs: c.clock.startOfDay(), lane: topics });
  const succeeded = c.metrics.cost({ kind: Topic, verdict: 'success', window: { days: 30 } });
  const projected = succeeded.n > 0 && succeeded.meanUsd !== null ? succeeded.meanUsd : topicCeilingUsd;
  let remaining = dailyBudgetUsd - spent;
  const start: Candidate[] = [];
  for (const candidate of c.candidates) {
    const fresh = candidate.entry.reason === 'start' || candidate.entry.reason === 'retry';
    if (fresh && candidate.unit.is(topics)) {
      if (projected > remaining) continue;
      remaining -= projected;
    }
    start.push(candidate);
  }
  return { start };
});

export const researcherAccess = H.access('researcher').allows([
  H.ops.readWork,
  H.ops.createWork,
  H.ops.sendEvents,
  H.ops.manageAttempts,
  H.ops.resolveBlocks,
  H.ops.readMemory,
  H.ops.writeMemory,
  H.ops.readTelemetry,
]);

export const supervisor = claudeCode.supervisor('research-supervisor', researcherAccess, { port: H.slot.port(0) });

export const harness = H.harness('research-pipeline')
  .ledger(sqlite.ledger('.harness/research.db'))
  .lanes([topics])
  .triggers([deliveredFindingsRemembered])
  .schedule(withinDailyBudget)
  .projections([markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md')]);

export const control = H.control('research-control', harness).clients([supervisor]);
