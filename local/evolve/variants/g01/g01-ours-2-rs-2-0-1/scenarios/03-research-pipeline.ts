import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Candidate } from 'harness-dsl/kernel';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { pgvector } from 'harness-dsl/pgvector';
import { supply } from 'harness-dsl/supply';
import { policies } from 'harness-dsl/policies';
import { observers } from 'harness-dsl/observers';

const topicSchema = z.object({ slug: z.string(), question: z.string(), tags: z.array(z.string()) });
type Topic = z.infer<typeof topicSchema>;

const sourceList = z.object({ sources: z.array(z.object({ url: z.string(), title: z.string() })) });
const finding = z.object({ claim: z.string(), quote: z.string(), url: z.string() });

const queued = H.state('queued').pending();
const researching = H.state('researching').active();
const delivered = H.state('delivered').terminal('success');
const parked = H.state('parked').terminal('neutral');
const withdrawn = H.state('withdrawn').terminal('neutral');
const unfinished = H.state('unfinished').terminal('failure');

const topic = H.work('Topic').schema(topicSchema).states(queued, researching, delivered, parked, withdrawn, unfinished);

const findings = H.memory('priorFindings').content(z.object({ topic: z.string(), finding: z.string() })).trust('experience');
const sourceLessons = H.memory('sourceLessons')
  .content(z.object({ do: z.string(), when: z.string(), because: z.string() }))
  .trust('experience');

const findingsJournal = H.journal('priorFindings')
  .of(findings)
  .store(pgvector.store({ url: H.env('FINDINGS_DB_URL'), table: 'findings', embeddingModel: 'voyage-3', embeddingKey: H.env('VOYAGE_API_KEY') }))
  .recall(policies.similarity({ limit: 12, minSimilarity: 0.75 }));
const sourceJournal = H.journal('sourceLessons').of(sourceLessons).store(jsonl.store('memory/sources.jsonl')).recall(policies.specificity({ limit: 8 }));

const local = H.runner.local('local', { slots: 4 });
const searchKey = H.env('SEARCH_API_KEY');

const searchSources = H.command('searchSources')
  .input(z.object({ question: z.string() }))
  .output(sourceList)
  .runner(local)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const response = await fetch(`https://search.example.com/v1/search?n=20&q=${encodeURIComponent(input.question)}`, {
      headers: { authorization: `Bearer ${ctx.resolve(searchKey)}` },
    });
    return sourceList.parse(await response.json());
  });

const checkCitations = H.command('checkCitations')
  .input(z.object({ citations: z.array(z.string()) }))
  .runner(local)
  .effect('repeatable')
  .run(async input => {
    for (const url of input.citations) {
      const response = await fetch(url, { method: 'HEAD' });
      if (!response.ok) throw new Error(`citation does not resolve: ${url}`);
    }
  });

const publishReport = H.command('publishReport')
  .input(z.object({ slug: z.string(), report: z.string() }))
  .runner(local)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.sh(`mkdir -p reports && cat > reports/${input.slug}.md`, { stdin: input.report });
    if (result.code !== 0) throw new Error(result.stderr);
  });

const haiku = H.model('claude-haiku-4-5').pricing(anthropic.pricing());
const opus = H.model('claude-opus-4-1').pricing(anthropic.pricing());
const sonnet = H.model('claude-sonnet-4-5').pricing(anthropic.pricing());

const apiAccount = H.account('anthropic-api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') })).quota(sqlite.quota('.harness/quota.db'));
const apiPool = H.pool('api', [apiAccount]).serves(haiku, opus, sonnet);

const citationPassRate = H.metric('citationPassRate').rate(
  H.events.executions(checkCitations, { outcome: 'succeeded' }),
  H.events.executions(checkCitations),
);

const bestCiter = H.policy.seat('bestCiter', ({ candidates, seat, metrics }) => {
  const scored = candidates.map(model => ({ model, reading: metrics.read(citationPassRate, { window: '30d', where: { seat, model } }) }));
  const exploring = scored.filter(s => s.reading.samples < 30);
  if (exploring.length > 0) {
    return [...scored].sort((a, b) => a.reading.samples - b.reading.samples).map(s => s.model);
  }
  return [...scored].sort((a, b) => (b.reading.value ?? 0) - (a.reading.value ?? 0)).map(s => s.model);
});

