import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Rate } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as qdrant from 'harness-dsl/qdrant';
import * as shell from 'harness-dsl/shell';
import * as claudeCode from 'harness-dsl/claude-code';
import * as markdown from 'harness-dsl/markdown';

const Topic = H.kind('Topic')
  .data(z.object({ question: z.string(), tags: z.array(z.string()), report: z.string().optional() }))
  .states({
    queued: 'pending',
    researching: 'active',
    delivered: 'success',
    parked: 'neutral',
    cancelled: 'neutral',
  }, 'queued');

const findings = H.memory('prior-finding', 'fallible').data(z.object({ topic: z.string(), source: z.string() }));
const sourceExperience = H.memory('source-experience', 'fallible');

const similarFindings = H.policy.recall('similar-findings', view =>
  view.items
    .filter(item => (item.similarity ?? 0) >= 0.75)
    .sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0) || b.specificity - a.specificity)
    .slice(0, 8)
);
const mostSpecific = H.policy.recall('most-specific', view =>
  [...view.items].sort((a, b) => b.specificity - a.specificity).slice(0, 10)
);

const findingsLibrary = H.library(
  'prior-findings',
  findings,
  qdrant.memory({
    url: 'https://vectors.example.com',
    collection: 'research-findings',
    embedder: 'text-embedding-3-small',
    apiKey: H.env('QDRANT_API_KEY'),
  })
).recall(similarFindings);

const sourceLibrary = H.library('source-experience', sourceExperience, jsonl.memory('memory/sources.jsonl')).recall(mostSpecific);

const quota = sqlite.quota('.harness/quota.sqlite');
const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });
const apiPool = H.pool(
  'api',
  [{ account: apiAccount, share: 1 }],
  H.policy.account('first-eligible', choice => choice.accounts.find(view => view.eligible)?.account ?? null)
);

const cheapModel = anthropic.model('claude-haiku-4-5');
const strongA = anthropic.model('claude-opus-4-1');
const strongB = anthropic.model('claude-sonnet-4-5');

const noSamples: Rate = { value: null, hits: 0, samples: 0 };

const citationPassRate = H.policy.model('citation-pass-rate', choice => {
  const rates = choice.metrics.rateBy({
    among: { entry: 'invocation', executable: 'citation-check', status: 'finished' },
    count: { entry: 'invocation', executable: 'citation-check', status: 'finished', ok: true },
    by: { tag: 'synthesizer' },
    days: 60,
  });
  const a = rates[strongA.name] ?? noSamples;
  const b = rates[strongB.name] ?? noSamples;
  if (a.samples < 30 || b.samples < 30) return a.samples <= b.samples ? strongA : strongB;
  return (a.value ?? 0) >= (b.value ?? 0) ? strongA : strongB;
});

const searcherRole = H.role('searcher')
  .input(z.object({ question: z.string(), angle: z.number().int() }))
  .output(z.object({ findings: z.array(z.object({ claim: z.string(), source: z.string() })) }))
  .prompt(input => `Search angle ${input.angle} of 20 for: ${input.question}\nExtract claims with their source URLs.`)
  .intents(['browse']);

const synthesizerRole = H.role('synthesizer')
  .input(z.object({ question: z.string(), findings: z.array(z.object({ claim: z.string(), source: z.string() })) }))
  .output(z.object({ report: z.string(), citations: z.array(z.string()), keyFindings: z.array(z.string()) }))
  .prompt(input => `Write a sourced report answering: ${input.question}\n\nFindings:\n${input.findings.map(f => `- ${f.claim} (${f.source})`).join('\n')}`);

const searcher = H.agent('searcher', searcherRole).model(cheapModel);
const synthesizer = H.agent('synthesizer', synthesizerRole)
  .model(citationPassRate)
  .recalls(findingsLibrary, sourceLibrary)
  .records(sourceLibrary);

const local = shell.local('local', { slots: 2 });

const citationCheck = H.command('citation-check')
  .input(z.object({ citations: z.array(z.string()) }))
  .argv(input => ['cite-check', '--resolve', ...input.citations])
  .on(local)
  .restart('rerun');

const minimumSources = 5;

const research = H.flow('research')
  .for(Topic)
  .does(async ctx => {
    await ctx.move('researching');
    const question = ctx.unit.data.question;
    const searches = await ctx.batch(
      searcher,
      Array.from({ length: 20 }, (_, index) => ({ question, angle: index + 1 }))
    );
    const gathered = searches.flatMap(result => (result.ok ? result.value.findings : []));
    const sources = new Set(gathered.map(finding => finding.source));
    if (sources.size < minimumSources) return 'parked';

    const synthesis = await ctx.run(synthesizer, { question, findings: gathered });
    if (synthesis.ok === false) return ctx.fail(synthesis.error);
    ctx.tag({ synthesizer: synthesis.model ?? 'unknown' });

    const checked = await ctx.run(citationCheck, { citations: synthesis.value.citations });
    if (checked.ok === false) return ctx.fail(`citation-unresolved: ${checked.error}`);

    await ctx.update({ report: synthesis.value.report });
    for (const finding of synthesis.value.keyFindings) {
      await ctx.remember(findingsLibrary, {
        text: `When researching questions like "${question}", start from: ${finding}`,
        because: 'it survived the citation check in a delivered report',
        when: { kinds: [Topic], roles: [synthesizerRole] },
        data: { topic: ctx.unit.key, source: synthesis.value.citations.join(' ') },
      });
    }
    return 'delivered';
  });

const reopenRecurring = H.recurring('weekly-recurring-topics', Topic, { weekly: { day: 'mon', at: '06:00' } }, tick =>
  tick.units
    .filter(unit => unit.position === 'terminal' && unit.data.tags.includes('recurring'))
    .map(unit => ({ update: unit.key, state: 'queued' }))
);

const retryLater = H.policy.retry('retry-twice-hourly', view =>
  view.failures >= 3 ? 'stop' : { retryInMs: 60 * 60 * 1000 }
);

const topicCeilingUsd = 3;
const dailyBudgetUsd = 40;

const topics = H.lane('topics', Topic)
  .handler(research)
  .suppliers(H.operator, reopenRecurring)
  .store(sqlite.store(Topic, '.harness/topics.sqlite'))
  .maxUsdPerUnit(topicCeilingUsd)
  .retry(retryLater);

const withinDailyBudget = H.policy.scheduler('daily-budget', view => {
  const dayStart = new Date(Date.UTC(view.now.getUTCFullYear(), view.now.getUTCMonth(), view.now.getUTCDate()));
  const spent = view.metrics.sum({ of: 'costUsd', among: { entry: 'invocation', kind: Topic.name }, since: dayStart }).value ?? 0;
  const mean = view.metrics.mean({ of: 'costUsd', among: { entry: 'attempt', kind: Topic.name, outcome: 'succeeded' }, days: 30 });
  const projected = mean.samples >= 5 && typeof mean.value === 'number' ? mean.value : topicCeilingUsd;
  let reserved = spent + projected * view.active.length;
  const start = [];
  for (const unit of [...view.pending].sort((a, b) => b.waitedMs - a.waitedMs)) {
    if (reserved + projected > dailyBudgetUsd) break;
    start.push(unit);
    reserved += projected;
  }
  return { start };
});

const supervisor = claudeCode.supervisor({
  grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.readMemory, H.ops.writeMemory, H.ops.readTelemetry],
});

export default H.harness('research-pipeline')
  .ledger(sqlite.ledger('.harness/ledger.sqlite'))
  .lanes(topics)
  .pools(apiPool)
  .scheduler(withinDailyBudget)
  .clients(supervisor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
