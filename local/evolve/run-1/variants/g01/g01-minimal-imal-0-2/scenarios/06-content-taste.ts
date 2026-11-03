import { z } from 'zod';
import { H } from 'harness-dsl';
import type { EntryFilter, Metrics, Model, Rate, SupplyOf } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as http from 'harness-dsl/http';
import * as jsonl from 'harness-dsl/jsonl';
import * as sqlite from 'harness-dsl/sqlite';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const submitted = H.state('submitted', 'pending');
const reviewing = H.state('reviewing', 'active');
const returned = H.state('returned', 'waiting');
const accepted = H.state('accepted', 'terminal', 'success');
const withdrawn = H.state('withdrawn', 'terminal', 'neutral');

const Draft = H.kind('Draft')
  .data(z.object({
    id: z.string(),
    title: z.string(),
    section: z.string(),
    body: z.string(),
    notes: z.string().optional(),
  }))
  .states(submitted, reviewing, returned, accepted, withdrawn);

const cmsHeaders = { 'X-Api-Key': H.env('CMS_TOKEN') };

const cmsDraft = z.object({
  id: z.string(),
  title: z.string(),
  section: z.string(),
  body: z.string(),
  status: z.enum(['submitted', 'revised', 'withdrawn']),
});
type CmsDraft = z.infer<typeof cmsDraft>;

function toSupply(draft: CmsDraft): SupplyOf<typeof Draft> {
  if (draft.status === 'submitted') {
    return { create: { id: draft.id, title: draft.title, section: draft.section, body: draft.body }, key: draft.id };
  }
  if (draft.status === 'revised') {
    return { update: draft.id, patch: { body: draft.body, notes: undefined }, state: 'submitted' };
  }
  return { update: draft.id, state: 'withdrawn' };
}

const cmsDrafts = http.poll(Draft, {
  url: 'https://cms.example.com/api/drafts?status=submitted,revised,withdrawn',
  every: { minutes: 10 },
  headers: cmsHeaders,
  body: z.object({ drafts: z.array(cmsDraft) }),
  read: body => body.drafts.map(toSupply),
});

const cmsStore = http.store(Draft, {
  url: 'https://cms.example.com/api/drafts',
  headers: cmsHeaders,
  stateField: 'reviewStatus',
});

const editorialTaste = H.memory('editorial-taste', 'taste');
const factLessons = H.memory('fact-check-lessons', 'experience');
const tasteLibrary = H.library('editor-taste', editorialTaste, jsonl.memory('memory/taste.jsonl'));
const factLibrary = H.library('fact-check', factLessons, jsonl.memory('memory/fact-check.jsonl'));

const critique = H.role('critique')
  .input(z.object({ title: z.string(), section: z.string(), body: z.string() }))
  .output(z.object({ critique: z.string() }))
  .prompt(d => `Critique the ${d.section} draft "${d.title}" against the house taste and the fact-checking lessons.\n\n${d.body}`);

const firstIncumbent = anthropic.model('claude-opus-4-1');
const secondIncumbent = anthropic.model('claude-sonnet-4-5');
const challenger = anthropic.model('claude-haiku-4-5');
const swapAfterSamples = 50;

const editorResolutions: EntryFilter = { entry: 'halt', halt: 'editor', status: 'resolved' };
const noSamples: Rate = { value: null, hits: 0, samples: 0 };

function combine(x: Rate, y: Rate): Rate {
  const hits = x.hits + y.hits;
  const samples = x.samples + y.samples;
  return { value: samples === 0 ? null : hits / samples, hits, samples };
}

function actedOn(metrics: Metrics, model: Model): Rate {
  const asFirst = metrics.rateBy({
    among: editorResolutions,
    count: { ...editorResolutions, decision: { actedOnA: true } },
    byTag: 'modelA',
  });
  const asSecond = metrics.rateBy({
    among: editorResolutions,
    count: { ...editorResolutions, decision: { actedOnB: true } },
    byTag: 'modelB',
  });
  return combine(asFirst[model.name] ?? noSamples, asSecond[model.name] ?? noSamples);
}

