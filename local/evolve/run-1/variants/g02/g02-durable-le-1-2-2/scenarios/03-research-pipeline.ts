import { z } from 'zod';
import { H } from 'harness-dsl';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as lancedb from 'harness-dsl/lancedb';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as local from 'harness-dsl/local';
import * as markdown from 'harness-dsl/markdown';

const Open = H.state('Open', 'pending');
const Researching = H.state('Researching', 'active');
const Delivered = H.state('Delivered', 'terminal', 'success');
const Parked = H.state('Parked', 'terminal', 'neutral');
const Withdrawn = H.state('Withdrawn', 'terminal', 'neutral');

const Topic = H.work('Topic')
  .attributes({ slug: z.string(), question: z.string(), recurring: z.boolean(), opened: z.number() })
  .states([Open, Researching, Delivered, Parked, Withdrawn])
  .events({ withdrawn: { reason: z.string() } })
  .key(u => `${u.attributes.slug}@${u.attributes.opened}`);

const findings = H.memory.experience('prior-findings');
const sourceLessons = H.memory.experience('source-lessons');

const mostSimilarFirst = H.policy.recall('most-similar-first', c =>
  [...c.candidates]
    .sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0) || b.specificity - a.specificity)
    .slice(0, c.limit));
const mostSpecificFirst = H.policy.recall('most-specific-first', c =>
  [...c.candidates].sort((a, b) => b.specificity - a.specificity).slice(0, c.limit));

const findingsJournal = H.journal('prior-findings', findings)
  .store(lancedb.memory('memory/findings', { embedding: 'voyage-3', table: 'findings' }))
  .recall(mostSimilarFirst);
const sourceJournal = H.journal('source-lessons', sourceLessons)
  .store(jsonl.memory('memory/sources.jsonl'))
  .recall(mostSpecificFirst);

const apiAccount = anthropic.account('research-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const batchCheap = anthropic.model('claude-haiku-4-5', { batch: true });
const opus = anthropic.model('claude-opus-4-1');
const sonnet = anthropic.model('claude-sonnet-4-5');

const checkCitations = H.command('check-citations', ['./scripts/check-citations']);
const citationPass = H.metric('citation-pass').of(checkCitations).hit(result => result.exitCode === 0);

const synthesizerModel = H.policy.model('best-citation-pass-rate', [opus, sonnet], (c, options) => {
  const scored = options.map(model => ({
    model,
    pass: c.metrics.read(citationPass, { kind: Topic, model, window: { days: 30 } }),
  }));
  const underSampled = scored.find(entry => entry.pass.n < 15);
  if (underSampled) return underSampled.model;
  return scored.reduce((best, entry) => (entry.pass.rate ?? 0) > (best.pass.rate ?? 0) ? entry : best).model;
});

const searcherRole = H.role('searcher')
  .intents(['search', 'read'])
  .instructions('Search for sources on one angle of the question and extract sourced claims.')
  .input({ question: z.string(), angle: z.number() })
  .output({ findings: z.array(z.object({ claim: z.string(), source: z.string() })) });

const synthesizerRole = H.role('synthesizer')
  .intents(['read', 'remember'])
  .instructions('Write a sourced report. Every claim cites a source from the findings.')
  .input({ question: z.string(), findings: z.array(z.object({ claim: z.string(), source: z.string() })) })
  .output({ report: z.string(), citations: z.array(z.string()), keyFindings: z.array(z.string()) });

const searcher = H.agent('searcher', searcherRole).model(batchCheap).pool(apiAccount).recalls([sourceJournal]);
const synthesizer = H.agent('synthesizer', synthesizerRole)
  .model(synthesizerModel)
  .pool(apiAccount)
  .recalls([findingsJournal, sourceJournal])
  .records(sourceJournal);

const research = H.flow('research')
  .requires({ question: z.string() })
  .batch('extract', searcher, c => Array.from({ length: 20 }, (_, angle) => ({ question: c.input.question, angle })))
  .exit('notEnoughSources', c => c.out.extract.reduce((count, result) => count + result.findings.length, 0) < 5)
  .step('synthesize', synthesizer, c => ({
    question: c.input.question,
    findings: c.out.extract.flatMap(result => result.findings),
  }))
  .step('citations', checkCitations, c => ({ stdin: c.out.synthesize.citations.join('\n') }))
  .ends(['delivered'], () => 'delivered');

const topicLane = H.lane('topics', Topic)
  .supply([
    H.supply.operator(),
    H.supply.schedule(Topic, H.time.weekly('mon', '06:00'), (c, to) => {
      const openSlugs = new Set(c.units.filter(u => u.position !== 'terminal').map(u => u.attributes.slug));
      const recurring = new Map<string, string>();
      for (const u of c.units) {
        if (u.attributes.recurring && !openSlugs.has(u.attributes.slug)) recurring.set(u.attributes.slug, u.attributes.question);
      }
      return Array.from(recurring, ([slug, question]) =>
        to.create({ attributes: { slug, question, recurring: true, opened: c.now } }));
    }),
  ])
  .store(sqlite.store(Topic, '.harness/topics.db'))
  .runner(local.shell({ slots: 4 }))
  .retry(H.retry.fixed({ maxRetries: 1, delayMs: 600000 }))
  .budget({ maxUsdPerUnit: 3, onExceed: 'halt' })
  .reacts({ withdrawn: H.reaction(Withdrawn).from([Open, Researching]).cancels() })
  .handler(research, { ends: { delivered: Delivered, notEnoughSources: Parked } });

const deliveredFindingsRemembered = H.trigger('delivered-findings-remembered', H.on.transition(topicLane, { to: [Delivered] }))
  .records(findingsJournal, e => (e.outputs.synthesize?.keyFindings ?? []).map(finding => ({
    rule: `when researching "${e.unit.attributes.question}", start from: ${finding}`,
    because: `report ${e.unit.key} established it and its citations resolved`,
    when: { kinds: [Topic] },
  })));

const withinDailyBudget = H.policy.schedule('within-daily-budget', c => {
  const projectedUsd = c.metrics.cost({ kind: Topic, verdict: 'success', window: { days: 30 } }).meanUsd ?? 3;
  const remainingUsd = 40 - c.metrics.spentUsd({ sinceMs: c.clock.startOfDay() }) - c.open.length * projectedUsd;
  const affordable = Math.max(0, Math.floor(remainingUsd / projectedUsd));
  return { start: [...c.candidates].sort((a, b) => b.waitedMs - a.waitedMs).slice(0, affordable) };
});

const operatorAccess = H.access('research-operator')
  .allows([H.ops.readWork, H.ops.createWork, H.ops.sendEvents, H.ops.resolveBlocks, H.ops.readMemory, H.ops.readTelemetry]);

export const harness = H.harness('research-pipeline')
  .ledger(sqlite.ledger('.harness/research.db'))
  .lanes([topicLane])
  .triggers([deliveredFindingsRemembered])
  .schedule(withinDailyBudget)
  .clients([claudeCode.supervisor('operator', operatorAccess, { port: H.slot.port(0) })])
  .projections([markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md')]);