const extractorRole = H.role('extractor').promptFile('roles/extractor.md').intents(['web']).recall(sourceLessons).record(sourceLessons);
const synthesizerRole = H.role('synthesizer').promptFile('roles/synthesizer.md').recall(findings, sourceLessons).record(findings);

const extractor = H.seat('extractor').role(extractorRole).models(haiku);
const synthesizer = H.seat('synthesizer').role(synthesizerRole).models(opus, sonnet).policy(bestCiter);

const extractSkill = H.skill('extract')
  .input(z.object({ question: z.string(), url: z.string(), title: z.string() }))
  .output(z.object({ findings: z.array(finding) }))
  .prompt(i => `Extract findings relevant to "${i.question}" from ${i.title} (${i.url}).`);

const synthesizeSkill = H.skill('synthesize')
  .input(z.object({ question: z.string(), findings: z.array(finding) }))
  .output(z.object({ report: z.string(), citations: z.array(z.string()) }))
  .prompt(i => `Write a sourced report answering "${i.question}" from:\n${i.findings.map(f => `- ${f.claim} (${f.url})`).join('\n')}`);

const research = H.flow('research')
  .input(topicSchema)
  .step('search', searchSources, s => ({ question: s.input.question }))
  .when(s => s.steps.search.sources.length < 5, thin => thin.exit('parked'))
  .batch('extract', {
    items: s => s.steps.search.sources.slice(0, 20).map(source => ({ question: s.input.question, url: source.url, title: source.title })),
    call: extractor.call(extractSkill),
  })
  .step('synthesize', synthesizer.call(synthesizeSkill), s => ({ question: s.input.question, findings: s.steps.extract.flatMap(e => e.findings) }))
  .step('checkCitations', checkCitations, s => ({ citations: s.steps.synthesize.citations }))
  .step('publish', publishReport, s => ({ slug: s.input.slug, report: s.steps.synthesize.report }))
  .exit('delivered');

const weeklyRecurring = supply.schedule<Topic>({
  cron: '0 6 * * 1',
  units: (_now, _ctx, known) => known.filter(unit => unit.data.tags.includes('recurring')).map(unit => unit.data),
}).key(t => t.slug);

const topics = H.lane('topics')
  .of(topic)
  .from(supply.manual(), weeklyRecurring)
  .store(sqlite.store('.harness/topics.db'))
  .handle(research)
  .exits({ parked, delivered, failed: { tries: 2, backoff: 'exponential', delaySeconds: 600, then: unfinished } })
  .ceiling({ maxUsd: 3, onExceed: 'fail' });

const meanSucceededCost = H.metric('meanSucceededCost').mean(H.events.attempts({ outcome: 'succeeded' }), 'costUsd');
const spend = H.metric('spend').sum(H.events.attempts(), 'costUsd');

const dailyBudget = H.policy.schedule('dailyBudget', ({ candidates, running, metrics, now }) => {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const spent = metrics.read(spend, { window: { since: midnight } }).value ?? 0;
  const projected = metrics.read(meanSucceededCost, { window: '30d', where: { kind: topic } }).value ?? 3;
  let remaining = 40 - spent - running.length * projected;
  const chosen: Candidate[] = [];
  for (const candidate of [...candidates].sort((a, b) => b.waitingSeconds - a.waitingSeconds)) {
    if (projected > remaining) break;
    chosen.push(candidate);
    remaining -= projected;
  }
  return chosen;
});

const operator = claudeCode.client('operator');

export const harness = H.harness('research')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .pools(apiPool)
  .lanes(topics)
  .journals(findingsJournal, sourceJournal)
  .scheduler(H.scheduler().policy(dailyBudget))
  .grants(H.grant(operator, H.ops.work.read, H.ops.work.write, H.ops.telemetry.read, H.ops.memory.curate(sourceJournal)))
  .metrics(citationPassRate, meanSucceededCost, spend)
  .observe(observers.board({ path: 'BOARD.md' }), observers.telemetry({ path: 'TELEMETRY.md' }));

export const running = harness.start();