function lineup(metrics: Metrics): readonly [Model, Model] {
  const a = actedOn(metrics, firstIncumbent);
  const b = actedOn(metrics, secondIncumbent);
  if (a.value === null || b.value === null || a.samples < swapAfterSamples || b.samples < swapAfterSamples) {
    return [firstIncumbent, secondIncumbent];
  }
  return a.value >= b.value ? [firstIncumbent, challenger] : [challenger, secondIncumbent];
}

const reviewerLineup = H.policy.model('reviewer-lineup', choice => {
  const [first, second] = lineup(choice.metrics);
  return choice.agent === 'reviewer-a' ? first : second;
});

const reviewerA = H.agent('reviewer-a', critique).model(reviewerLineup).recalls(tasteLibrary, factLibrary);
const reviewerB = H.agent('reviewer-b', critique).model(reviewerLineup).recalls(tasteLibrary, factLibrary);

const tools = shell.local('editorial-tools', { slots: 2 });

const mergeCritiques = H.command('merge-critiques')
  .input(z.object({ a: z.string(), b: z.string() }))
  .argv(c => ['critique-merge', '--first', c.a, '--second', c.b])
  .on(tools)
  .recovery('rerun');

const factCheck = H.command('fact-check')
  .input(z.object({ draft: z.string() }))
  .output(z.object({ repeatMistakes: z.array(z.object({ lesson: z.string(), because: z.string() })) }))
  .argv(i => ['fact-check', '--draft', i.draft, '--json'])
  .on(tools)
  .recovery('rerun');

const editorDecision = z.object({
  verdict: z.enum(['accept', 'return']),
  notes: z.string(),
  actedOnA: z.boolean(),
  actedOnB: z.boolean(),
});

const draftReview = H.flow('draft-review').for(Draft).does(async ctx => {
  const draft = ctx.unit.data;
  const input = { title: draft.title, section: draft.section, body: draft.body };
  const scope = { resources: [`section:${draft.section}`] };
  const a = await ctx.run(reviewerA, input, { scope });
  const b = await ctx.run(reviewerB, input, { scope });
  if (!a.ok || !b.ok) return ctx.fail('a reviewer produced no critique');
  ctx.tag({ modelA: a.model ?? 'unknown', modelB: b.model ?? 'unknown' });

  const facts = await ctx.run(factCheck, { draft: draft.id });
  if (facts.ok) {
    for (const mistake of facts.value.repeatMistakes) {
      await ctx.remember(factLibrary, {
        text: mistake.lesson,
        because: mistake.because,
        when: { kinds: [Draft.name], roles: [critique.name] },
      });
    }
  }

  const merged = await ctx.run(mergeCritiques, { a: a.value.critique, b: b.value.critique });
  if (!merged.ok) return ctx.fail(merged.error);

  const decision = await ctx.halt({ name: 'editor', show: merged.value, decision: editorDecision });
  if (decision.verdict === 'accept') return 'accepted';
  await ctx.update({ notes: decision.notes });
  return 'returned';
});

const notesBecomeTaste = H.trigger('returned-notes-become-taste', H.on.enters(Draft, 'returned'), (event, act) =>
  event.unit.data.notes
    ? act.remember(tasteLibrary, {
        text: event.unit.data.notes,
        when: { kinds: [Draft.name], roles: [critique.name] },
        status: 'candidate',
      })
    : []);

const editor = claudeCode.supervisor({
  grants: [
    H.ops.readWork,
    H.ops.resolveHalts,
    H.ops.readMemory,
    H.ops.writeMemory,
    H.ops.curateMemory,
    H.ops.readTelemetry,
  ],
});

const editorialApi = H.pool('editorial-api', [
  { account: anthropic.account('editorial', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 },
]);

const drafts = H.lane('drafts', Draft).handler(draftReview).suppliers(cmsDrafts).store(cmsStore).wip(3);

const longestWaitingFirst = H.policy.scheduler('longest-waiting-first', view => ({
  start: [...view.pending].sort((x, y) => y.waitedMs - x.waitedMs),
}));

export const running = H.harness('content-review')
  .ledger(sqlite.ledger('review/ledger.db'))
  .lanes(drafts)
  .pools(editorialApi)
  .triggers(notesBecomeTaste)
  .scheduler(longestWaitingFirst)
  .clients(editor)
  .observers(markdown.board('review/BOARD.md'), markdown.telemetry('review/TELEMETRY.md'))
  .start();
