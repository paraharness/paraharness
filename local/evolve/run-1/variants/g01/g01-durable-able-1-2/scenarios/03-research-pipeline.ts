import { H } from 'harness-dsl';
import { z } from 'zod';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as lancedb from 'harness-dsl/lancedb';
import * as local from 'harness-dsl/local';
import * as claudeCode from 'harness-dsl/claude-code';
import * as markdown from 'harness-dsl/markdown';

const dailyBudgetUsd = 40;

const Queued = H.state('Queued', 'pending');
const Researching = H.state('Researching', 'active');
const Delivered = H.state('Delivered', 'terminal', 'success');
const Parked = H.state('Parked', 'terminal', 'neutral');
const Cancelled = H.state('Cancelled', 'terminal', 'neutral');
const Unresolved = H.state('Unresolved', 'terminal', 'failure');

const Topic = H.work('Topic')
  .attributes({ slug: z.string(), question: z.string(), recurring: z.boolean(), openedAt: z.number() })
  .states([Queued, Researching, Delivered, Parked, Cancelled, Unresolved])
  .events({ cancel: { reason: z.string() } })
  .key((u) => `${u.attributes.slug}@${u.attributes.openedAt}`);

const findings = H.memory.experience('prior-findings');
const sourceLessons = H.memory.experience('source-lessons');

const mostSimilar = H.policy.recall('most-similar', (c) =>
  [...c.candidates]
    .filter((x) => (x.similarity ?? 0) >= 0.75)
    .sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0) || b.specificity - a.specificity)
    .slice(0, c.limit),
);
const specificFirst = H.policy.recall('specific-first', (c) =>
  [...c.candidates].sort((a, b) => b.specificity - a.specificity).slice(0, c.limit),
);

const findingsJournal = H.journal('findings-journal', findings)
  .store(lancedb.memory('memory/findings.lance', { embedding: 'voyage-3', table: 'findings' }))
  .recall(mostSimilar);
const sourcesJournal = H.journal('sources-journal', sourceLessons)
  .store(jsonl.memory('memory/sources.jsonl'))
  .recall(specificFirst);

const apiAccount = anthropic.account('research-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const haikuBatch = anthropic.model('claude-haiku-4-5', { batch: true });
const opus = anthropic.model('claude-opus-4-1');
const sonnet = anthropic.model('claude-sonnet-4-5');

const search = H.command('search-sources', ['./bin/search'])
  .parses({ sources: z.array(z.object({ url: z.string(), title: z.string() })) });
const citationCheck = H.command('citation-check', ['./bin/check-citations']);
const publish = H.command('publish-report', ['./bin/publish-report']);

const citationsResolve = H.metric('citations-resolve').of(citationCheck).hit((o) => o.exitCode === 0);

const synthesizerModel = H.policy.model('synthesizer-model', [opus, sonnet], (c) => {
  const first = c.metrics.read(citationsResolve, { model: opus, kind: Topic, window: { days: 30 } });
  const second = c.metrics.read(citationsResolve, { model: sonnet, kind: Topic, window: { days: 30 } });
  if (first.n < 15 || second.n < 15) return first.n <= second.n ? opus : sonnet;
  return (second.rate ?? 0) > (first.rate ?? 0) ? sonnet : opus;
});

const extractorRole = H.role('extractor')
  .intents(['browse', 'read'])
  .instructions('Read the source and extract the claims relevant to the question.')
  .input({ question: z.string(), url: z.string(), title: z.string() })
  .output({ url: z.string(), relevant: z.boolean(), claims: z.array(z.string()) });

const synthesizerRole = H.role('synthesizer')
  .intents(['read', 'remember'])
  .instructions('Write a sourced report. Every claim cites a source URL.')
  .input({ question: z.string(), findings: z.array(z.object({ url: z.string(), claims: z.array(z.string()) })) })
  .output({ report: z.string(), keyFindings: z.array(z.string()), citations: z.array(z.string()) });

const extractor = H.agent('extractor', extractorRole).model(haikuBatch).pool(apiAccount).recalls([sourcesJournal]);
const synthesizer = H.agent('synthesizer', synthesizerRole)
  .model(synthesizerModel)
  .pool(apiAccount)
  .recalls([findingsJournal, sourcesJournal])
  .records(sourcesJournal);

const researchFlow = H.flow('research-topic')
  .requires({ slug: z.string(), question: z.string() })
  .mark('researching')
  .step('search', search, (c) => ({ args: [c.input.question] }), { restart: 'rerun' })
  .batch('extract', extractor, (c) =>
    c.out.search.data.sources.slice(0, 20).map((s) => ({ question: c.input.question, url: s.url, title: s.title })),
  )
  .exit('parked', (c) => c.out.extract.filter((e) => e.relevant).length < 5)
  .step('synthesize', synthesizer, (c) => ({
    question: c.input.question,
    findings: c.out.extract.filter((e) => e.relevant).map((e) => ({ url: e.url, claims: e.claims })),
  }))
  .step('citations', citationCheck, (c) => ({ stdin: JSON.stringify(c.out.synthesize.citations) }), { restart: 'rerun' })
  .step('publish', publish, (c) => ({ args: [c.input.slug], stdin: c.out.synthesize.report }), { restart: 'rerun' })
  .ends(['delivered'], () => 'delivered');

const topicLane = H.lane('topics', Topic)
  .supply([
    H.supply.operator(),
    H.supply.schedule(Topic, H.time.weekly('mon', '06:00', 'Europe/London'), (c) =>
      c.units
        .filter((u) => u.attributes.recurring && u.position === 'terminal')
        .map((u) => ({
          create: { attributes: { slug: u.attributes.slug, question: u.attributes.question, recurring: true, openedAt: c.now } },
        })),
    ),
  ])
  .store(sqlite.store(Topic, 'state/topics.sqlite'))
  .runner(local.shell({ slots: 4 }))
  .handler(researchFlow, {
    states: { researching: Researching, parked: Parked, delivered: Delivered, failed: Unresolved },
  })
  .budget({ maxUsdPerUnit: 3, onExceed: 'fail' })
  .reacts({ cancel: H.reaction(Cancelled).from([Queued, Researching]) });

const deliveredFindingsRemembered = H.trigger('delivered-findings-remembered', H.on.transition(topicLane, { to: [Delivered] }))
  .records(findingsJournal, (e) =>
    (e.outputs.synthesize?.keyFindings ?? []).map((finding) => ({
      rule: `When researching "${e.unit.attributes.question}", start from this finding: ${finding}`,
      because: `report ${e.unit.key} established it with citations that resolved`,
      when: { kinds: [Topic] },
    })),
  );

const withinDailyBudget = H.policy.schedule('within-daily-budget', (c) => {
  const projected = c.metrics.cost({ kind: Topic, verdict: 'success', window: { days: 30 } }).meanUsd ?? 3;
  const spent = c.metrics.spentUsd({ sinceMs: c.clock.startOfDay('Europe/London') });
  const committed = c.open
    .filter((a) => c.inLane(a, topicLane))
    .reduce((sum, a) => sum + Math.max(0, projected - a.costUsd), 0);
  let remaining = dailyBudgetUsd - spent - committed;
  return {
    start: [...c.candidates]
      .sort((a, b) => a.entry.enqueuedAt - b.entry.enqueuedAt)
      .filter(() => {
        if (projected > remaining) return false;
        remaining -= projected;
        return true;
      }),
  };
});

const operatorAccess = H.access('operator').allows([
  H.ops.readWork,
  H.ops.createWork,
  H.ops.sendEvents,
  H.ops.manageAttempts,
  H.ops.readMemory,
  H.ops.writeMemory,
  H.ops.readTelemetry,
]);

export const harness = H.harness('research-pipeline')
  .ledger(sqlite.ledger('state/ledger.sqlite'))
  .lanes([topicLane])
  .triggers([deliveredFindingsRemembered])
  .schedule(withinDailyBudget)
  .clients([claudeCode.supervisor('operator', operatorAccess, { port: H.slot.port(0) })])
  .projections([markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md')]);
